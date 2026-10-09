import { accessSync, constants } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

function executableName(): string {
  return process.platform === "win32" ? "paperclip-runnerd.exe" : "paperclip-runnerd";
}

export function resolvePaperclipRunnerBinary(
  configuredPath = process.env.PAPERCLIP_RUNNER_BINARY,
): string {
  const candidates = [
    configuredPath,
    resolve(moduleDirectory, "../../vendor/paperclip-runner/bin", executableName()),
    resolve(moduleDirectory, "../../../../packages/paperclip-runner/dist/bin", executableName()),
    resolve(
      moduleDirectory,
      "../../../../packages/paperclip-runner/runner/target/release",
      executableName(),
    ),
  ].filter((candidate): candidate is string => Boolean(candidate));
  if (configuredPath && !isAbsolute(configuredPath)) {
    throw new Error("PAPERCLIP_RUNNER_BINARY must be an absolute path");
  }
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.R_OK | (process.platform === "win32" ? 0 : constants.X_OK));
      return candidate;
    } catch {
      // Continue through the fixed production and workspace locations.
    }
  }
  throw new Error(
    "paperclip_runner_binary_missing: build @paperclipai/paperclip-runner or set PAPERCLIP_RUNNER_BINARY",
  );
}

