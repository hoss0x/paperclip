/** Development shim; server build replaces this with the compiled runner live entry. */
const sourceUrl = new URL("../../../../../packages/paperclip-runner/src/live/index.ts", import.meta.url);
const runner = (await import(sourceUrl.href)) as typeof import("@paperclipai/paperclip-runner/live");
export const probeAcpxClaudeInstallation = runner.probeAcpxClaudeInstallation;
export const probeAcpxGrokInstallation = runner.probeAcpxGrokInstallation;
