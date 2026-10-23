import { describe, expect, it } from "vitest";
import { normalizeRunUsage } from "../services/work-timeline.js";

describe("Timeline provider usage accounting", () => {
  it("counts Codex cached tokens as a subset of input", () => {
    expect(normalizeRunUsage({ inputTokens: 120, cachedInputTokens: 100, outputTokens: 10 }, "codex_local"))
      .toEqual({ inputTokens: 120, cachedInputTokens: 100, outputTokens: 10, totalTokens: 130 });
  });
  it("retains separate cache-read semantics for additive adapters", () => {
    for (const adapter of ["claude_local", "opencode_local", "antigravity_local"])
      expect(normalizeRunUsage({ input_tokens: 120, cached_input_tokens: 100, output_tokens: 10 }, adapter)?.totalTokens).toBe(230);
  });
  it("reads aliases once and ignores invalid counts", () => {
    expect(normalizeRunUsage({ inputTokens: 120, input_tokens: 120, cachedInputTokens: 100, outputTokens: 10 }, "codex_local")?.totalTokens).toBe(130);
    expect(normalizeRunUsage({ inputTokens: -1, outputTokens: NaN }, "codex_local")).toBeNull();
  });
});
