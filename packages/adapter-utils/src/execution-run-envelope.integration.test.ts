import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { withExecutionResourceContext } from "./execution-resource-context.js";
import { prepareExecutionRunEnvelope } from "./execution-run-envelope.js";
import { ExecutionResourceAdmission, resolveExecutionResourcePolicy } from "./execution-resource-policy.js";
import { launchResourceStdioProcess, prepareResourceScopeProcess } from "./resource-stdio-process.js";
import { ensureSystemdExecutionSlice } from "./systemd-execution-slice.js";
import { listActiveExecutionUnits, reconcileExecutionAdmission } from "./execution-resource-reconciliation.js";
import { runChildProcess } from "./server-utils.js";
import type { ExecutionResourceEvidence } from "./systemd-execution.js";

const ctl = promisify(execFile);
const enabled = process.platform === "linux" && process.env.PAPERCLIP_TEST_SYSTEMD === "1";
async function fixture() {
  const policy = resolveExecutionResourcePolicy({ PAPERCLIP_EXECUTION_CAPACITY_MIB: "256",
    PAPERCLIP_EXECUTION_MEMORY_MAX_MIB: "128", PAPERCLIP_EXECUTION_MEMORY_HIGH_MIB: "128" }, "linux", 8 * 1024 ** 3);
  const slice = await ensureSystemdExecutionSlice(policy, `paperclip-envelopecheck-${randomUUID()}.slice`);
  const scratchDir = process.env.PAPERCLIP_SCRATCH_DIR!;
  if (!scratchDir) throw new Error("Tests require run-owned scratch");
  const evidence: ExecutionResourceEvidence[] = [];
  return { slice, scratchDir, policy, admission: new ExecutionResourceAdmission(policy.capacityBytes, 1), evidence,
    onEvidence: async (value: ExecutionResourceEvidence) => { evidence.push(value); } };
}
function launch(script: string) {
  return launchResourceStdioProcess({ runId: randomUUID(), command: process.execPath,
    args: ["-e", script], cwd: process.cwd(), env: { PATH: process.env.PATH }, scope: true,
    nativeLoaderCommand: process.env.PAPERCLIP_TEST_RESOURCE_LOADER! });
}
async function cleanup(slice: string) {
  await ctl("systemctl", ["--user", "stop", slice]);
  await ctl("systemctl", ["--user", "revert", slice]);
}
(enabled ? describe : describe.skip)("shared run resource envelope", () => {
  it("runs control roots beside the persistent root with one reservation and adopts it once after restart", async () => {
    const resources = await fixture();
    try {
      await withExecutionResourceContext(resources, async () => {
        const envelope = await prepareExecutionRunEnvelope();
        try {
          await envelope.run(async () => {
            await expect(prepareExecutionRunEnvelope()).rejects.toThrow("cannot be nested");
            const persistent = await launch("console.log(require('node:fs').readFileSync('/proc/self/cgroup','utf8'));setInterval(()=>{},1000)");
            persistent.child.stderr.resume();
            let output = ""; persistent.child.stdout.on("data", chunk => { output += chunk; });
            const control = await launch("console.log('control succeeded');setTimeout(()=>process.exit(0),300)");
            control.child.stdout.resume(); control.child.stderr.resume();
            await expect.poll(() => output).toContain(envelope.slice);
            expect(output).not.toContain("paperclipai.service");
            expect(resources.admission.snapshot).toEqual({ active: 1, usedBytes: resources.policy.memoryMaxBytes, queued: 0 });
            expect(await listActiveExecutionUnits(resources.slice)).toEqual([{ unit: envelope.slice, memoryMaxBytes: resources.policy.memoryMaxBytes }]);
            const restartAdmission = new ExecutionResourceAdmission(resources.policy.capacityBytes, 1);
            await reconcileExecutionAdmission({ admission: restartAdmission, list: () => listActiveExecutionUnits(resources.slice), intervalMs: 50 });
            expect(restartAdmission.snapshot.active).toBe(1);
            expect(await control.completion).toEqual({ code: 0, signal: null });
            const shared = await runChildProcess(randomUUID(), process.execPath, ["-e", "console.log('shared control succeeded')"], {
              cwd: process.cwd(), env: {}, timeoutSec: 5, graceSec: 1, onLog: async () => {},
            });
            expect(shared.exitCode, shared.stderr).toBe(0);
            expect(shared.stdout.trim()).toBe("shared control succeeded");
            persistent.signal("SIGTERM"); await persistent.completion;
            // Idle session ownership still holds capacity until explicit close.
            expect(resources.admission.snapshot.active).toBe(1);
            await expect.poll(() => restartAdmission.snapshot.active).toBe(0);
          });
        } finally { await envelope.close(); }
        expect(resources.admission.snapshot.active).toBe(0);
        await expect(envelope.run(async () => {})).rejects.toThrow("closed or cancelled");
      });
    } finally { await cleanup(resources.slice); }
  }, 20_000);

  it("bounds the sum of roots, stops the full run on OOM and permits a later envelope", async () => {
    const resources = await fixture();
    try {
      await withExecutionResourceContext(resources, async () => {
        const envelope = await prepareExecutionRunEnvelope();
        try {
          await envelope.run(async () => {
            const workers = await Promise.all([launch("process.stdin.once('data',()=>{const a=[];setInterval(()=>a.push(Buffer.alloc(4*1024*1024,1)),20)});setInterval(()=>{},1000)"),
              launch("process.stdin.once('data',()=>{const a=[];setInterval(()=>a.push(Buffer.alloc(4*1024*1024,1)),20)});setInterval(()=>{},1000)")]);
            for (const worker of workers) { worker.child.stdout.resume(); worker.child.stderr.resume(); }
            for (const worker of workers) worker.child.stdin.end("start");
            const results = await Promise.all(workers.map(worker => worker.completion));
            expect(results.every(result => result.code !== 0)).toBe(true);
            expect(results.some(result => result.signal === "SIGKILL")).toBe(true);
            expect(envelope.measurement.resourceLimitReached).toBe(true);
            expect(envelope.measurement.peakMemoryBytes).toBeGreaterThan(100 * 1024 ** 2);
            expect(envelope.measurement.peakMemoryBytes).toBeLessThanOrEqual(resources.policy.memoryMaxBytes + 1024 ** 2);
            console.info("run envelope measurement", JSON.stringify({ slice: envelope.slice, ...envelope.measurement, results }));
          });
        } finally { await envelope.close(); }
        expect(resources.evidence.every(value => value.resourceLimitReached)).toBe(true);
        const recovered = await prepareExecutionRunEnvelope();
        try { await recovered.run(async () => {
          const worker = await launch("console.log('recovered');setTimeout(()=>process.exit(0),300)");
          worker.child.stdout.resume(); worker.child.stderr.resume();
          expect((await worker.completion).code).toBe(0);
        }); } finally { await recovered.close(); }
        expect(resources.admission.snapshot.active).toBe(0);
      });
    } finally { await cleanup(resources.slice); }
  }, 20_000);

  it("cancels idle prepared roots and removes queued envelopes without releasing an active session", async () => {
    const resources = await fixture();
    try {
      await withExecutionResourceContext(resources, async () => {
        const envelope = await prepareExecutionRunEnvelope();
        const abort = new AbortController();
        const queued = prepareExecutionRunEnvelope({ signal: abort.signal });
        const rejected = expect(queued).rejects.toThrow("cancelled while queued");
        await expect.poll(() => resources.admission.snapshot.queued).toBe(1);
        abort.abort(); await rejected;
        await envelope.run(async () => {
          const ticket = await prepareResourceScopeProcess({ runId: randomUUID(), cwd: process.cwd(),
            nativeLoaderCommand: process.env.PAPERCLIP_TEST_RESOURCE_LOADER! });
          await envelope.close();
          expect(() => ticket.spawn({ command: process.execPath, args: [], cwd: process.cwd(), env: {} })).toThrow("closed or cancelled");
          await ticket.close();
        });
        expect(resources.admission.snapshot).toEqual({ active: 0, usedBytes: 0, queued: 0 });
      });
    } finally { await cleanup(resources.slice); }
  }, 20_000);
});
