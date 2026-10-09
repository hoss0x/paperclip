import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs/promises", () => ({ default: { mkdtemp: vi.fn().mockResolvedValue("fixture-quota-scratch"), rm: vi.fn().mockResolvedValue(undefined) } }));

vi.mock("../adapters/registry.js", () => ({
  listServerAdapters: vi.fn(),
}));

import { listServerAdapters } from "../adapters/registry.js";
vi.mock("@paperclipai/adapter-utils/execution-resource-context", () => ({
  withOperatorExecutionResources: vi.fn((input, execute) => execute()),
}));

import { withOperatorExecutionResources } from "@paperclipai/adapter-utils/execution-resource-context";
import { fetchAllQuotaWindows } from "../services/quota-windows.js";

describe("fetchAllQuotaWindows", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(withOperatorExecutionResources).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns adapter results without waiting for a slower provider to finish forever", async () => {
    vi.mocked(listServerAdapters).mockReturnValue([
      {
        type: "codex_local",
        getQuotaWindows: vi.fn().mockResolvedValue({
          provider: "openai",
          source: "codex-rpc",
          ok: true,
          windows: [{ label: "5h limit", usedPercent: 2, resetsAt: null, valueLabel: null, detail: null }],
        }),
      },
      {
        type: "claude_local",
        getQuotaWindows: vi.fn(() => new Promise(() => {})),
      },
    ] as never);

    const promise = fetchAllQuotaWindows();
    await vi.advanceTimersByTimeAsync(20_001);
    const results = await promise;

    const calls = vi.mocked(withOperatorExecutionResources).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]![0].signal?.aborted).toBe(true);

    expect(results).toEqual([
      {
        provider: "openai",
        source: "codex-rpc",
        ok: true,
        windows: [{ label: "5h limit", usedPercent: 2, resetsAt: null, valueLabel: null, detail: null }],
      },
      {
        provider: "anthropic",
        ok: false,
        error: "quota polling timed out after 20s",
        windows: [],
      },
    ]);
  });

  it("shares simultaneous UI polls and permits a later refresh", async () => {
    const getQuotaWindows = vi.fn().mockResolvedValue({ provider: "openai", ok: true, windows: [] });
    vi.mocked(listServerAdapters).mockReturnValue([{ type: "codex_local", getQuotaWindows }] as never);
    const first = fetchAllQuotaWindows();
    const duplicate = fetchAllQuotaWindows();
    expect(duplicate).toBe(first);
    await first;
    expect(getQuotaWindows).toHaveBeenCalledTimes(1);
    await fetchAllQuotaWindows();
    expect(getQuotaWindows).toHaveBeenCalledTimes(2);
  });
});
