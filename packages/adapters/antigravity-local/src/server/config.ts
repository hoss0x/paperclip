import path from "node:path";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

const reserved = new Set([
  "-p", "--print", "--prompt", "-i", "--prompt-interactive", "--input-format",
  "--output-format", "--conversation", "--continue", "-c", "--model",
  "--print-timeout", "--remote-control", "--project", "--new-project",
  "--dangerously-skip-permissions",
]);
export function validateConfig(config: Record<string, unknown>): void {
  if (config.engine != null && config.engine !== "cli") throw new Error("Antigravity supports engine=cli only; native ACP is not advertised.");
  for (const key of ["command", "model", "cwd", "instructionsFilePath", "promptTemplate", "bootstrapPromptTemplate"]) {
    if (config[key] != null && typeof config[key] !== "string") throw new Error(`${key} must be a string`);
  }
  if (config.cwd && !path.isAbsolute(config.cwd as string)) throw new Error("cwd must be an absolute path");
  for (const key of ["timeoutSec", "graceSec"]) {
    if (config[key] != null && (typeof config[key] !== "number" || !Number.isFinite(config[key]) || (config[key] as number) < 0)) throw new Error(`${key} must be a non-negative finite number`);
  }
  if (config.dangerouslySkipPermissions != null && typeof config.dangerouslySkipPermissions !== "boolean") throw new Error("dangerouslySkipPermissions must be boolean");
  if (config.env != null && (typeof config.env !== "object" || Array.isArray(config.env))) throw new Error("env must be an object");
  for (const [key, value] of Object.entries(parseObject(config.env))) {
    if (typeof value !== "string") throw new Error(`env.${key} must be a resolved string`);
  }
  if (config.extraArgs != null && (!Array.isArray(config.extraArgs) || config.extraArgs.some((arg: unknown) => typeof arg !== "string"))) throw new Error("extraArgs must be a string array");
  const args = (config.extraArgs ?? []) as string[];
  const flagsWithValue = new Set(["--effort", "--mode", "--agent", "--add-dir", "--json-schema", "--log-file"]);
  const switches = new Set(["--sandbox", "--disable-slash-commands"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const flag = arg.split("=", 1)[0];
    if (reserved.has(flag) || (!flagsWithValue.has(flag) && !switches.has(flag))) throw new Error(`Unsupported or adapter-owned extra argument: ${arg}`);
    if (flagsWithValue.has(flag) && !arg.includes("=")) {
      const value = args[++i];
      if (!value || value.startsWith("-")) throw new Error(`Missing value for ${flag}`);
    }
  }
}
export function buildArgs(config: Record<string, unknown>, sessionId: string | null): string[] {
  validateConfig(config);
  const args = [...((config.extraArgs ?? []) as string[]), "--input-format", "stream-json", "--output-format", "stream-json", "--print-timeout", "0"];
  const model = asString(config.model, "").trim();
  if (model) args.push("--model", model);
  if (sessionId) args.push("--conversation", sessionId);
  if (config.dangerouslySkipPermissions === true) args.push("--dangerously-skip-permissions");
  return args;
}
