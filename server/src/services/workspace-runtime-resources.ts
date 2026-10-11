import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { withOperatorExecutionResources, currentExecutionResources } from "@paperclipai/adapter-utils/execution-resource-context";
import { applyLowMemoryEnvironment, resolveExecutionResourcePolicy } from "@paperclipai/adapter-utils/execution-resource-policy";
import { prepareSystemdExecution } from "@paperclipai/adapter-utils/systemd-execution";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logger } from "../middleware/logger.js";

const exec = promisify(execFile);
export interface WorkspaceRuntimeResourceOwner { ownerId: string; unit: string; memoryMaxBytes: number }
const live = new Map<string, { stop: () => Promise<void>; completion: Promise<void> }>();

function validateOwner(owner: WorkspaceRuntimeResourceOwner) {
  if (!/^[a-f0-9-]{36}$/.test(owner.ownerId)
    || !owner.unit.startsWith(`paperclip-execution-runtime-${owner.ownerId}-`)
    || !/^paperclip-execution-runtime-[a-f0-9-]+-runtime\.service$/.test(owner.unit)
    || !Number.isSafeInteger(owner.memoryMaxBytes) || owner.memoryMaxBytes <= 0) {
    throw new Error("Workspace runtime resource ownership is invalid");
  }
}

/** Independent previews outlive a turn. They consume aggregate bytes, rather
 * than an agent or helper slot, and retain private server ownership on disk. */
export async function spawnWorkspaceRuntimeService(input: {
  ownerId: string; command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; logFd: number; logPath: string;
  persistOwnership: (owner: WorkspaceRuntimeResourceOwner) => Promise<void>;
}): Promise<{ child: ChildProcess; owner: WorkspaceRuntimeResourceOwner } | null> {
  if (resolveExecutionResourcePolicy().isolation === "none") return null;
  const parent = path.join(resolvePaperclipInstanceRoot(), "runtime", "execution-services");
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const scratchDir = await fs.mkdtemp(path.join(parent, "service-"));
  try {
    return await withOperatorExecutionResources({ scratchDir }, async () => {
      const resources = currentExecutionResources()!;
      const bytes = resources.policy.runtimeMemoryMaxBytes ?? Math.max(1024 ** 2, Math.floor(resources.policy.memoryMaxBytes / 4));
      const policy = { ...resources.policy, memoryMaxBytes: bytes,
        memoryHighBytes: Math.min(resources.policy.memoryHighBytes, bytes) };
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), 120_000); timer.unref();
      let release: (() => void) | undefined;
      let boundary: Awaited<ReturnType<typeof prepareSystemdExecution>> | undefined;
      try {
        release = await resources.admission.acquire(bytes, deadline.signal, "runtime");
        boundary = await prepareSystemdExecution({ ...input, runId: `runtime-${input.ownerId}`,
          admissionKind: "runtime", policy, scratchDir, slice: resources.slice,
          env: applyLowMemoryEnvironment(input.env, policy) });
        const owner = { ownerId: input.ownerId, unit: boundary.unit, memoryMaxBytes: bytes };
        validateOwner(owner);
        // Persist BEFORE spawn; a crash cannot lose the authority to clean it.
        await input.persistOwnership(owner);
        if (deadline.signal.aborted) throw new Error("Workspace runtime admission deadline exceeded");
        const child = spawn(boundary.command, boundary.args, { cwd: input.cwd, env: process.env,
          stdio: ["ignore", input.logFd, input.logFd] });
        const stopped = new Promise<void>((resolve, reject) => {
          child.once("error", reject); child.once("close", () => resolve());
        });
        void stopped.catch(() => {});
        const owned = boundary;
        let finalizing: Promise<void> | undefined;
        const finish = (): Promise<void> => finalizing ??= (async () => {
          const evidence = await owned.finish();
          await fs.rm(scratchDir, { recursive: true, force: true });
          if (evidence.resourceLimitReached) {
            // Retain the same diagnosis in the service's durable output after
            // systemd collects its terminal counters. Startup errors already
            // expose this bounded log excerpt through the existing contract.
            await fs.appendFile(input.logPath, `[paperclip] execution_resource_limit: Workspace runtime exceeded its memory resource limit ${JSON.stringify(evidence)}\n`);
            logger.warn({ runtimeServiceId: input.ownerId,
              executionResources: evidence }, "Workspace runtime exceeded its memory resource limit");
          }
          release!();
          live.delete(owner.unit);
        })().catch(error => { finalizing = undefined; throw error; });
        const completion = stopped.then(finish, async error => { await finish(); throw error; });
        void completion.catch(error => logger.error({ err: error, runtimeServiceId: input.ownerId }, "Workspace runtime cleanup failed"));
        live.set(owner.unit, { completion, stop: async () => {
          await owned.finish(true);
          await stopped.catch(() => {});
          await finish();
        } });
        const identity = await owned.identity();
        await owned.verifyOwnership(identity.pid);
        if (deadline.signal.aborted) throw new Error("Workspace runtime admission deadline exceeded");
        // Preserve the ChildProcess event API, but expose the actual workload PID.
        const proxy = new Proxy(child, { get(target, property) {
          if (property === "pid") return identity.pid;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        } });
        return { child: proxy, owner };
      } catch (error) {
        if (boundary) {
          const evidence = await boundary.finish(true);
          if (live.has(boundary.unit)) await live.get(boundary.unit)!.completion;
          if (evidence.resourceLimitReached) error = Object.assign(new Error("Workspace runtime exceeded its memory resource limit"), { code: "execution_resource_limit" });
        }
        release?.();
        await fs.rm(scratchDir, { recursive: true, force: true });
        throw error;
      } finally { clearTimeout(timer); }
    });
  } catch (error) {
    // A cleanup rejection keeps ownership and launch files for reconciliation.
    throw error;
  }
}

