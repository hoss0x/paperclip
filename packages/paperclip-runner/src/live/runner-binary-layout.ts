import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The server vendors the contents of dist, without the package root. */
export function resolveDefaultCapabilityRunnerBinary(moduleUrl: string): string {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const adjacent = fileURLToPath(new URL(`../bin/paperclip-runnerd${suffix}`, moduleUrl));
  if (existsSync(adjacent)) return adjacent;
  const packageRoot = fileURLToPath(new URL("../..", moduleUrl));
  const staged = resolve(packageRoot, `dist/bin/paperclip-runnerd${suffix}`);
  if (existsSync(staged)) return staged;
  return resolve(packageRoot, `runner/target/debug/paperclip-runnerd${suffix}`);
}
