import { AsyncLocalStorage } from "node:async_hooks";
import { ExecutionResourceAdmission, resolveExecutionResourcePolicy, type ExecutionResourcePolicy } from "./execution-resource-policy.js";
import { ensureSystemdExecutionSlice } from "./systemd-execution-slice.js";
import type { ExecutionResourceEvidence } from "./systemd-execution.js";
import { listActiveExecutionUnits, reconcileExecutionAdmission } from "./execution-resource-reconciliation.js";

export interface ExecutionResourceContext {
  /** Controller-owned run identity for helper ownership and restart cleanup. */
  runId?: string;
  admissionKind?: "agent" | "helper";
  /** Private controller lease retained across authenticated native turns. */
  ownership?: ExecutionResourceOwnership;
  policy: ExecutionResourcePolicy;
  admission: ExecutionResourceAdmission;
  /** Root leases within an already-reserved, bounded run envelope. */
  rootAdmission?: Pick<ExecutionResourceAdmission, "acquire">;
  scratchDir: string;
  slice?: string;
  signal?: AbortSignal;
  /** Operator-owned packaged runner used for descriptor-preserving handoffs. */
  nativeLoaderCommand?: () => string;
  onUnitPrepared?: (unit: { unit: string; memoryMaxBytes: number; originRunId?: string; previousRunId?: string }) => Promise<void>;
  onOwnershipCommitted?: (claim: { previousRunId?: string; units: string[] }) => Promise<void>;
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
  runId?: string;
  scratchDir: string;
  slice?: string;
  signal?: AbortSignal;
  nativeLoaderCommand?: () => string;
  onEvidence?: ExecutionResourceContext["onEvidence"];
  onUnitPrepared?: ExecutionResourceContext["onUnitPrepared"];
  onOwnershipCommitted?: ExecutionResourceContext["onOwnershipCommitted"];
}, execute: () => Promise<T>): Promise<T> {
  const policy = resolveExecutionResourcePolicy();
  const key = JSON.stringify([policy, input.slice]);
  if (operatorAdmission && operatorAdmission.key !== key) {
    throw new Error("Execution resource policy changed; restart the control plane to apply it safely");
  }
  operatorAdmission ??= { key, initialized: (async () => {
    const admission = new ExecutionResourceAdmission(policy.capacityBytes, policy.maxConcurrent, policy.helperMaxConcurrent);
    const slice = policy.isolation === "systemd" ? await ensureSystemdExecutionSlice(policy, input.slice) : undefined;
    if (slice) await reconcileExecutionAdmission({ admission, list: () => listActiveExecutionUnits(slice) });
    return { admission, slice };
  })() };
  const initialized = await operatorAdmission.initialized;
  const context: ExecutionResourceContext = { ...input, policy, ...initialized };
  const ownership = new ExecutionResourceOwnership({ ...context });
  context.ownership = ownership;
  context.onEvidence = result => ownership.evidence(result);
  context.onUnitPrepared = unit => ownership.prepared(unit, unit.originRunId ?? input.runId);
  return withExecutionResourceContext(context, execute);
}

/** Authority is held by the controller's private warm-session entry, never by
 * provider output. Persist every verified unit before changing its event sink.
 */
export class ExecutionResourceOwnership {
  private roots = new Set<{ unit?: string; memoryMaxBytes: number; originRunId?: string;
    verify: () => Promise<void>; rebind: (signal?: AbortSignal) => void }>();
  private moving: Promise<void> | undefined;
  private transferred = false;
  constructor(private context: ExecutionResourceContext) {}

  get signal(): AbortSignal | undefined {
    this.assertLaunchAllowed();
    return this.context.signal;
  }

  assertLaunchAllowed(): void {
    if (this.moving) throw new Error("Execution resource ownership handoff is pending");
  }

  register(root: { unit?: string; memoryMaxBytes: number; originRunId?: string; verify: () => Promise<void>; rebind: (signal?: AbortSignal) => void }): () => void {
    this.assertLaunchAllowed();
    const owned = { ...root, originRunId: root.originRunId ?? this.context.runId };
    this.roots.add(owned);
    return () => { this.roots.delete(owned); };
  }

  async prepared(unit: { unit: string; memoryMaxBytes: number; previousRunId?: string }, originRunId?: string): Promise<void> {
    await this.moving;
    await this.context.onUnitPrepared?.({ ...unit, ...(this.transferred && originRunId !== this.context.runId
      ? { originRunId, previousRunId: unit.previousRunId ?? originRunId } : {}) });
    // A retained factory can create a new control root using its original
    // name prefix. Record its current owner before that root can spawn.
    if (this.transferred && originRunId !== this.context.runId && unit.previousRunId === undefined) {
      if (!this.context.onOwnershipCommitted) throw new Error("Retained execution ownership requires durable controller recording");
      await this.context.onOwnershipCommitted({ previousRunId: originRunId, units: [unit.unit] });
    }
  }

  async evidence(result: ExecutionResourceEvidence): Promise<void> {
    // Completion during persistence must use the committed owner, not a stale
    // callback captured when the native process first started.
    await this.moving?.catch(() => {});
    await this.context.onEvidence?.(result);
  }

  async handoff(next: ExecutionResourceContext): Promise<void> {
    if (this.moving) throw new Error("Execution resource ownership handoff is pending");
    if (next === this.context) return;
    if (next.admission !== this.context.admission || next.slice !== this.context.slice
      || JSON.stringify(next.policy) !== JSON.stringify(this.context.policy) || !next.runId || next.signal?.aborted) {
      throw new Error("Execution resource ownership policy or admission changed");
    }
    if ([...this.roots].some(root => root.unit) && (!next.onUnitPrepared || !next.onOwnershipCommitted)) {
      throw new Error("Retained execution ownership requires durable controller recording");
    }
    const previousRunId = this.context.runId;
    const transfer = async () => {
      for (const root of this.roots) await root.verify();
      for (const root of this.roots) if (root.unit) await next.onUnitPrepared?.({ unit: root.unit,
        memoryMaxBytes: root.memoryMaxBytes, originRunId: root.originRunId, previousRunId });
      // Check again after durable IO. A stopped or replaced process cannot be
      // adopted based only on a previously valid cgroup name.
      for (const root of this.roots) await root.verify();
      await next.onOwnershipCommitted?.({ previousRunId, units: [...this.roots].flatMap(root => root.unit ? [root.unit] : []) });
      this.context = { ...next, onEvidence: next.ownership?.context.onEvidence ?? next.onEvidence,
        onUnitPrepared: next.ownership?.context.onUnitPrepared ?? next.onUnitPrepared };
      this.transferred = true;
      next.ownership = this;
      for (const root of this.roots) root.rebind(next.signal);
    };
    this.moving = transfer();
    try { await this.moving; } finally { this.moving = undefined; }
  }
}