export async function verifyWorkspaceRuntimeExecution(owner: WorkspaceRuntimeResourceOwner, pid: number): Promise<void> {
  validateOwner(owner);
  const actual = (await fs.readFile(`/proc/${pid}/cgroup`, "utf8")).split("\n")
    .find(line => line.startsWith("0::"))?.slice(3);
  const values = Object.fromEntries((await exec("systemctl", ["--user", "show", owner.unit,
    "--property=Id,ControlGroup,MemoryMax,ActiveState"], { timeout: 5_000, maxBuffer: 64 * 1024 })).stdout
    .trim().split("\n").map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
  if (values.Id !== owner.unit || values.ControlGroup !== actual || actual?.split("/").at(-1) !== owner.unit
    || values.ActiveState !== "active" || Number(values.MemoryMax) !== owner.memoryMaxBytes) {
    throw new Error("Workspace runtime unit identity changed");
  }
}

/** Registry authority remains usable after leader loss or controller restart. */
export async function stopWorkspaceRuntimeExecution(owner: WorkspaceRuntimeResourceOwner): Promise<void> {
  validateOwner(owner);
  const running = live.get(owner.unit);
  if (running) return running.stop();
  const show = async (properties: string) => (await exec("systemctl", ["--user", "show", owner.unit,
    `--property=${properties}`], { timeout: 5_000, maxBuffer: 64 * 1024 })).stdout;
  const values = Object.fromEntries((await show("Id,LoadState,MemoryMax,MemoryPeak,Result,ActiveState"))
    .trim().split("\n").map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
  if (values.LoadState === "not-found") return;
  if (values.Id !== owner.unit || Number(values.MemoryMax) !== owner.memoryMaxBytes) throw new Error("Workspace runtime unit identity changed");
  await exec("systemctl", ["--user", "stop", owner.unit], { timeout: 15_000 });
  const state = await show("ActiveState,LoadState");
  if (!/^(ActiveState=(inactive|failed)|LoadState=not-found)$/m.test(state)) throw new Error("Workspace runtime cleanup was not verified");
  if (values.Result === "oom-kill") logger.warn({ runtimeServiceId: owner.ownerId, unit: owner.unit,
    memoryMaxBytes: owner.memoryMaxBytes, peakMemoryBytes: values.MemoryPeak }, "Recovered workspace runtime exceeded its memory resource limit");
  await exec("systemctl", ["--user", "reset-failed", owner.unit], { timeout: 5_000 }).catch(() => {});
}
