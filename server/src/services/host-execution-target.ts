import {
  prepareAdapterExecutionTargetRuntime as prepareRuntime,
  runAdapterExecutionTargetShellCommand as runShellCommand,
  type PreparedAdapterExecutionTargetRuntime,
} from "@paperclipai/adapter-utils/execution-target";
import { withHostExecutionResources } from "./host-execution-resources.js";

/** Staging returns callbacks that may execute after the dispatch context ends.
 * Install operator policy for each finite operation, preserving a current run
 * context whenever the caller already owns one.
 */
export async function prepareAdapterExecutionTargetRuntime(
  input: Parameters<typeof prepareRuntime>[0],
): Promise<PreparedAdapterExecutionTargetRuntime> {
  const runtime = await withHostExecutionResources(undefined, () => prepareRuntime(input), input.runId);
  return {
    ...runtime,
    restoreWorkspace: (onProgress) => withHostExecutionResources(
      undefined, () => runtime.restoreWorkspace(onProgress), input.runId,
    ),
    ...(runtime.cleanupWorkspaceSnapshot ? {
      cleanupWorkspaceSnapshot: () => withHostExecutionResources(
        undefined, () => runtime.cleanupWorkspaceSnapshot!(), input.runId,
      ),
    } : {}),
  };
}

export function runAdapterExecutionTargetShellCommand(...args: Parameters<typeof runShellCommand>) {
  return withHostExecutionResources(undefined, () => runShellCommand(...args), args[0]);
}
