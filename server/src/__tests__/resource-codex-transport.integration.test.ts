import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { executeWithResourceGovernance } from "../services/execution-resources.js";
import { createResourceCodexTransport } from "../services/native-runtime/resource-codex-transport.js";

const enabled = process.platform === "linux" && process.env.PAPERCLIP_TEST_SYSTEMD === "1";
const slice = `paperclip-stdio-${randomUUID()}.slice`;
const execFileAsync = promisify(execFile);
function context() {
  const scratchDir = process.env.PAPERCLIP_SCRATCH_DIR;
  if (!scratchDir) throw new Error("Tests require run-owned scratch");
  return { scratchDir, slice, signal: new AbortController().signal, record: async () => {} };
}
const echo = `const fs=require('node:fs');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);const descendant=request.method==='descendant'?require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}).pid:null;console.log(JSON.stringify({id:request.id,result:{method:request.method,pid:process.pid,
 cgroup:fs.readFileSync('/proc/self/cgroup','utf8'),descendant,secret:process.env.PRIVATE_LITERAL,jobs:process.env.CARGO_BUILD_JOBS}}));});`;

(enabled ? describe : describe.skip)("resource-governed native Codex stdio transport", () => {
  afterAll(async () => { await execFileAsync("systemctl", ["--user", "stop", slice], { timeout: 5_000 }); });

  it("keeps JSON-RPC streams, exact environment and real process ownership", async () => {
    await executeWithResourceGovernance(context(), async () => {
      const factory = createResourceCodexTransport(randomUUID());
      expect(factory).toBeTypeOf("function");
      const transport = await factory!({ command: process.execPath, args: ["-e", echo], workingDirectory: process.cwd(),
        environment: { PATH: process.env.PATH, PRIVATE_LITERAL: '$HOME "literal"\nvalue' } });
      let descendant = 0;
      try {
        const response = await transport.request("initialize", { clientInfo: { name: "fixture" } });
        expect(response).toMatchObject({ method: "initialize", secret: '$HOME "literal"\nvalue', jobs: "1" });
        expect(response.cgroup).toContain(slice);
        expect(response.cgroup).not.toContain("paperclipai.service");
        expect(transport.processInfo?.()).toMatchObject({ pid: response.pid, processGroupId: null, exited: false });
        expect((await transport.request("thread/resume", { threadId: "preserved" })).method).toBe("thread/resume");
        descendant = Number((await transport.request("descendant", {})).descendant);
      } finally { await transport.close(); }
      expect(descendant).toBeGreaterThan(0);
      const stat = await fs.readFile(`/proc/${descendant}/stat`, "utf8").catch(() => null);
      expect(stat === null || stat.split(") ")[1]?.startsWith("Z")).toBe(true);
      expect(transport.processInfo?.().exited).toBe(true);
      return { exitCode: 0, signal: null, timedOut: false };
    });
  }, 20_000);

  it("cancels an admitted native startup while it is queued, without launching", async () => {
    await executeWithResourceGovernance(context(), async () => {
      const factory = createResourceCodexTransport(randomUUID())!;
      const first = await factory({ command: process.execPath, args: ["-e", echo], workingDirectory: process.cwd(), environment: process.env });
      const cancellation = new AbortController();
      const queued = factory({ command: process.execPath, args: ["-e", echo], workingDirectory: process.cwd(), environment: process.env, launchSignal: cancellation.signal });
      const failed = expect(queued).rejects.toThrow("cancelled while queued");
      cancellation.abort();
      await failed;
      await first.close();
      return { exitCode: 0, signal: null, timedOut: false };
    });
  }, 20_000);

  it("records memory-limit failure before closing the transport and recovers", async () => {
    const result = await executeWithResourceGovernance(context(), async () => {
      const transport = await createResourceCodexTransport(randomUUID())!({ command: process.execPath,
        args: ["-e", "process.stdin.once('data',()=>{const b=[];for(let i=0;i<128;i++)b.push(Buffer.alloc(4*1024*1024,1));});"],
        workingDirectory: process.cwd(), environment: process.env });
      await expect(transport.request("initialize", {})).rejects.toThrow();
      await transport.close();
      return { exitCode: 0, signal: null, timedOut: false };
    });
    expect(result.errorCode).toBe("execution_resource_limit");
    await executeWithResourceGovernance(context(), async () => {
      const transport = await createResourceCodexTransport(randomUUID())!({ command: process.execPath, args: ["-e", echo], workingDirectory: process.cwd(), environment: process.env });
      expect((await transport.request("initialize", {})).method).toBe("initialize");
      await transport.close();
      return { exitCode: 0, signal: null, timedOut: false };
    });
  }, 20_000);
});
