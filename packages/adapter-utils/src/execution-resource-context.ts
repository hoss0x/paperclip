import { AsyncLocalStorage } from "node:async_hooks";
import { ExecutionResourceAdmission, resolveExecutionResourcePolicy, type ExecutionResourcePolicy } from "./execution-resource-policy.js";
import { ensureSystemdExecutionSlice } from "./systemd-execution-slice.js";
import type { ExecutionResourceEvidence } from "./systemd-execution.js";
import { listActiveExecutionUnits, reconcileExecutionAdmission } from "./execution-resource-reconciliation.js";

export interface ExecutionResourceContext {
  policy: ExecutionResourcePolicy;
  admission: ExecutionResourceAdmission;
  /** Root leases within an already-reserved, bounded run envelope. */
  rootAdmission?: Pick<ExecutionResourceAdmission, "acquire">;
  scratchDir: string;
  slice?: string;
  signal?: AbortSignal;
  /** Operator-owned packaged runner used for descriptor-preserving handoffs. */
  nativeLoaderCommand?: () => string;
  onUnitPrepared?: (unit: { unit: string; memoryMaxBytes: number }) => Promise<void>;
  onEvidence?: (evidence: ExecutionResourceEvidence) => Promise<void>;
}

const contexts = new AsyncLocalStorage<ExecutionResourceContext>();
let operatorAdmission: { key: string; initialized: Promise<{ admission: ExecutionResourceAdmission; slice?: string }> } | undefined;

export function currentExecutionResources(): ExecutionResourceContext | undefined {
  return contexts.getStore();
}

/** Also used by isolated integration tests, without changing operator state. */
export function withExecutionResourceContext<T>(context: ExecutionResourceContext, execute: () => Promise<T>): Promise<T> {
  return contexts.run(context, execute);
}

/** Resolve only the control-plane environment, never adapter configuration. */
export async function withOperatorExecutionResources<T>(input: {
  scratchDir: string;
  slice?: string;
  signal?: AbortSignal;
  nativeLoaderCommand?: () => string;
  onEvidence?: ExecutionResourceContext["onEvidence"];
  onUnitPrepared?: ExecutionResourceContext["onUnitPrepared"];
}, execute: () => Promise<T>): Promise<T> {
  const policy = resolveExecutionResourcePolicy();
  const key = JSON.stringify([policy, input.slice]);
  if (operatorAdmission && operatorAdmission.key !== key) {
    throw new Error("Execution resource policy changed; restart the control plane to apply it safely");
  }
  operatorAdmission ??= { key, initialized: (async () => {
    const admission = new ExecutionResourceAdmission(policy.capacityBytes, policy.maxConcurrent);
    const slice = policy.isolation === "systemd" ? await ensureSystemdExecutionSlice(policy, input.slice) : undefined;
    if (slice) await reconcileExecutionAdmission({ admission, list: () => listActiveExecutionUnits(slice) });
    return { admission, slice };
  })() };
  const initialized = await operatorAdmission.initialized;
  return withExecutionResourceContext({ ...input, policy, ...initialized }, execute);
}
