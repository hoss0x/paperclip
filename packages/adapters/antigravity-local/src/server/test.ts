import type { AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { asString, parseObject, ensurePathInEnv, ensureCommandResolvable, runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { adapterExecutionTargetIsRemote } from "@paperclipai/adapter-utils/execution-target";
import { randomUUID } from "node:crypto";
import { validateConfig } from "./config.js";
import { parseModels } from "./parse.js";
export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentTestResult["checks"] = [];
  try {
    validateConfig(ctx.config);
    if (ctx.executionTarget && adapterExecutionTargetIsRemote(ctx.executionTarget)) throw new Error("Only local execution is supported");
    const command = asString(ctx.config.command, "agy") || "agy";
    const cwd = asString(ctx.config.cwd, process.cwd());
    const env = parseObject(ctx.config.env) as Record<string, string>;
    await ensureCommandResolvable(command, cwd, ensurePathInEnv({ ...process.env, ...env }));
    const proc = await runChildProcess(randomUUID(), command, ["--help"], { cwd, env, timeoutSec: 10, graceSec: 1, onLog: async () => {} });
    if (proc.exitCode !== 0 || !proc.stdout.includes("--input-format") || !proc.stdout.includes("--conversation")) throw new Error(proc.stderr || "The executable does not advertise the required Antigravity CLI interface");
    checks.push({ code: "antigravity_cli_available", level: "info", message: "Antigravity headless CLI and conversation resume are available" });
    const models = await runChildProcess(randomUUID(), command, ["models"], { cwd, env, timeoutSec: 10, graceSec: 1, onLog: async () => {} });
    if (models.exitCode !== 0 || !parseModels(models.stdout).length) checks.push({ code: "antigravity_account_unverified", level: "warn", message: "Could not discover account models", detail: models.stderr || models.stdout, hint: "Run agy interactively as the Paperclip OS user, sign in, then retry agy models." });
    else checks.push({ code: "antigravity_models_available", level: "info", message: `${parseModels(models.stdout).length} account models available` });
  } catch (err) { checks.push({ code: "antigravity_setup_error", level: "error", message: err instanceof Error ? err.message : String(err) }); }
  return { adapterType: "antigravity_local", status: checks.some(c => c.level === "error") ? "fail" : checks.some(c => c.level === "warn") ? "warn" : "pass", checks, testedAt: new Date().toISOString() };
}
export async function listModels() {
  try {
    const proc = await runChildProcess(randomUUID(), "agy", ["models"], { cwd: process.cwd(), env: {}, timeoutSec: 10, graceSec: 1, onLog: async () => {} });
    return proc.exitCode === 0 ? parseModels(proc.stdout) : [];
  } catch { return []; }
}
