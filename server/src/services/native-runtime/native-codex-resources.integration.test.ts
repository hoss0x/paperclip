import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { currentExecutionResources } from "@paperclipai/adapter-utils/execution-resource-context";
import { withHostExecutionResources } from "../host-execution-resources.js";
import type { Db } from "@paperclipai/db";

const fixture = vi.hoisted(() => ({ identity: "", limited: false, release: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", () => ({ createPaperclipRunnerAuthorizedToolSet: vi.fn() }));
vi.mock("./runner-prp-coordinator.js", () => ({
  runnerPrpCoordinator: () => ({ prepare: async () => ({
    connectUrl: "ws://fixture", bootstrapTicket: "fixture-bootstrap-ticket", semanticTools: [],
    queueCommand: () => undefined,
    waitForTerminal: async () => {
      for (let i = 0; i < 500; i++) {
        const observed = await fs.readFile(fixture.identity, "utf8").catch(() => null);
        if (observed && !fixture.limited) {
          process.kill(JSON.parse(observed).pid, "SIGTERM");
          return { terminal: { runTerminalState: "succeeded" }, result: { summary: "fixture completed" }, providerSessionId: "preserved-session" };
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error("fixture terminal deadline");
    },
    release: fixture.release,
  }) }),
}));
import { executeNativeCodexRunner } from "./native-codex-runner.js";

const enabled = process.platform === "linux" && process.env.PAPERCLIP_TEST_SYSTEMD === "1";
(enabled ? describe : describe.skip)("older exported native Codex execution resources", () => {
  it("preserves real PID, arguments/environment and session, cleans descendants, then recovers from OOM", async () => {
    const scratch = process.env.PAPERCLIP_SCRATCH_DIR!;
    const binary = path.join(scratch, "native-runner-resource-fixture");
    fixture.identity = path.join(scratch, "native-runner-identity.json");
    await fs.writeFile(binary, `#!${process.execPath}\nconst fs=require('fs');
const descendant=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
fs.writeFileSync(process.env.FIXTURE_IDENTITY,JSON.stringify({pid:process.pid,descendant:descendant.pid,cgroup:fs.readFileSync('/proc/self/cgroup','utf8'),args:process.argv.slice(2),literal:process.env.FIXTURE_LITERAL,bootstrap:process.env.PAPERCLIP_RUNNER_BOOTSTRAP_TICKET}));
const held=[];setInterval(()=>{if(process.env.FIXTURE_LIMITED==='1')held.push(Buffer.alloc(8*1024*1024,1));},10);
`, { mode: 0o700 });
    const observations: unknown[] = [];
    const run = async (signal?: AbortSignal) => {
      await fs.rm(fixture.identity, { force: true });
      const runId = randomUUID();
      let spawned: { pid: number; processGroupId: number | null } | undefined;
      const execution = executeNativeCodexRunner({ db: {} as Db, companyId: randomUUID(), issueId: randomUUID(), runId,
        agentId: randomUUID(), runnerInstanceId: "fixture-runner", environmentLeaseId: "fixture-lease",
        normalizedSessionId: "original-session", turnId: "fixture-turn", itemId: "fixture-item", cwd: scratch,
        prompt: "fixture", model: "fixture-model", resumeProviderSessionId: "preserved-session",
        completionContract: { revision: "1", criterionIds: [] }, timeoutMs: 10000,
        signal, environment: { FIXTURE_IDENTITY: fixture.identity, FIXTURE_LITERAL: '$HOME "literal"', FIXTURE_LIMITED: fixture.limited ? "1" : "0" },
        runnerBinary: binary, runtimeRoot: path.join(scratch, "native-fixture-state"),
        onLog: async () => {}, onSpawn: async meta => { spawned = meta; },
      });
      try { return await execution; }
      finally {
        const identity = await fs.readFile(fixture.identity, "utf8").catch(() => null);
        if (identity === null) {
          expect(spawned).toBeUndefined();
        } else {
          const observed = JSON.parse(identity);
          observations.push(observed);
          expect(spawned?.pid).toBe(observed.pid);
          expect(spawned?.processGroupId).toBeNull();
          expect(observed.cgroup).toContain(".service");
          expect(observed.cgroup).not.toContain("paperclipai.service");
          expect(observed.literal).toBe('$HOME "literal"');
          expect(observed.bootstrap).toBe("fixture-bootstrap-ticket");
          expect(observed.args).toContain(runId);
          const stat = await fs.readFile(`/proc/${observed.descendant}/stat`, "utf8").catch(() => null);
          expect(stat === null || stat.split(") ")[1]?.startsWith("Z")).toBe(true);
        }
      }
    };
    expect(await run()).toMatchObject({ exitCode: 0, sessionDisplayId: "preserved-session" });
    fixture.limited = true;
    try { await expect(run()).rejects.toMatchObject({ code: "execution_resource_limit" }); }
    finally { fixture.limited = false; }
    expect(await run()).toMatchObject({ exitCode: 0 });
    await withHostExecutionResources(undefined, async () => {
      const resources = currentExecutionResources()!;
      const release = await resources.admission.acquire(resources.policy.memoryMaxBytes);
      const cancellation = new AbortController();
      const timer = setTimeout(() => cancellation.abort(), 50);
      try { await expect(run(cancellation.signal)).rejects.toThrow("cancelled while queued"); }
      finally { clearTimeout(timer); release(); }
    });
    expect(fixture.release).toHaveBeenCalledTimes(4);
    await fs.writeFile(path.join(scratch, "older-native-identities.json"), JSON.stringify(observations));
  }, 40_000);
});
