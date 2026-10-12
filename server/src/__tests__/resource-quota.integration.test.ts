import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCodexRpcQuota } from "../../../packages/adapters/codex-local/src/server/quota.js";
import { withExecutionResourceContext } from "@paperclipai/adapter-utils/execution-resource-context";
import { ExecutionResourceAdmission, resolveExecutionResourcePolicy } from "@paperclipai/adapter-utils/execution-resource-policy";
import type { ExecutionResourceEvidence } from "@paperclipai/adapter-utils/systemd-execution";

const enabled = process.platform === "linux" && process.env.PAPERCLIP_TEST_SYSTEMD === "1";
(enabled ? describe : describe.skip)("isolated Codex quota helper", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("preserves quota RPC and cleans detached descendants before returning", async () => {
    const scratchDir = process.env.PAPERCLIP_SCRATCH_DIR!;
    const directory = path.join(scratchDir, `quota-fixture-${randomUUID()}`);
    await fs.mkdir(directory);
    const identityFile = path.join(directory, "identity.json");
    const fixture = `#!${process.execPath}
const fs=require('node:fs');
const descendant=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}).pid;
fs.writeFileSync(process.env.QUOTA_FIXTURE_IDENTITY,JSON.stringify({pid:process.pid,descendant,args:process.argv.slice(2),cgroup:fs.readFileSync('/proc/self/cgroup','utf8')}));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line); if(request.id==null)return;
 if(process.env.QUOTA_FIXTURE_FLOOD==='1'){process.stdout.write('x'.repeat(2*1024*1024));return;}
 if(process.env.QUOTA_FIXTURE_OOM==='1'){const b=[];for(let i=0;i<128;i++)b.push(Buffer.alloc(4*1024*1024,1));}
 const result=request.method==='account/rateLimits/read'?{rateLimits:{limitId:'codex',primary:{usedPercent:42,windowDurationMins:300}}}:{};
 console.log(JSON.stringify({id:request.id,result}));
});`;
    await fs.writeFile(path.join(directory, "codex"), fixture, { mode: 0o700 });
    vi.stubEnv("PATH", `${directory}:${process.env.PATH}`);
    vi.stubEnv("QUOTA_FIXTURE_IDENTITY", identityFile);
    const policy = resolveExecutionResourcePolicy({ PAPERCLIP_EXECUTION_MEMORY_MAX_MIB: "96", PAPERCLIP_EXECUTION_MEMORY_HIGH_MIB: "96" }, "linux", 8 * 1024 ** 3);
    const evidence: ExecutionResourceEvidence[] = [];
    const resources = { scratchDir, policy, admission: new ExecutionResourceAdmission(policy.memoryMaxBytes, 1),
      onEvidence: async (item: ExecutionResourceEvidence) => { evidence.push(item); } };
    const snapshot = await withExecutionResourceContext(resources, fetchCodexRpcQuota);
    expect(snapshot.windows[0]?.usedPercent).toBe(42);
    const identity = JSON.parse(await fs.readFile(identityFile, "utf8"));
    expect(identity.args).toEqual(["-s", "read-only", "-a", "untrusted", "app-server"]);
    expect(identity.cgroup).toContain("paperclip-execution-quota-");
    expect(identity.cgroup).not.toContain("paperclipai.service");
    const stat = await fs.readFile(`/proc/${identity.descendant}/stat`, "utf8").catch(() => null);
    expect(stat === null || stat.split(") ")[1]?.startsWith("Z")).toBe(true);
    expect(resources.admission.snapshot.active).toBe(0);
    expect(evidence).toHaveLength(1);
    vi.stubEnv("QUOTA_FIXTURE_OOM", "1");
    await expect(withExecutionResourceContext(resources, fetchCodexRpcQuota)).rejects.toThrow();
    expect(evidence.at(-1)?.resourceLimitReached).toBe(true);
    expect(resources.admission.snapshot.active).toBe(0);
    vi.stubEnv("QUOTA_FIXTURE_OOM", "0");
    expect((await withExecutionResourceContext(resources, fetchCodexRpcQuota)).windows[0]?.usedPercent).toBe(42);
    vi.stubEnv("QUOTA_FIXTURE_FLOOD", "1");
    await expect(withExecutionResourceContext(resources, fetchCodexRpcQuota)).rejects.toThrow("output limit");
    expect(evidence.at(-1)?.resourceLimitReached).toBe(false);
    expect(resources.admission.snapshot.active).toBe(0);
    await fs.writeFile(path.join(scratchDir, "quota-resource-evidence.json"), JSON.stringify({ identity, evidence, finalAdmission: resources.admission.snapshot }, null, 2));
    await fs.rm(directory, { recursive: true, force: true });
  }, 30_000);
});
