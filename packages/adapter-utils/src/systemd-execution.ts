import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { ExecutionResourcePolicy } from "./execution-resource-policy.js";

const execFileAsync = promisify(execFile);

// Load private invocation data, then replace the loader with the real command.
// execve preserves the unit's PID, stdio, signal and descendant semantics. No
// command, arguments or secret values appear in systemd properties or argv.
const ENVIRONMENT_LOADER = String.raw`
const fs = require('node:fs');
const path = require('node:path');
try {
  const file = process.argv[1];
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.unlinkSync(file);
  fs.writeFileSync(config.identityFile, String(process.pid), {mode: 0o600});
  process.chdir(config.cwd);
  let executable;
  for (const candidate of config.command.includes('/')
    ? [path.resolve(config.cwd, config.command)]
    : (config.env.PATH || '').split(':').map(dir => path.resolve(dir || config.cwd, config.command))) {
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) { executable = candidate; break; } } catch {}
  }
  if (!executable) { process.stderr.write('Execution command is not executable\n'); process.exit(127); }
  process.execve(executable, [config.command, ...config.args], config.env);
} catch { process.stderr.write('Execution environment loader failed\n'); process.exit(126); }
`;

export interface ExecutionResourceEvidence {
  unit: string;
  memoryMaxBytes: number;
  memoryHighBytes: number;
  memorySwapMaxBytes: number;
  peakMemoryBytes: number | null;
  result: string | null;
  resourceLimitReached: boolean;
  mainExitCode: number | null;
  mainExitStatus: number | null;
  cancelled: boolean;
}

export interface SystemdExecutionBoundary {
  command: string;
  args: string[];
  unit: string;
  sample: () => Promise<void>;
  identity: () => Promise<{ pid: number; unit: string }>;
  signal: (signal: NodeJS.Signals) => Promise<void>;
  finish: (cancelled?: boolean) => Promise<ExecutionResourceEvidence>;
}

