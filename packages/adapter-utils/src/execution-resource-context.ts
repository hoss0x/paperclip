import { AsyncLocalStorage } from "node:async_hooks";
import { ExecutionResourceAdmission, resolveExecutionResourcePolicy, type ExecutionResourcePolicy } from "./execution-resource-policy.js";
import type { ExecutionResourceEvidence } from "./systemd-execution.js";

export interface ExecutionResourceContext {
  policy: ExecutionResourcePolicy;
  admission: ExecutionResourceAdmission;
  scratchDir: string;
  signal?: AbortSignal;
  onEvidence?: (evidence: ExecutionResourceEvidence) => Promise<void>;
}

const contexts = new AsyncLocalStorage<ExecutionResourceContext>();
let operatorAdmission: { key: string; admission: ExecutionResourceAdmission } | undefined;

export function currentExecutionResources(): ExecutionResourceContext | undefined {
  return contexts.getStore();
}

/** Also used by isolated integration tests, without changing operator state. */
export function withExecutionResourceContext<T>(context: ExecutionResourceContext, execute: () => Promise<T>): Promise<T> {
  return contexts.run(context, execute);
}

/** Resolve only the control-plane environment, never adapter configuration. */
export function withOperatorExecutionResources<T>(input: {
  scratchDir: string;
  signal?: AbortSignal;
  onEvidence?: ExecutionResourceContext["onEvidence"];
}, execute: () => Promise<T>): Promise<T> {
  const policy = resolveExecutionResourcePolicy();
  const key = JSON.stringify(policy);
  if (operatorAdmission && operatorAdmission.key !== key) {
    throw new Error("Execution resource policy changed; restart the control plane to apply it safely");
  }
  operatorAdmission ??= { key, admission: new ExecutionResourceAdmission(policy.capacityBytes, policy.maxConcurrent) };
  return withExecutionResourceContext({ ...input, policy, admission: operatorAdmission.admission }, execute);
}
