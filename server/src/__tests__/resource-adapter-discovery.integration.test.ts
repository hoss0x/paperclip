import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { execFileWithResources } from "@paperclipai/adapter-utils/resource-buffered-command";
import { currentExecutionResources } from "@paperclipai/adapter-utils/execution-resource-context";
import { detectAdapterModel, listAdapterModels, refreshAdapterModels, registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";

const enabled = process.platform === "linux" && process.env.PAPERCLIP_TEST_SYSTEMD === "1";
(enabled ? describe : describe.skip)("controller adapter discovery isolation", () => {
  it("governs listing, refresh and detection outside dispatch, including OOM and recovery", async () => {
    const type = `resource-fixture-${randomUUID()}`;
    const groups: string[] = [];
    let limited = false;
    const probe = async () => {
      expect(currentExecutionResources()?.policy.isolation).toBe("systemd");
      const result = await execFileWithResources(process.execPath, ["-e", limited
        ? "const held=[];setInterval(()=>held.push(Buffer.alloc(8*1024*1024,1)),10)"
        : "console.log(require('fs').readFileSync('/proc/self/cgroup','utf8'))"], { timeout: 5000, maxBuffer: 4096 });
      groups.push(result.stdout.trim());
      return [{ id: "fixture", label: "Fixture" }];
    };
    registerServerAdapter({ type, execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
      testEnvironment: async () => ({ adapterType: type, status: "pass", checks: [], testedAt: new Date().toISOString() }),
      listModels: probe, refreshModels: probe,
      detectModel: async () => { await probe(); return { model: "fixture", provider: "fixture", source: "fixture" }; },
    });
    try {
      expect(await listAdapterModels(type)).toEqual([{ id: "fixture", label: "Fixture" }]);
      expect(await refreshAdapterModels(type)).toEqual([{ id: "fixture", label: "Fixture" }]);
      expect(await detectAdapterModel(type)).toMatchObject({ model: "fixture" });
      limited = true;
      await expect(refreshAdapterModels(type)).rejects.toMatchObject({ code: "execution_resource_limit" });
      limited = false;
      expect(await listAdapterModels(type)).toHaveLength(1);
      expect(groups).toHaveLength(4);
      expect(groups.every(group => group.includes(".scope") && !group.includes("paperclipai.service"))).toBe(true);
      await fs.writeFile(path.join(process.env.PAPERCLIP_SCRATCH_DIR!, "adapter-probe-identities.json"), JSON.stringify(groups));
      expect(currentExecutionResources()).toBeUndefined();
    } finally { unregisterServerAdapter(type); }
  }, 30_000);
});
