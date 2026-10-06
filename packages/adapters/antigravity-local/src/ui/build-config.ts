import { buildAdapterEnvConfig, type CreateConfigValues } from "@paperclipai/adapter-utils";
export function buildAntigravityLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const config: Record<string, unknown> = { engine: "cli", timeoutSec: 900, graceSec: 15 };
  for (const key of ["cwd", "model", "command", "instructionsFilePath"] as const) if (v[key]) config[key] = v[key];
  const env = buildAdapterEnvConfig(v.envBindings, v.envVars);
  if (Object.keys(env).length) config.env = env;
  if (v.extraArgs) config.extraArgs = v.extraArgs.split(",").map(arg => arg.trim()).filter(Boolean);
  config.dangerouslySkipPermissions = Boolean(v.antigravitySkipPermissions);
  return config;
}
