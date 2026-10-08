import fs from "node:fs/promises";
import path from "node:path";
import { currentExecutionResources, withExecutionResourceContext, withOperatorExecutionResources } from "@paperclipai/adapter-utils/execution-resource-context";
import { resolveExecutionResourcePolicy } from "@paperclipai/adapter-utils/execution-resource-policy";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { resolvePaperclipRunnerBinary } from "./native-runtime/runner-binary.js";
import { logger } from "../middleware/logger.js";

/** Controller helpers share operator admission with agents, including UI/API
 * requests outside run dispatch. Never resolve policy from command environment.
 */
export async function withHostExecutionResources<T>(signal: AbortSignal | undefined, execute: () => Promise<T>, runId?: string): Promise<T> {
  const existing = currentExecutionResources();
  if (existing) return withExecutionResourceContext({ ...existing, admissionKind: "helper" }, execute);
  if (resolveExecutionResourcePolicy().isolation === "none") return execute();
  const root = path.join(resolvePaperclipInstanceRoot(), "runtime", "execution-helpers");
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const scratchDir = await fs.mkdtemp(path.join(root, "helper-"));
  const pending = new Set<string>();
  try {
    return await withOperatorExecutionResources({ scratchDir, signal, runId,
      nativeLoaderCommand: resolvePaperclipRunnerBinary,
      onUnitPrepared: async ({ unit }) => { pending.add(unit); },
      onEvidence: async evidence => {
        pending.delete(evidence.unit);
        if (evidence.resourceLimitReached) logger.warn({ executionResources: evidence }, "Host helper exceeded its memory resource limit");
      },
    }, () => withExecutionResourceContext({ ...currentExecutionResources()!, admissionKind: "helper" }, execute));
  } finally {
    // A failed cleanup retains its private launch files and OS reservation.
    // Removing them here would hide the state needed to reconcile that unit.
    if (!pending.size) await fs.rm(scratchDir, { recursive: true, force: true });
  }
}
