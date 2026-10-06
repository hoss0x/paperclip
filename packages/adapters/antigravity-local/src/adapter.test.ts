import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute, buildArgs, validateConfig, sessionCodec, parseAntigravityJsonl, parseModels, testEnvironment } from "./server/index.js";
import { buildAntigravityLocalConfig, parseAntigravityStdoutLine } from "./ui/index.js";
import { runningProcesses } from "@paperclipai/adapter-utils/server-utils";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(process.env.PAPERCLIP_SCRATCH_DIR || os.tmpdir(), "antigravity-test-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
async function fixture(body: string) {
  const file = path.join(dir, "agy");
  await fs.writeFile(file, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return file;
}
function context(command: string, config = {}): AdapterExecutionContext {
  return {
    runId: randomUUID(), agent: { id: "agent", companyId: "company", name: "Test", adapterType: "antigravity_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "task" },
    config: { command, cwd: dir, paperclipRuntimeSkills: [], ...config },
    context: { taskId: "task", paperclipTaskMarkdown: "Run this task" },
    authToken: "test-run-token", onLog: async () => {},
  };
}
const success = { conversation_id: "native-conversation", status: "SUCCESS", response: "Completed", usage: { input_tokens: 12, output_tokens: 8, cache_read_tokens: 4 } };
describe("Antigravity native CLI adapter", () => {
  it("builds native streaming input flags and pins the selected model and conversation", () => {
    expect(buildArgs({ model: "account-flash-slug", extraArgs: ["--effort", "medium"] }, "conversation")).toEqual([
      "--effort", "medium", "--input-format", "stream-json", "--output-format", "stream-json", "--print-timeout", "0", "--model", "account-flash-slug", "--conversation", "conversation",
    ]);
    expect(buildArgs({}, null)).not.toContain("--model");
    expect(buildArgs({}, null)).not.toContain("--dangerously-skip-permissions");
    expect(buildArgs({ dangerouslySkipPermissions: true }, null)).toContain("--dangerously-skip-permissions");
  });
  it.each([{ engine: "acp" }, { timeoutSec: -1 }, { timeoutSec: NaN }, { model: 1 }, { extraArgs: ["--model=another"] }, { extraArgs: ["-p", "secret"] }, { extraArgs: ["--continue"] }, { extraArgs: ["--effort"] }, { env: { PAPERCLIP_API_KEY: "forged" } }])("rejects invalid config and protocol overrides %j", config => {
    expect(() => validateConfig(config)).toThrow();
  });
  it("delivers prompt/context over stdin, env secrets, workspace and model, and redacts invocation env", async () => {
    const file = await fixture(`let input = ''; process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => {
      const prompt = JSON.parse(input).message.content;
      console.log(JSON.stringify({event:'result',result:{...${JSON.stringify(success)}, response:JSON.stringify({prompt,cwd:process.cwd(),model:process.argv[process.argv.indexOf('--model')+1],secret:process.env.EXAMPLE_SECRET,token:process.env.PAPERCLIP_API_KEY,task:process.env.PAPERCLIP_TASK_ID})}}));
    });`);
    const ctx = context(file, { cwd: "/wrong/fallback", model: "account-flash-slug", env: { EXAMPLE_SECRET: "hidden-value" } });
    ctx.context.paperclipWorkspace = { cwd: dir, source: "project_workspace" };
    const metas: unknown[] = [];
    ctx.onMeta = async meta => { metas.push(meta); };
    const result = await execute(ctx);
    const response = JSON.parse(result.summary!);
    expect(response).toMatchObject({ cwd: dir, model: "account-flash-slug", secret: "hidden-value", token: "test-run-token", task: "task" });
    expect(response.prompt).toContain("Run this task");
    expect(response.prompt).not.toContain("hidden-value");
    expect(JSON.stringify(metas)).not.toContain("hidden-value");
    expect(JSON.stringify(metas)).not.toContain("test-run-token");
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 8, cachedInputTokens: 4 });
    expect(result.usageBasis).toBe("session_cumulative");
  });
  it("resumes only the native conversation from the same workspace and account home", async () => {
    const file = await fixture(`process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({event:'result',result:{...${JSON.stringify(success)},response:JSON.stringify(process.argv.slice(2))}})));`);
    const ctx = context(file);
    ctx.runtime.sessionParams = { sessionId: "previous-native", cwd: dir, accountHome: os.homedir() };
    expect(JSON.parse((await execute(ctx)).summary!)).toContain("previous-native");
    ctx.runtime.sessionParams.cwd = "/other/workspace";
    expect(JSON.parse((await execute(ctx)).summary!)).not.toContain("--conversation");
    ctx.runtime.sessionParams.cwd = dir;
    ctx.runtime.sessionParams.accountHome = "/other/account";
    expect(JSON.parse((await execute(ctx)).summary!)).not.toContain("--conversation");
  });
  it("serializes validated native sessions and rejects missing identity", () => {
    const value = { sessionId: "native", cwd: "/workspace", accountHome: "/home/account" };
    expect(sessionCodec.deserialize(sessionCodec.serialize(value))).toEqual(value);
    expect(sessionCodec.deserialize({ sessionId: "native" })).toBeNull();
    expect(sessionCodec.getDisplayId?.(value)).toBe("native");
  });
  it("fails on a missing executable", async () => {
    await expect(execute(context(path.join(dir, "missing")))).rejects.toThrow();
    const test = await testEnvironment({ companyId: "company", adapterType: "antigravity_local", config: { command: path.join(dir, "missing"), cwd: dir } });
    expect(test.status).toBe("fail");
  });
  it("keeps stdout/stderr and does not treat a partial response as success", async () => {
    const file = await fixture(`console.error('AGY_ERROR: provider unavailable');console.log(JSON.stringify({event:'result',result:{...${JSON.stringify(success)},status:'ERROR',error:'provider unavailable'}}));process.exitCode=3;`);
    const result = await execute(context(file));
    expect(result.exitCode).toBe(3);
    expect(result.errorMessage).toContain("provider unavailable");
    expect(result.resultJson?.stderr).toContain("AGY_ERROR");
    expect(result.resultJson?.stdout).toContain('"event":"result"');
  });
  it("rejects missing terminal result and structured failure even with exit 0", async () => {
    expect((await execute(context(await fixture("console.log('unstructured response')")))).exitCode).toBe(1);
    const file = await fixture(`console.log(JSON.stringify({event:'result',result:{status:'WAITING',response:''}}));`);
    expect((await execute(context(file))).exitCode).toBe(1);
  });
  it("reports a real auth failure without creating a fake session", async () => {
    const file = await fixture(`console.error('Authentication required');process.exitCode=1;`);
    const result = await execute(context(file));
    expect(result.errorCode).toBe("antigravity_auth_required");
    expect(result.sessionParams).toBeNull();
  });
  it("enforces timeout and terminates the process", async () => {
    const file = await fixture("process.on('SIGTERM',()=>{});setInterval(()=>{},1000);");
    const ctx = context(file, { timeoutSec: 0.1, graceSec: 0.05 });
    const result = await execute(ctx);
    expect(result.timedOut).toBe(true);
    expect(runningProcesses.has(ctx.runId)).toBe(false);
  });
  it("cancels with escalation and settles before returning", async () => {
    const file = await fixture("process.on('SIGTERM',()=>{});setInterval(()=>{},1000);");
    const ctx = context(file, { timeoutSec: 5, graceSec: 0.05 });
    const controller = new AbortController();
    ctx.signal = controller.signal;
    ctx.onSpawn = async () => { setTimeout(() => controller.abort(), 100); };
    const result = await execute(ctx);
    expect(result.errorCode).toBe("antigravity_canceled");
    expect(result.signal).toBeTruthy();
    expect(runningProcesses.has(ctx.runId)).toBe(false);
  });
  it("does not spawn when already canceled", async () => {
    const file = await fixture("throw new Error('must not start');");
    const ctx = context(file);
    ctx.signal = AbortSignal.abort();
    expect((await execute(ctx)).errorCode).toBe("antigravity_canceled");
  });
  it("parses only actual model discovery slugs and preserves native event data", () => {
    expect(parseModels("gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\n")).toEqual([{ id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" }]);
    expect(parseModels("Fetching available models...\n  account-flash-high    Flash (High)\n  account-pro    Pro\n")).toEqual([{ id: "account-flash-high", label: "Flash (High)" }, { id: "account-pro", label: "Pro" }]);
    const stdout = JSON.stringify({ event: "init", conversation_id: "native", init: { model: "selected" } }) + "\n" + JSON.stringify({ event: "result", result: success });
    expect(parseAntigravityJsonl(stdout)).toMatchObject({ sessionId: "native-conversation", model: "selected", summary: "Completed" });
    expect(parseAntigravityStdoutLine(JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "Hello" } }), "now")).toEqual([{ kind: "assistant", ts: "now", text: "Hello", delta: true }]);
    expect(parseAntigravityStdoutLine("raw", "now")).toEqual([{ kind: "stdout", ts: "now", text: "raw" }]);
  });
  it("builds serialized UI config including secret references", () => {
    const config = buildAntigravityLocalConfig({ cwd: "/workspace", command: "agy", model: "account-flash", extraArgs: "--effort, medium", envVars: "FOO=bar", envBindings: { SECRET: { type: "secret_ref", secretId: "secret", version: "latest" } }, antigravitySkipPermissions: true } as never);
    expect(config).toMatchObject({ engine: "cli", command: "agy", model: "account-flash", timeoutSec: 900, dangerouslySkipPermissions: true, extraArgs: ["--effort", "medium"] });
    expect(JSON.parse(JSON.stringify(config))).toEqual(config);
    expect(config.env).toMatchObject({ SECRET: { type: "secret_ref", secretId: "secret", version: "latest" } });
  });
});