/** Fail closed: a requested Linux boundary is never retried as an ordinary spawn. */
export async function prepareSystemdExecution(input: {
  runId: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  policy: ExecutionResourcePolicy;
  scratchDir: string;
}): Promise<SystemdExecutionBoundary> {
  if (process.platform !== "linux" || typeof process.execve !== "function") {
    throw new Error("systemd execution requires Linux and Node.js execve support");
  }
  // An absent user manager or cgroup v2 is a configuration error, not permission
  // to run unbounded. Probe before persisting secret-bearing invocation data.
  await fs.access("/sys/fs/cgroup/cgroup.controllers");
  await execFileAsync("systemctl", ["--user", "show", "--property=Version", "--value"], { timeout: 5_000, maxBuffer: 1024 * 1024 });
  await fs.mkdir(input.scratchDir, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(input.scratchDir, "execution-"));
  await fs.chmod(directory, 0o700);
  const invocationFile = path.join(directory, "invocation.json");
  const identityFile = path.join(directory, "worker.pid");
  const env = Object.fromEntries(Object.entries(input.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  try {
    await fs.writeFile(invocationFile, JSON.stringify({ command: input.command, args: input.args, cwd: input.cwd, env, identityFile }), { mode: 0o600 });
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
  const unit = `paperclip-execution-${input.runId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 48)}-${randomUUID()}.service`;
  const policy = input.policy;
  const evidence: ExecutionResourceEvidence = {
    unit, memoryMaxBytes: policy.memoryMaxBytes, memoryHighBytes: policy.memoryHighBytes,
    memorySwapMaxBytes: policy.memorySwapMaxBytes, peakMemoryBytes: null,
    result: null, resourceLimitReached: false, mainExitCode: null, mainExitStatus: null, cancelled: false,
  };
  let cgroup: string | null = null;
  let finished = false;
  async function readProperties() {
    const { stdout } = await execFileAsync("systemctl", ["--user", "show", unit,
      "--property=ControlGroup,Result,ExecMainCode,ExecMainStatus,ExecMainPID"], { timeout: 5_000 });
    const properties = Object.fromEntries(stdout.trim().split("\n").map(line => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    if (properties.ControlGroup) {
      if (!properties.ControlGroup.startsWith("/") || properties.ControlGroup.includes("..")) throw new Error("Invalid execution cgroup path");
      cgroup = path.join("/sys/fs/cgroup", properties.ControlGroup);
    }
    evidence.result = properties.Result || evidence.result;
    evidence.mainExitCode = properties.ExecMainCode ? Number(properties.ExecMainCode) : evidence.mainExitCode;
    evidence.mainExitStatus = properties.ExecMainStatus ? Number(properties.ExecMainStatus) : evidence.mainExitStatus;
    evidence.resourceLimitReached ||= properties.Result === "oom-kill";
    return properties;
  }
  const sample = async () => {
    if (finished) return;
    try {
      if (!cgroup) await readProperties();
      if (!cgroup) return;
      const [peak, events] = await Promise.all([
        fs.readFile(path.join(cgroup, "memory.peak"), "utf8"),
        fs.readFile(path.join(cgroup, "memory.events"), "utf8"),
      ]);
      const bytes = Number(peak.trim());
      if (Number.isSafeInteger(bytes)) evidence.peakMemoryBytes = Math.max(evidence.peakMemoryBytes ?? 0, bytes);
      evidence.resourceLimitReached ||= /^oom_kill [1-9]\d*$/m.test(events);
    } catch {
      // A short command can finish before its first sample. Unknown is not zero.
    }
  };
  return {
    command: "systemd-run",
    args: ["--user", "--pipe", "--wait", "--quiet", "--service-type=exec", "--expand-environment=no",
      `--unit=${unit}`, `--working-directory=${input.cwd}`,
      `--property=MemoryHigh=${policy.memoryHighBytes}`,
      `--property=MemoryMax=${policy.memoryMaxBytes}`,
      `--property=MemorySwapMax=${policy.memorySwapMaxBytes}`,
      `--property=CPUQuota=${policy.cpuQuotaPercent}%`,
      `--property=TasksMax=${policy.tasksMax}`,
      "--property=MemoryAccounting=yes", "--property=CPUAccounting=yes",
      "--property=KillMode=control-group", "--property=OOMPolicy=stop",
      "--property=TimeoutStopSec=5s", "--", process.execPath, "--input-type=commonjs", "-e", ENVIRONMENT_LOADER, invocationFile],
    unit, sample,
    identity: async () => {
      const deadline = Date.now() + 5_000;
      do {
        try {
          const pid = Number(await fs.readFile(identityFile, "utf8"));
          if (Number.isSafeInteger(pid) && pid > 0) return { pid, unit };
        } catch { /* The service loader has not written its identity yet. */ }
        await new Promise(resolve => setTimeout(resolve, 20));
      } while (Date.now() < deadline);
      throw new Error("Execution unit did not report its worker PID");
    },
    signal: async signal => {
      await execFileAsync("systemctl", ["--user", "kill", "--kill-whom=all", `--signal=${signal}`, unit], { timeout: 5_000 });
    },
    finish: async (cancelled = false) => {
      if (finished) return { ...evidence };
      await sample();
      try { await readProperties(); } catch { /* Successful transient units can unload immediately. */ }
      evidence.cancelled ||= cancelled;
      // Stop is a whole-cgroup operation, including descendants that detached.
      // Propagate a real cleanup failure: admission must not be released while
      // an execution unit is still running.
      await execFileAsync("systemctl", ["--user", "stop", unit], { timeout: 15_000 }).catch(async (error) => {
        const { stdout } = await execFileAsync("systemctl", ["--user", "show", unit, "--property=LoadState", "--value"], { timeout: 5_000 });
        if (stdout.trim() !== "not-found") throw error;
      });
      await execFileAsync("systemctl", ["--user", "reset-failed", unit], { timeout: 5_000 }).catch(() => {});
      await fs.rm(directory, { recursive: true, force: true });
      finished = true;
      return { ...evidence };
    },
  };
}
