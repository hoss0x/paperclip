export { execute } from "./execute.js";
export { testEnvironment, listModels } from "./test.js";
export { validateConfig, buildArgs } from "./config.js";
export { parseAntigravityJsonl, parseModels } from "./parse.js";
import type { AdapterSessionCodec, AdapterConfigSchema } from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
function normalize(raw: unknown): Record<string, unknown> | null {
  const value = parseObject(raw);
  const sessionId = asString(value.sessionId, "").trim();
  const cwd = asString(value.cwd, "").trim();
  const accountHome = asString(value.accountHome, "").trim();
  return sessionId && cwd && accountHome ? { sessionId, cwd, accountHome } : null;
}
export const sessionCodec: AdapterSessionCodec = {
  serialize: normalize, deserialize: normalize,
  getDisplayId: params => asString(params?.sessionId, "").trim() || null,
};
export function getConfigSchema(): AdapterConfigSchema {
  return { fields: [
    { key: "engine", label: "Execution engine", type: "select" as const, default: "cli", options: [{ value: "cli", label: "Antigravity CLI" }] },
    { key: "dangerouslySkipPermissions", label: "Auto-approve all tools", type: "toggle" as const, default: false, hint: "Grants all tool requests, including shell commands. Prefer scoped CLI permission rules." },
  ] };
}
