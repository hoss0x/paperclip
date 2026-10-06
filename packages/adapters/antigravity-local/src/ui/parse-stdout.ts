import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function count(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0; }

export function parseAntigravityStdoutLine(line: string, ts: string): TranscriptEntry[] {
  try {
    const event = record(JSON.parse(line));
    if (event.event === "init") return [{ kind: "init", ts, sessionId: text(event.conversation_id), model: text(record(event.init).model) }];
    if (event.event === "step_update") {
      const step = record(event.step_update);
      if (step.step_type === "agent_response" && typeof step.text_delta === "string") return [{ kind: "assistant", ts, text: step.text_delta, delta: true }];
      if (step.step_type === "tool") {
        const info = record(step.tool_info);
        const id = String(step.step_index);
        const name = text(step.tool_name) || text(info.name) || "tool";
        const call: TranscriptEntry = { kind: "tool_call", ts, name, toolUseId: id, input: info.parameters ?? {} };
        if (step.state === "DONE") {
          return [call, { kind: "tool_result", ts, toolUseId: id, toolName: name, content: typeof info.output === "string" ? info.output : JSON.stringify(info.error ?? info.output ?? ""), isError: Boolean(info.error) }];
        }
        return [call];
      }
    }
    if (event.event === "result") {
      const result = record(event.result);
      const usage = record(result.usage);
      return [{ kind: "result", ts, text: text(result.response), isError: result.status !== "SUCCESS", errors: text(result.error) ? [text(result.error)] : [], inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens), cachedTokens: count(usage.cache_read_tokens), costUsd: 0, subtype: text(result.status) || "ERROR" }];
    }
  } catch { /* Preserve diagnostics verbatim. */ }
  return [{ kind: "stdout", ts, text: line }];
}
