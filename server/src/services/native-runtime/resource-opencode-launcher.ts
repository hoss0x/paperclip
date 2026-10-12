import { currentExecutionResources } from "@paperclipai/adapter-utils/execution-resource-context";
import { launchResourceStdioProcess } from "@paperclipai/adapter-utils/resource-stdio-process";
import type { OpenCodeServerDriverOptions } from "@paperclipai/paperclip-runner";

/** Keep verified descriptors and authenticated HTTP startup in the driver. */
export function createResourceOpenCodeLauncher(runId: string, nativeLoader: () => string): OpenCodeServerDriverOptions["processLauncher"] {
  if (currentExecutionResources()?.policy.isolation !== "systemd") return undefined;
  return async input => {
    const owned = await launchResourceStdioProcess({
      runId, command: input.command, args: input.args, cwd: input.cwd,
      env: input.environment, signal: input.signal, scope: true,
      nativeLoaderCommand: nativeLoader(), extraStdio: input.stdio.slice(3), detached: input.detached,
    });
    // Match the driver's ignored input/output without accumulating pipe data.
    if (input.stdio[0] === "ignore") owned.child.stdin.end();
    if (input.stdio[1] === "ignore") owned.child.stdout.resume();
    return owned;
  };
}
