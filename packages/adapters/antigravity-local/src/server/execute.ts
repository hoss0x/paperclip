import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { adapterExecutionTargetIsRemote, readAdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import {
  asString, asNumber, parseObject, buildPaperclipEnv, buildRuntimeToolsEnv,
  ensureAbsoluteDirectory, ensureCommandResolvable, ensurePathInEnv, redactEnvForLogs,
  runChildProcess, runningProcesses, signalRunningProcess, renderTemplate,
  joinPromptSections, hydrateFreshSessionHandoff, selectPaperclipPromptSections,
  selectInitialCommunicationGuidance, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE, readPaperclipRuntimeSkillEntries,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { validateConfig, buildArgs } from "./config.js";
import { parseAntigravityJsonl } from "./parse.js";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, context, runtime, agent, runId, onLog } = ctx;
  validateConfig(config);
  if (adapterExecutionTargetIsRemote(readAdapterExecutionTarget(ctx))) throw new Error("Antigravity CLI currently supports local execution only.");
  const workspace = parseObject(context.paperclipWorkspace);
  const configuredCwd = asString(config.cwd, "").trim();
  const cwd = path.resolve((workspace.source === "agent_home" && configuredCwd ? configuredCwd : asString(workspace.cwd, "").trim()) || configuredCwd || process.cwd());
  await ensureAbsoluteDirectory(cwd);
  const env: Record<string, string> = {
    ...parseObject(config.env) as Record<string, string>,
    ...buildPaperclipEnv(agent), ...buildRuntimeToolsEnv(ctx.runtimeTools),
    PAPERCLIP_RUN_ID: runId,
    PAPERCLIP_WORKSPACE_CWD: cwd,
  };
  // Optional context fields must not inherit stale configuration values. Keep
  // server-resolved runtime variables, such as scratch paths, intact.
  for (const key of ["PAPERCLIP_TASK_ID", "PAPERCLIP_WAKE_REASON", "PAPERCLIP_WAKE_COMMENT_ID", "PAPERCLIP_APPROVAL_ID", "PAPERCLIP_APPROVAL_STATUS", "PAPERCLIP_LINKED_ISSUE_IDS"]) delete env[key];
  const taskId = asString(context.taskId, asString(context.issueId, "")).trim();
  if (taskId) env.PAPERCLIP_TASK_ID = taskId;
  for (const [key, value] of Object.entries({
    PAPERCLIP_WAKE_REASON: context.wakeReason,
    PAPERCLIP_WAKE_COMMENT_ID: context.wakeCommentId ?? context.commentId,
    PAPERCLIP_APPROVAL_ID: context.approvalId,
    PAPERCLIP_APPROVAL_STATUS: context.approvalStatus,
  })) if (typeof value === "string" && value) env[key] = value;
  if (Array.isArray(context.issueIds)) {
    const linkedIds = context.issueIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim()));
    if (linkedIds.length) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIds.join(",");
  }
  if (ctx.authToken) env.PAPERCLIP_API_KEY = ctx.authToken;
  const command = asString(config.command, "agy").trim() || "agy";
  await ensureCommandResolvable(command, cwd, ensurePathInEnv({ ...process.env, ...env }));
  const accountHome = path.resolve(env.HOME || os.homedir());
  const saved = parseObject(runtime.sessionParams);
  // Require matching cwd + credential home; never use a workspace-wide --continue cache.
  const sessionId = asString(saved.cwd, "") === cwd && asString(saved.accountHome, "") === accountHome
    ? asString(saved.sessionId, "").trim() || null : null;
  await hydrateFreshSessionHandoff(ctx, { resumedSession: Boolean(sessionId) });
  const { wakePrompt, taskContextNote } = selectPaperclipPromptSections(context, { resumedSession: Boolean(sessionId), includeCommunicationGuidance: false });
  const data = { agent, context, agentId: agent.id, companyId: agent.companyId, runId, company: { id: agent.companyId }, run: { id: runId, source: "on_demand" } };
  const template = asString(config.promptTemplate, context.paperclipConversation ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const instructionsPath = asString(config.instructionsFilePath, "").trim();
  const instructions = instructionsPath ? `${await fs.readFile(instructionsPath, "utf8")}\n\nInstructions loaded from ${instructionsPath}. Resolve relative references from ${path.dirname(instructionsPath)}.` : "";
  const entries = await readPaperclipRuntimeSkillEntries(config, path.dirname(fileURLToPath(import.meta.url)));
  const desired = new Set(resolveLegacyPaperclipDesiredSkillNames(config, entries));
  const skills = entries.filter(entry => desired.has(entry.key));
  const skillsNote = skills.length ? "Available skills (read the referenced SKILL.md when needed; use the paperclip skill for coordination):\n" + skills.map(entry => `${entry.runtimeName}: ${path.join(entry.source, "SKILL.md")}`).join("\n") : "";
  const prompt = joinPromptSections([
    instructions, skillsNote,
    !sessionId ? renderTemplate(asString(config.bootstrapPromptTemplate, ""), data) : "",
    selectInitialCommunicationGuidance(context, { resumedSession: Boolean(sessionId) }),
    wakePrompt, taskContextNote, asString(context.paperclipSessionHandoffMarkdown, ""),
    ctx.runtimeTools?.guidance ?? "",
    `Paperclip runtime variables are available in your tool environment: ${Object.keys(env).filter(key => key.startsWith("PAPERCLIP_")).join(", ")}. Read credentials from the environment, never print them.`,
    sessionId && wakePrompt ? "" : renderTemplate(template, data),
  ]);
  const args = buildArgs(config, sessionId);
  await ctx.onMeta?.({ adapterType: "antigravity_local", command, commandArgs: args, cwd, env: redactEnvForLogs(env), prompt });
  const timeoutSec = asNumber(config.timeoutSec, 900);
  const graceSec = asNumber(config.graceSec, 15);
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    const running = runningProcesses.get(runId);
    if (!running) return;
    signalRunningProcess(running, "SIGTERM");
    escalation ??= setTimeout(() => {
      if (runningProcesses.get(runId) === running) signalRunningProcess(running, "SIGKILL");
    }, graceSec * 1000);
  };
  if (ctx.signal?.aborted) return { exitCode: null, signal: "SIGTERM", timedOut: false, errorCode: "antigravity_canceled", errorMessage: "Canceled before dispatch" };
  ctx.signal?.addEventListener("abort", cancel, { once: true });
  try {
    await ctx.onCancellationReady?.();
    const proc = await runChildProcess(runId, command, args, {
      cwd, env, timeoutSec, graceSec, onLog,
      stdin: JSON.stringify({ event: "user", message: { content: prompt } }) + "\n",
      onSpawn: async meta => { await ctx.onSpawn?.(meta); if (ctx.signal?.aborted) cancel(); },
    });
    await ctx.onProviderStopped?.();
    const parsed = parseAntigravityJsonl(proc.stdout);
    const failed = proc.exitCode !== 0 || proc.signal != null || proc.timedOut || parsed.result?.status !== "SUCCESS";
    const diagnostic = asString(parsed.result?.error, "") || proc.stderr.trim() || "Antigravity returned no successful terminal result";
    const id = parsed.sessionId || sessionId;
    return {
      exitCode: proc.exitCode === 0 && failed ? 1 : proc.exitCode, signal: proc.signal, timedOut: proc.timedOut,
      errorMessage: failed ? (proc.timedOut ? `Timed out after ${timeoutSec}s` : diagnostic) : null,
      errorCode: ctx.signal?.aborted ? "antigravity_canceled" : /authentication required|sign in|log in/i.test(diagnostic) && failed ? "antigravity_auth_required" : failed ? "antigravity_run_failed" : null,
      sessionId: id, sessionDisplayId: id, sessionParams: id ? { sessionId: id, cwd, accountHome } : null,
      clearSession: !id && Boolean(saved.sessionId || runtime.sessionId),
      provider: "google", biller: "google", model: parsed.model || asString(config.model, "") || null,
      billingType: "unknown", costUsd: null, usage: parsed.usage, usageBasis: "session_cumulative",
      summary: parsed.summary, resultJson: { ...(parsed.result ?? {}), stdout: proc.stdout, stderr: proc.stderr },
    };
  } finally {
    ctx.signal?.removeEventListener("abort", cancel);
    if (escalation) clearTimeout(escalation);
  }
}
