import type { AcpRuntime, AcpRuntimeOptions } from "acpx/runtime";
import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { currentExecutionResources } from "../execution-resource-context.js";
import { prepareExecutionRunEnvelope } from "../execution-run-envelope.js";
import { launchResourceStdioProcess } from "../resource-stdio-process.js";

/** The older ACP runtime owns provider and client-side terminal roots together.
 * Retain the reservation until runtime close and verified descendant cleanup.
 */
export async function prepareAcpxRuntimeResources(input: { runId: string; cwd: string }) {
  const resources = currentExecutionResources();
  if (resources?.policy.isolation !== "systemd") return undefined;
  const nativeLoaderCommand = resources.nativeLoaderCommand?.();
  if (!nativeLoaderCommand) throw new Error("ACPX resource isolation requires the packaged native runner");
  const envelope = await prepareExecutionRunEnvelope();
  const spawnProcess: NonNullable<AcpRuntimeOptions["spawnProcess"]> = (command, args, options) => envelope.run(async () => {
    if (options.shell || (options.cwd !== undefined && typeof options.cwd !== "string")
      || !Array.isArray(options.stdio) || options.stdio.length !== 3
      || !["pipe", "ignore"].includes(String(options.stdio[0]))
      || options.stdio[1] !== "pipe" || options.stdio[2] !== "pipe") {
      throw new Error("Invalid ACPX resource handoff");
    }
    // Preserve ACPX's direct-command ENOENT fallback for shell syntax. This
    // check is only compatibility; the boundary still validates at exec time.
    const cwd = options.cwd ?? input.cwd;
    const candidates = command.includes("/") ? [path.resolve(cwd, command)]
      : (options.env?.PATH ?? "").split(":").map(directory => path.resolve(directory || cwd, command));
    let executable = false;
    let denied = false;
    for (const candidate of candidates) {
      try { await fs.access(candidate, constants.X_OK); executable = (await fs.stat(candidate)).isFile(); }
      catch (error) { denied ||= (error as NodeJS.ErrnoException).code === "EACCES"; }
      if (executable) break;
    }
    if (!executable) throw Object.assign(new Error("ACPX execution command is unavailable"), { code: denied ? "EACCES" : "ENOENT" });
    const worker = await launchResourceStdioProcess({ runId: input.runId,
      command, args: [...args], cwd, env: options.env ?? {},
      scope: true, nativeLoaderCommand, detached: options.detached,
      allowEarlyExit: options.stdio[0] === "ignore" });
    if (options.stdio[0] === "ignore") worker.child.stdin.end();
    return worker;
  });
  return {
    spawnProcess,
    close: () => envelope.close(),
    own(runtime: AcpRuntime): AcpRuntime {
      // Bind methods to the original runtime so private fields retain identity.
      // Closing can be retried if resource cleanup fails; capacity stays held.
      return new Proxy(runtime, {
        get(target, property) {
          if (property === "close") return async (...args: Parameters<AcpRuntime["close"]>) => {
            try { return await target.close(...args); } finally { await envelope.close(); }
          };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
}
