import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { resolveDefaultCapabilityRunnerBinary } from "./runner-binary-layout.js";

it.each(["src", "dist", "vendored"])("finds the native binary in the %s layout", async layout => {
  const root = await mkdtemp(join(tmpdir(), "runner-binary-layout-"));
  try {
    const folder = layout === "vendored" ? root : join(root, layout);
    const binary = join(layout === "vendored" ? root : join(root, "dist"), "bin", `paperclip-runnerd${process.platform === "win32" ? ".exe" : ""}`);
    await mkdir(join(binary, ".."), { recursive: true });
    await writeFile(binary, "fixture");
    expect(resolveDefaultCapabilityRunnerBinary(pathToFileURL(join(folder, "live", "runnerd-codex-transport.js")).href)).toBe(binary);
  } finally { await rm(root, { recursive: true, force: true }); }
});
