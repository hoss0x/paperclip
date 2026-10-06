import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
export function parseAntigravityJsonl(stdout: string): { sessionId: string | null; model: string | null; result: Record<string, unknown> | null; summary: string; usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } } {
  let sessionId: string | null = null;
  let result: Record<string, unknown> | null = null;
  let model: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const event = parseObject(JSON.parse(line));
      if (event.event === "init") {
        sessionId = asString(event.conversation_id, "").trim() || null;
        model = asString(parseObject(event.init).model, "").trim() || null;
      }
      if (event.event === "result") {
        result = parseObject(event.result);
        sessionId = asString(result.conversation_id, "").trim() || sessionId;
      }
    } catch { /* Raw diagnostics remain in the run log. */ }
  }
  const usage = parseObject(result?.usage);
  const count = (key: string) => typeof usage[key] === "number" && Number.isFinite(usage[key]) && usage[key] >= 0 ? usage[key] : 0;
  return { sessionId, model, result, summary: asString(result?.response, ""), usage: {
    inputTokens: count("input_tokens"), outputTokens: count("output_tokens"), cachedInputTokens: count("cache_read_tokens"),
  } };
}
export function parseModels(stdout: string): { id: string; label: string }[] {
  const models = new Map<string, string>();
  for (const line of stdout.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    const match = /^\s*([a-z0-9][a-z0-9._-]+)(?:\t+| {2,})(.+?)\s*$/.exec(line);
    if (match) models.set(match[1], match[2]);
  }
  return [...models].map(([id, label]) => ({ id, label }));
}
