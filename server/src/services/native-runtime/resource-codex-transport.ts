import { currentExecutionResources } from "@paperclipai/adapter-utils/execution-resource-context";
import { launchResourceStdioProcess } from "@paperclipai/adapter-utils/resource-stdio-process";
import { ProcessCodexAppServerTransport, type CodexAppServerTransport, type ProcessCodexTransportOptions } from "../../vendor/paperclip-runner/index.js";

/** Keep the native driver's protocol, arguments, environment and session logic. */
export function createResourceCodexTransport(runId: string): ((options: ProcessCodexTransportOptions) => Promise<CodexAppServerTransport>) | undefined {
  if (currentExecutionResources()?.policy.isolation !== "systemd") return undefined;
  return async options => {
    const ownedProcess = await launchResourceStdioProcess({
      runId, command: options.command ?? "codex", args: options.args ?? ["app-server"],
      cwd: options.workingDirectory ?? process.cwd(), env: options.environment ?? {}, signal: options.launchSignal,
    });
    return new ProcessCodexAppServerTransport({ ...options, ownedProcess });
  };
}
