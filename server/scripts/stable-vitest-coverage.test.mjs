import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import config from "../../vitest.config.ts";

it("selects every configured workspace project in the stable full test path", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const selected = ["@paperclipai/server"];
  for (const group of ["general-workspaces-a", "general-workspaces-b"]) {
    const result = spawnSync(process.execPath, ["scripts/run-vitest-stable.mjs", "--mode", "general", "--group", group, "--dry-run"], { cwd: root, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    selected.push(...JSON.parse(result.stdout).workspaceProjects);
  }
  const configured = config.test.projects.map(directory => JSON.parse(readFileSync(new URL(directory + "/package.json", new URL("../../", import.meta.url)), "utf8")).name);
  expect(selected.sort()).toEqual(configured.sort());
});
