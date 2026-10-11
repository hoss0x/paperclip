import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { decideCodexAuthMerge } from "@paperclipai/adapter-codex-local/server";
import { decideGrokAuthMerge } from "@paperclipai/adapter-grok-local/server";
import { ExecutionResourceAdmission, resolveExecutionResourcePolicy } from "@paperclipai/adapter-utils/execution-resource-policy";
import { withExecutionResourceContext } from "@paperclipai/adapter-utils/execution-resource-context";
import type { ExecutionResourceEvidence } from "@paperclipai/adapter-utils/systemd-execution";

const enabled = process.platform === "linux" && process.env.PAPERCLIP_TEST_SYSTEMD === "1";
(enabled ? describe : describe.skip)("credential merge helper isolation", () => {
  for (const [provider, decide] of [["Codex", decideCodexAuthMerge], ["Grok", decideGrokAuthMerge]] as const) {
    it(`${provider} preserves predicate exits and worker membership`, async () => {
      await fixture(async ({ run, marker, evidence }) => {
        expect(await run(decide)).toBe(10);
        const identity = JSON.parse(await fs.readFile(marker, "utf8"));
        expect(identity.cgroup).toContain("paperclip-execution-");
        expect(identity.cgroup).toContain(".scope");
        expect(identity.args.slice(-2)).toEqual(["fixture-source", "fixture-destination"]);
        expect(identity.token).toBe("fixture-env");
        expect(evidence).toHaveLength(1);
        expect(evidence[0]?.resourceLimitReached).toBe(false);
      });
    }, 20_000);

    it(`${provider} contains an over-budget predicate and allows later recovery`, async () => {
      await fixture(async ({ run, evidence }) => {
        vi.stubEnv("RESOURCE_AUTH_MODE", "oom");
        await expect(run(decide)).rejects.toMatchObject({ code: "execution_resource_limit" });
        expect(evidence.some(item => item.resourceLimitReached)).toBe(true);
        vi.stubEnv("RESOURCE_AUTH_MODE", "normal");
        expect(await run(decide)).toBe(10);
        expect(evidence.at(-1)?.resourceLimitReached).toBe(false);
      });
    }, 20_000);
  }
});

async function fixture(execute: (input: {
  run: (decide: typeof decideCodexAuthMerge | typeof decideGrokAuthMerge) => Promise<number>;
  marker: string;
  evidence: ExecutionResourceEvidence[];
}) => Promise<void>) {
  const directory = await fs.mkdtemp(path.join(process.env.PAPERCLIP_SCRATCH_DIR!, "auth-merge-"));
  const marker = path.join(directory, "identity.json");
  const evidence: ExecutionResourceEvidence[] = [];
  const policy = resolveExecutionResourcePolicy({ PAPERCLIP_EXECUTION_ISOLATION: "systemd",
    PAPERCLIP_EXECUTION_MEMORY_MAX_MIB: "96", PAPERCLIP_EXECUTION_MEMORY_HIGH_MIB: "96",
    PAPERCLIP_EXECUTION_CAPACITY_MIB: "192" });
  const admission = new ExecutionResourceAdmission(policy.capacityBytes, 1);
  // A retained agent already owns the sole agent slot. Its predicate needs the
  // separate helper slot, while both still count toward aggregate memory.
  const release = await admission.acquire(policy.memoryMaxBytes);
  await fs.writeFile(path.join(directory, "node"), `#!${process.execPath}
const fs=require('node:fs');
fs.writeFileSync(process.env.RESOURCE_AUTH_MARKER,JSON.stringify({pid:process.pid,
 cgroup:fs.readFileSync('/proc/self/cgroup','utf8'),args:process.argv.slice(2),token:process.env.RESOURCE_AUTH_TOKEN}));
if(process.env.RESOURCE_AUTH_MODE==='oom'){const held=[];setInterval(()=>held.push(Buffer.alloc(16*1024*1024,1)),20)}
else setTimeout(()=>process.exit(10),100);
`, { mode: 0o700 });
  vi.stubEnv("PATH", directory + path.delimiter + process.env.PATH);
  vi.stubEnv("RESOURCE_AUTH_MARKER", marker);
  vi.stubEnv("RESOURCE_AUTH_TOKEN", "fixture-env");
  vi.stubEnv("RESOURCE_AUTH_MODE", "normal");
  try {
    await execute({ marker, evidence, run: decide => withExecutionResourceContext({
      runId: randomUUID(), policy, admission, scratchDir: directory,
      nativeLoaderCommand: () => process.env.PAPERCLIP_RUNNER_BINARY!,
      onEvidence: async item => { evidence.push(item); },
    }, () => decide("fixture-source", "fixture-destination", { errorLabel: "Fixture" })) });
    expect(admission.snapshot).toMatchObject({ active: 1, usedBytes: policy.memoryMaxBytes });
  } finally { release(); vi.unstubAllEnvs(); await fs.rm(directory, { recursive: true, force: true }); }
}
