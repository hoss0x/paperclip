import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OpenCodeServerDriver } from "@paperclipai/paperclip-runner";
import { withExecutionResourceContext } from "@paperclipai/adapter-utils/execution-resource-context";
import { ExecutionResourceAdmission, resolveExecutionResourcePolicy } from "@paperclipai/adapter-utils/execution-resource-policy";
import type { ExecutionResourceEvidence } from "@paperclipai/adapter-utils/systemd-execution";
import { createResourceOpenCodeLauncher } from "../services/native-runtime/resource-opencode-launcher.js";

const enabled = process.platform === "linux" && process.env.PAPERCLIP_TEST_SYSTEMD === "1";
async function fixture() {
  const scratch = process.env.PAPERCLIP_SCRATCH_DIR;
  const loader = process.env.PAPERCLIP_TEST_RESOURCE_LOADER;
  if (!scratch || !loader) throw new Error("Tests need run-owned scratch and the rebuilt native runner");
  const root = await fs.mkdtemp(path.join(scratch, "opencode-scope-"));
  const command = path.join(root, "provider.mjs");
  const source = await fs.readFile(new URL("../../../packages/paperclip-runner/test/fixtures/fake-opencode-server.mjs", import.meta.url), "utf8");
  await fs.writeFile(command, source, { mode: 0o700 });
  const descriptor = await fs.open(command, "r");
  const policy = resolveExecutionResourcePolicy({ PAPERCLIP_EXECUTION_MEMORY_MAX_MIB: "128", PAPERCLIP_EXECUTION_MEMORY_HIGH_MIB: "128" }, "linux", 8 * 1024 ** 3);
  const evidence: ExecutionResourceEvidence[] = [];
  const cancellation = new AbortController();
  const resources = { signal: cancellation.signal, policy, scratchDir: root, admission: new ExecutionResourceAdmission(policy.memoryMaxBytes, 1),
    onEvidence: async (value: ExecutionResourceEvidence) => { evidence.push(value); } };
  return { root, command, source, descriptor, loader, resources, evidence,
    cleanup: async () => { cancellation.abort(); await expect.poll(() => resources.admission.snapshot.active, { timeout: 10_000 }).toBe(0); await descriptor.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

(enabled ? describe : describe.skip)("resource-governed OpenCode HTTP driver", () => {
  it("starts through an inherited executable descriptor, recovers the session, and cleans detached children", async () => {
    const f = await fixture();
    const descendantFile = path.join(f.root, "descendant.pid");
    const prelude = `import {spawn as scopeSpawn} from 'node:child_process';import {writeFileSync as scopeWrite} from 'node:fs';
      scopeWrite(${JSON.stringify(descendantFile)},String(scopeSpawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}).pid));\n`;
    await fs.writeFile(f.command, "#!/usr/bin/env node\n" + prelude + f.source.replace(/^#!.*\n/, ""));
    try {
      await withExecutionResourceContext(f.resources, async () => {
        const spawns: number[] = [];
        const driver = new OpenCodeServerDriver({ model: "openrouter/openai/gpt-4.1", runtimeDirectory: path.join(f.root, "runtime"),
          command: `/proc/self/fd/${f.descriptor.fd}`, commandFd: f.descriptor.fd, environment: { PATH: process.env.PATH },
          processLauncher: createResourceOpenCodeLauncher(randomUUID(), () => f.loader),
          onSpawn: async meta => {
            spawns.push(meta.pid);
            expect(meta.processGroupId).toBe(meta.pid);
            const membership = await fs.readFile(`/proc/${meta.pid}/cgroup`, "utf8");
            expect(membership).toContain(".scope"); expect(membership).not.toContain("paperclipai.service");
          } });
        const session = await driver.openSession({ runId: randomUUID(), normalizedSessionId: "scope-session", workingDirectory: f.root });
        const snapshot = await session.snapshot();
        await session.close({ reason: "scope-test" });
        const descendant = Number(await fs.readFile(descendantFile, "utf8"));
        const stat = await fs.readFile(`/proc/${descendant}/stat`, "utf8").catch(() => null);
        expect(stat === null || stat.split(") ")[1]?.startsWith("Z")).toBe(true);
        const recovered = await driver.recoverSession(snapshot);
        expect(recovered.recovered).toBe(true);
        await recovered.session?.close({ reason: "scope-recovery-test" });
        expect(spawns).toHaveLength(2);
        expect(f.evidence).toHaveLength(2);
        expect(f.resources.admission.snapshot.active).toBe(0);
      });
    } finally { await f.cleanup(); }
  }, 30_000);

  it("cancels queued startup before spawning or persisting an OS unit", async () => {
    const f = await fixture();
    const release = await f.resources.admission.acquire(f.resources.policy.memoryMaxBytes);
    try {
      await withExecutionResourceContext(f.resources, async () => {
        const abort = new AbortController();
        const driver = new OpenCodeServerDriver({ model: "openrouter/openai/gpt-4.1", runtimeDirectory: path.join(f.root, "runtime"),
          command: f.command, environment: { PATH: process.env.PATH }, processLauncher: createResourceOpenCodeLauncher(randomUUID(), () => f.loader) });
        const startup = driver.openSession({ runId: randomUUID(), normalizedSessionId: "queued", workingDirectory: f.root, signal: abort.signal });
        const cancelled = expect(startup).rejects.toThrow("cancelled while queued");
        await expect.poll(() => f.resources.admission.snapshot.queued).toBe(1);
        abort.abort(); await cancelled;
        expect(f.evidence).toEqual([]);
        expect(f.resources.admission.snapshot.queued).toBe(0);
      });
    } finally { release(); await f.cleanup(); }
  }, 20_000);
  it("records a provider memory kill and starts a subsequent HTTP session", async () => {
    const f = await fixture();
    const trigger = path.join(f.root, "allocate");
    await fs.writeFile(f.command, "#!/usr/bin/env node\n" +
      `import {existsSync as scopeExists} from 'node:fs';const scopeTimer=setInterval(()=>{if(scopeExists(${JSON.stringify(trigger)})){clearInterval(scopeTimer);const blocks=[];for(let i=0;i<128;i++)blocks.push(Buffer.alloc(4*1024*1024,1));}},20);\n` + f.source.replace(/^#!.*\n/, ""));
    try {
      await withExecutionResourceContext(f.resources, async () => {
        const driver = new OpenCodeServerDriver({ model: "openrouter/openai/gpt-4.1", runtimeDirectory: path.join(f.root, "runtime"),
          command: f.command, environment: { PATH: process.env.PATH }, processLauncher: createResourceOpenCodeLauncher(randomUUID(), () => f.loader) });
        const session = await driver.openSession({ runId: randomUUID(), normalizedSessionId: "limited", workingDirectory: f.root });
        await fs.writeFile(trigger, "start");
        await expect.poll(() => f.evidence[0]?.resourceLimitReached, { timeout: 10_000 }).toBe(true);
        await session.close({ reason: "memory-limit-test" });
        await fs.rm(trigger);
        const successor = await driver.openSession({ runId: randomUUID(), normalizedSessionId: "successor", workingDirectory: f.root });
        expect(successor.ids().providerSessionId).toBe("ses_fake_1");
        await successor.close({ reason: "recovery-after-memory-limit" });
        expect(f.resources.admission.snapshot.active).toBe(0);
      });
    } finally { await f.cleanup(); }
  }, 30_000);

});
