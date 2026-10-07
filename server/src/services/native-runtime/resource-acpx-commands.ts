import { currentExecutionResources } from "@paperclipai/adapter-utils/execution-resource-context";
import { prepareExecutionRunEnvelope } from "@paperclipai/adapter-utils/execution-run-envelope";
import { prepareResourceScopeProcess } from "@paperclipai/adapter-utils/resource-stdio-process";
import type { NativeBackendFactoryOptions } from "@paperclipai/paperclip-runner";

/** One session budget, retained until guardian and bounded-root cleanup finish. */
export function createResourceAcpxCommands(runId: string, nativeLoader: () => string): NativeBackendFactoryOptions["acpxPrepareCommandResources"] {
  if (currentExecutionResources()?.policy.isolation !== "systemd") return undefined;
  return async input => {
    const envelope = await prepareExecutionRunEnvelope({ signal: input.signal });
    return {
      close: () => envelope.close(),
      openCommand: installation => envelope.run(async () => {
        const ticket = await prepareResourceScopeProcess({ runId, cwd: input.cwd, nativeLoaderCommand: nativeLoader(), signal: input.signal });
        let worker: ReturnType<typeof ticket.spawn> | undefined;
        try {
          const command = await installation.openCommand({ processLauncher: (command, args, options) => {
            if (options.shell || !Array.isArray(options.stdio) || options.stdio.slice(0, 3).some(value => value !== "pipe")) {
              throw new Error("Invalid verified ACPX stdio handoff");
            }
            const extraStdio = options.stdio.slice(3);
            if (extraStdio.some(value => value !== "pipe" && !(typeof value === "number" && Number.isInteger(value) && value >= 0))) {
              throw new Error("Invalid verified ACPX descriptor handoff");
            }
            if (options.cwd !== undefined && typeof options.cwd !== "string") throw new Error("Invalid verified ACPX working directory");
            worker = ticket.spawn({ command, args: [...args], cwd: options.cwd ?? input.cwd,
              env: options.env ?? {}, extraStdio: extraStdio as Array<"pipe" | number>, detached: options.detached });
            return worker.child;
          } });
          return {
            spawn: (...args) => command.spawn(...args),
            close: async () => {
              // Runtime close owns graceful guardian shutdown and its exit proof.
              // Do not replace that proof with killing a client PID here.
              if (worker) await worker.completion;
              await ticket.close();
              await command.close();
            },
          };
        } catch (error) { await ticket.close(); throw error; }
      }),
    };
  };
}
