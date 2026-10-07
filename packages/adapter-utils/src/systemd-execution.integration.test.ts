import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveExecutionResourcePolicy } from "./execution-resource-policy.js";
import { prepareSystemdExecution, type SystemdExecutionBoundary } from "./systemd-execution.js";

const enabled = process.platform === "linux" && process.env.PAPERCLIP_TEST_SYSTEMD === "1";
const policy = resolveExecutionResourcePolicy({
  PAPERCLIP_EXECUTION_MEMORY_MAX_MIB: "96", PAPERCLIP_EXECUTION_MEMORY_HIGH_MIB: "72",
}, "linux", 8 * 1024 ** 3);

async function prepare(script: string, env: NodeJS.ProcessEnv = {}, memoryHighBytes = policy.memoryHighBytes, extraArgs: string[] = []) {
  const scratchDir = process.env.PAPERCLIP_SCRATCH_DIR;
  if (!scratchDir) throw new Error("Systemd integration tests require PAPERCLIP_SCRATCH_DIR");
  return prepareSystemdExecution({ runId: randomUUID(), command: process.execPath,
    args: ["-e", script, ...extraArgs], cwd: process.cwd(), env: { PATH: process.env.PATH, ...env }, policy: { ...policy, memoryHighBytes }, scratchDir });
}

function launch(boundary: SystemdExecutionBoundary, stdin = "") {
  const child = spawn(boundary.command, boundary.args, { stdio: "pipe" });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); });
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  child.stdin.end(stdin);
  const watchdog = setTimeout(() => { void boundary.signal("SIGKILL").catch(() => {}); }, 10_000);
  const completed = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.on("error", error => { clearTimeout(watchdog); reject(error); });
    child.on("close", code => { clearTimeout(watchdog); resolve({ code, stdout, stderr }); });
  });
  return { child, completed, output: () => stdout };
}

(enabled ? describe : describe.skip)("real Linux systemd execution boundary", () => {
  it("preserves stdin, exact environment and literal args in a sibling cgroup", async () => {
    const secret = 'line one\n"quoted" $HOME \\ value';
    const boundary = await prepare(`
      const fs = require('node:fs');
      process.stdin.setEncoding('utf8'); let input = '';
      process.stdin.on('data', c => input += c);
      process.stdin.on('end', () => {
        console.log(JSON.stringify({input, args:process.argv.slice(1), secret:process.env.PRIVATE_VALUE,
          inherited:process.env.PAPERCLIP_TEST_SYSTEMD ?? null,
          cgroup:fs.readFileSync('/proc/self/cgroup','utf8')}));
        setTimeout(() => {}, 800);
      });`, { PRIVATE_VALUE: secret }, policy.memoryHighBytes, ["$HOME", 'space "quoted"']);
    let timer: NodeJS.Timeout | undefined;
    try {
      const running = launch(boundary, "stdin payload\n");
      timer = setInterval(() => { void boundary.sample(); }, 100);
      const result = await running.completed;
      expect(result.code, result.stderr).toBe(0);
      const payload = JSON.parse(result.stdout.trim());
      expect(payload).toMatchObject({ input: "stdin payload\n", args: ["$HOME", 'space "quoted"'], secret, inherited: null });
      expect(payload.cgroup).toContain(boundary.unit);
      expect(payload.cgroup).not.toContain("paperclipai.service");
      const evidence = await boundary.finish();
      expect(evidence.resourceLimitReached).toBe(false);
      expect(evidence.peakMemoryBytes).toBeGreaterThan(0);
      expect(evidence.peakMemoryBytes).toBeLessThanOrEqual(policy.memoryMaxBytes);
    } finally {
      clearInterval(timer);
      await boundary.finish();
    }
  }, 20_000);

  it("kills descendants that start new process groups on cancellation", async () => {
    const boundary = await prepare(`
      const {spawn} = require('node:child_process');
      const child = spawn(process.execPath,['-e','setInterval(()=>{},1000)'],
        {detached:true,stdio:'ignore'});
      console.log(child.pid); setInterval(()=>{},1000);`);
    try {
      const running = launch(boundary);
      await expect.poll(() => running.output().trim(), { timeout: 10_000 }).toMatch(/^\d+$/);
      const descendant = Number(running.output().trim());
      await boundary.signal("SIGTERM");
      await running.completed;
      const evidence = await boundary.finish(true);
      expect(evidence.cancelled).toBe(true);
      await expect.poll(async () => {
        try { const stat = await fs.readFile(`/proc/${descendant}/stat`, "utf8"); return stat.split(") ")[1]?.startsWith("Z"); }
        catch { return true; }
      }, { timeout: 5_000 }).toBe(true);
    } finally { await boundary.finish(true); }
  }, 20_000);

  it("reports a memory-limit kill and allows a later execution to succeed", async () => {
    const boundary = await prepare(`
      const buffers=[]; let allocated=0;
      const timer=setInterval(()=>{buffers.push(Buffer.alloc(4*1024*1024,1));
        if(++allocated===128) {clearInterval(timer);process.exit(2);}},10);`, {}, policy.memoryMaxBytes);
    let timer: NodeJS.Timeout | undefined;
    try {
      const running = launch(boundary);
      timer = setInterval(() => { void boundary.sample(); }, 50);
      const result = await running.completed;
      expect(result.code).not.toBe(0);
      const evidence = await boundary.finish();
      expect(evidence.resourceLimitReached).toBe(true);
      expect(evidence.result).toBe("oom-kill");
    } finally { clearInterval(timer); await boundary.finish(); }
    const subsequent = await prepare("console.log('recovered')");
    try {
      const result = await launch(subsequent).completed;
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("recovered");
    } finally { await subsequent.finish(); }
  }, 20_000);
});
