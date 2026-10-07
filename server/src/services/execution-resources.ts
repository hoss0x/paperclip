import { resolvePaperclipRunnerBinary } from "./native-runtime/runner-binary.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRunEvents } from "@paperclipai/db";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { withOperatorExecutionResources } from "@paperclipai/adapter-utils/execution-resource-context";
import type { ExecutionResourceEvidence } from "@paperclipai/adapter-utils/systemd-execution";

export const RESOURCE_UNIT_PREPARED = "execution_resource_prepared";
export const RESOURCE_UNIT_FINISHED = "execution_resource_finished";
const execFileAsync = promisify(execFile);

// Adapter output is data, not controller-owned cancellation authority.
export function resourceSafeAdapterEventType(eventType: string): string {
  return eventType.startsWith("execution_resource_") ? `adapter.${eventType}` : eventType;
}

export class ExecutionResourceLimitError extends Error {
  readonly code = "execution_resource_limit";
  constructor(readonly evidence: ExecutionResourceEvidence[]) {
    super("Execution exceeded its memory resource limit");
  }
}

/** Resource failures are projected once, independently of adapter parsers. */
export async function executeWithResourceGovernance(input: {
  runId?: string;
  scratchDir: string;
  slice?: string;
  signal: AbortSignal;
  record: (event: { eventType: string; message: string; payload: Record<string, unknown> }) => Promise<void>;
}, execute: () => Promise<AdapterExecutionResult>): Promise<AdapterExecutionResult> {
  const evidence: ExecutionResourceEvidence[] = [];
  return withOperatorExecutionResources({
    runId: input.runId,
    scratchDir: input.scratchDir, slice: input.slice, signal: input.signal,
    nativeLoaderCommand: resolvePaperclipRunnerBinary,
    onUnitPrepared: async unit => input.record({ eventType: RESOURCE_UNIT_PREPARED,
      message: "Resource execution unit prepared", payload: unit }),
    onEvidence: async result => {
      evidence.push(result);
      await input.record({ eventType: RESOURCE_UNIT_FINISHED,
        message: result.resourceLimitReached ? "Execution exceeded its memory resource limit" : "Resource execution unit stopped",
        payload: { ...result } });
    },
  }, async () => {
    let result: AdapterExecutionResult;
    try { result = await execute(); }
    catch (error) {
      if (evidence.some(item => item.resourceLimitReached)) throw new ExecutionResourceLimitError(evidence);
      throw error;
    }
    const limited = evidence.some(item => item.resourceLimitReached);
    return { ...result,
      ...(limited ? { exitCode: result.exitCode || 1, errorCode: "execution_resource_limit", errorMessage: "Execution exceeded its memory resource limit" } : {}),
      ...(evidence.length ? { resultJson: { ...result.resultJson, executionResources: evidence } } : {}),
    };
  });
}

/** Only immutable local run-log ownership, never agent-supplied unit names. */
export async function stopRecordedLegacyExecutionUnits(db: Db, run: { id: string; companyId: string; runtimeMode: string | null },
  systemctl: (args: string[], timeout: number) => Promise<string> = async (args, timeout) =>
    (await execFileAsync("systemctl", ["--user", ...args], { timeout })).stdout,
): Promise<boolean> {
  if (process.platform !== "linux" || run.runtimeMode === "native") return false;
  const rows = await db.select({ payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    eq(heartbeatRunEvents.eventType, RESOURCE_UNIT_PREPARED),
  ));
  const prefix = `paperclip-execution-${run.id.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 48)}-`;
  const units = new Set(rows.map(row => row.payload?.unit).filter((unit): unit is string =>
    typeof unit === "string" && unit.startsWith(prefix) && /^paperclip-execution-[a-zA-Z0-9-]+\.(?:service|scope)$/.test(unit)));
  for (const unit of units) {
    const stdout = await systemctl(["show", unit, "--property=LoadState", "--value"], 5_000);
    if (stdout.trim() === "not-found") continue;
    await systemctl(["stop", unit], 15_000);
    const state = await systemctl(["show", unit, "--property=ActiveState", "--value"], 5_000);
    if (!["inactive", "failed"].includes(state.trim())) throw new Error("Execution unit termination was not verified");
    await systemctl(["reset-failed", unit], 5_000).catch(() => {});
  }
  return units.size > 0;
}
