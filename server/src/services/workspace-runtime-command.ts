import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { currentExecutionResources, withExecutionResourceContext } from "@paperclipai/adapter-utils/execution-resource-context";
import { launchResourceStdioProcess } from "@paperclipai/adapter-utils/resource-stdio-process";
import { withHostExecutionResources } from "./host-execution-resources.js";

/** Keep the caller's streaming/truncation contract while governing preparation. */
export async function executeWorkspaceRuntimeCommand(input: {
  command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv;
}, output: { stdout: (chunk: string) => void; stderr: (chunk: string) => void }): Promise<number | null> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 30 * 60_000);
  timer.unref();
  try {
    return await withHostExecutionResources(deadline.signal, async () => {
      const resources = currentExecutionResources();
      if (resources?.policy.isolation !== "systemd") {
        return new Promise<number | null>((resolve, reject) => {
          const child = spawn(input.command, input.args, { cwd: input.cwd,
            env: input.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
          child.stdout?.on("data", chunk => output.stdout(String(chunk)));
          child.stderr?.on("data", chunk => output.stderr(String(chunk)));
          child.once("error", reject); child.once("close", resolve);
        });
      }
      let limited = false;
      return withExecutionResourceContext({ ...resources, onEvidence: async evidence => {
        limited ||= evidence.resourceLimitReached;
        await resources.onEvidence?.(evidence);
      } }, async () => {
        const worker = await launchResourceStdioProcess({ runId: resources.runId ?? `workspace-${randomUUID()}`,
          ...input, env: input.env ?? process.env, signal: deadline.signal, scope: true, allowEarlyExit: true,
          nativeLoaderCommand: resources.nativeLoaderCommand?.() });
        worker.child.stdout.on("data", chunk => output.stdout(String(chunk)));
        worker.child.stderr.on("data", chunk => output.stderr(String(chunk)));
        worker.child.stdin.on("error", () => {}); worker.child.stdin.end();
        const result = await worker.completion;
        if (limited) throw Object.assign(new Error("Workspace command exceeded its memory resource limit"), { code: "execution_resource_limit" });
        if (deadline.signal.aborted) throw Object.assign(new Error("Workspace command exceeded its preparation deadline"), { code: "ETIMEDOUT" });
        return result.code;
      });
    });
  } catch (error) {
    if (deadline.signal.aborted && (error as NodeJS.ErrnoException).code !== "execution_resource_limit") {
      throw Object.assign(new Error("Workspace command exceeded its preparation deadline", { cause: error }), { code: "ETIMEDOUT" });
    }
    throw error;
  } finally { clearTimeout(timer); }
}
