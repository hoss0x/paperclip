import { describe, expect, it } from "vitest";
import { AGENT_ADAPTER_TYPES, supportedEnvironmentDriversForAdapter } from "@paperclipai/shared";
import { requireServerAdapter } from "../adapters/registry.js";

describe("Antigravity runtime registration", () => {
  it("accepts the first-class type and exposes a local CLI with durable native sessions", async () => {
    expect(AGENT_ADAPTER_TYPES).toContain("antigravity_local");
    const adapter = requireServerAdapter("antigravity_local");
    expect(adapter.type).toBe("antigravity_local");
    expect(adapter.supportsLocalAgentJwt).toBe(true);
    expect(adapter.sessionManagement?.supportsSessionResume).toBe(true);
    expect(supportedEnvironmentDriversForAdapter(adapter.type)).toEqual(["local"]);
    const schema = await adapter.getConfigSchema?.();
    expect(schema?.fields.find(field => field.key === "engine")?.options).toEqual([{ value: "cli", label: "Antigravity CLI" }]);
    const native = { sessionId: "conversation", cwd: "/workspace", accountHome: "/home/agent" };
    expect(adapter.sessionCodec?.deserialize(adapter.sessionCodec.serialize(native))).toEqual(native);
  });

  it("does not inherit Gemini ACP defaults or invent a Flash slug", () => {
    const adapter = requireServerAdapter("antigravity_local");
    expect(adapter.models).toEqual([]);
    expect(adapter.agentConfigurationDoc).toContain("agy");
    expect(adapter.agentConfigurationDoc).toContain("Google's native agy");
  });
});
