# Antigravity CLI adapter

Paperclip exposes Google's native Antigravity CLI as **Antigravity CLI**
(`antigravity_local`). It runs `agy`, not `gemini`. The initial adapter supports
host-local execution and the CLI engine. SSH and sandbox targets are rejected.
Existing adapters keep their execution and permission defaults.

## Verified interface

Verified on 2026-10-06 against the official Linux amd64 release manifest version
**1.3.0**, its SHA-512-verified binary, and the official documentation:

- [Installation and authentication](https://antigravity.google/docs/cli/install)
- [Headless input, output, models, sessions and permissions](https://antigravity.google/docs/cli/headless)
- [CLI reference](https://antigravity.google/docs/cli/reference)
- [Conversation resume](https://antigravity.google/docs/cli/commands/resume/)

The official Unix installer is `https://antigravity.google/cli/install.sh`.
It installs the native executable as `~/.local/bin/agy` by default. It selects
a platform manifest, checks SHA-512, and extracts the native release. Do not
install an unrelated npm package or alias Gemini CLI to `agy`.

The installed `agy --help` advertises `--print`, `--input-format stream-json`,
`--output-format stream-json`, `--model`, `--conversation`, `--print-timeout`,
`--sandbox`, `--dangerously-skip-permissions`, and the `models` subcommand.
It does not advertise native ACP. This adapter offers only `engine: "cli"` and
rejects other engine values. MCP support does not establish ACP support.

The adapter sends one NDJSON `user` message to stdin, then closes stdin. The CLI
finishes that turn and exits. It writes `init`, `step_update`, and `result`
events to stdout; diagnostics go to stderr. Paperclip records both streams,
the invocation, the final response, and the native token usage. It never runs
model output as adapter code. The terminal result must have status `SUCCESS`
and process exit code zero. Missing terminal output, other statuses, nonzero
exits, signals, and timeouts fail the run. Partial text is retained on failure.
The native `conversation_id` is persisted with the workspace and credential
home. Paperclip resumes with `--conversation ID` only when both match. It never
uses the shared workspace-wide `--continue` cache, invents a session, or retries
an unverified session failure by silently discarding context.

The installed help specifies `--print-timeout 0` as unlimited. Paperclip owns
the timeout, passes that flag, sends SIGTERM to the process group, and escalates
to SIGKILL after `graceSec`. Cancellation uses the same process lifecycle and
waits for the process to settle. This differs from older documentation that
shows a five-minute native default.

## Configure an agent

Select **Antigravity CLI**. Set the executable, working directory, model,
run timeout, environment/secret bindings, and supported extra arguments through
the normal local-agent form. The engine is the native CLI. The command defaults
to `agy`; an absolute executable path also works. The task execution workspace
wins over the fallback working directory. A configured working directory takes
precedence over an agent-home fallback.

Example adapter configuration (fill `model` from your account's model list):

```json
{
  "engine": "cli",
  "command": "agy",
  "cwd": "/absolute/project/workspace",
  "timeoutSec": 900,
  "graceSec": 15,
  "dangerouslySkipPermissions": false,
  "extraArgs": ["--effort", "medium"]
}
```

Model discovery runs `agy models` with the host's cached account. The adapter
parses the returned slug and label table; it ships no guessed Gemini or Flash
IDs. For another command or credential home, run that command's `models` query
with that environment and enter the returned slug manually. Operators can also
use `PAPERCLIP_ADAPTER_MODELS`. A selected model is passed unchanged to `--model`.
The live account must expose a Flash slug before Flash validation can succeed.

Environment secrets use Paperclip's existing binding resolver. The adapter
passes resolved values to the process and redacts invocation metadata. It preserves
server-injected runtime variables and sets the authoritative run, agent, task,
and authentication fields during dispatch.
Instructions files and selected skill paths enter the prompt; skills stay in
the managed source directories. No internal files are copied into the project.

`extraArgs` accepts `--effort`, `--mode`, `--agent`, `--add-dir`, `--json-schema`,
`--log-file`, `--sandbox`, and `--disable-slash-commands`. Adapter-owned prompt,
input, output, model, resume, timeout, permission, and remote-control flags cannot
be overridden. Quote arguments as separate array elements in API configuration.

## Authentication and permissions

The CLI uses Google account credentials saved by an interactive `agy` login.
Gemini API keys do not substitute for this login. Authenticate as the OS user
that runs Paperclip, with the same HOME as the agent's process. Do not place
Google credentials in the task, prompt, or environment configuration.

Permissions come from the CLI's account/project settings. Headless tools that
need approval can be denied while the CLI still returns a successful response.
For unattended work, configure scoped `permissions.allow` rules in
`~/.gemini/antigravity-cli/settings.json`. The adapter does not alter that file.
The separate **Auto-approve all tools** switch explicitly passes
`--dangerously-skip-permissions`; it is off by default. Paperclip's normal
control-plane authorization, budgets, audit logs, and secret resolution remain
in force.

## Validation

Authentication was completed on the VPS as the Paperclip OS user. On
2026-10-06, `agy models` returned the account model list, including
`gemini-3.8-flash-medium`. This returned Flash model is used for the live
Paperclip qualification. Model IDs can change; always discover the current
account list rather than copying this example into a deployment.

The automated suite uses executable fixtures to test process invocation, stdin,
model handling, resolved environment, metadata redaction, workspace precedence,
session identity, errors, missing executable, timeout, cancellation, config
serialization, secret bindings, discovery parsing, and transcript parsing.
Fixtures prove integration mechanics. The live qualification checks the
Paperclip heartbeat engine, native `agy` execution, selected Flash model,
workspace tool execution, and recorded response.

Before authentication, the installed CLI emitted an OAuth request on stderr,
waited for authorization with redirected stdin, and exited **1** with an
`ERROR` terminal result when authentication timed out. Authenticate
interactively as the Paperclip OS user before unattended execution:

```sh
~/.local/bin/agy
```

Complete the Google browser sign-in, then verify `agy models`.
