export const type = "antigravity_local";
export const label = "Antigravity CLI";
// Account-dependent slugs come from `agy models`; no guessed Gemini model IDs.
export const models: { id: string; label: string }[] = [];
export const agentConfigurationDoc = `# Antigravity CLI

Runs Google's native agy CLI on the Paperclip host. Install from
https://antigravity.google/docs/cli/install and sign in by running agy as the
same OS user as Paperclip. Gemini API keys are not Antigravity login credentials.

Configuration:
- engine: cli (the only supported engine; native ACP is not advertised by agy 1.3.0).
- command: executable, defaults to agy. Absolute paths are accepted.
- model: exact account-visible slug from agy models; omitted uses the CLI default.
- cwd: absolute workspace fallback; task/project execution workspace takes precedence.
- instructionsFilePath: Markdown instructions prepended to the task prompt.
- promptTemplate and bootstrapPromptTemplate: standard Paperclip templates.
- env: environment/secret bindings resolved by Paperclip; never put secrets in prompts.
- extraArgs: string array; cannot override prompt, output, model, resume or timeout flags.
- timeoutSec: process timeout (default 900 seconds, 0 disables it).
- graceSec: SIGTERM to SIGKILL grace period (default 15 seconds).
- dangerouslySkipPermissions: false by default. Explicitly enables agy's
  --dangerously-skip-permissions (all tool calls). Prefer scoped permissions.allow
  rules in ~/.gemini/antigravity-cli/settings.json for unattended command execution.

Uses stream-json stdin/output, stores native conversation_id with its cwd and
account home, resumes only a matching workspace/account home, and records usage
as session-cumulative. No fake sessions, usage pricing, or ACP fallback.
Model discovery uses agy models on the host with its cached account. For custom
commands/accounts, enter the exact slug manually or declare PAPERCLIP_ADAPTER_MODELS.
SSH and sandbox execution targets are not supported in this initial adapter.
`;
