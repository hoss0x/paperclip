import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../adapters/registry.js", () => ({
  listServerAdapters: vi.fn(),
}));

import { listServerAdapters } from "../adapters/registry.js";
vi.mock("../services/host-execution-resources.js", () => ({
  withHostExecutionResources: vi.fn((input, execute) => execute()),
}));

import { withHostExecutionResources } from "../services/host-execution-resources.js";
import { fetchAllQuotaWindows } from "../services/quota-windows.js";

describe("fetchAllQuotaWindows", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(withHostExecutionResources).mockClear();
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

    const calls = vi.mocked(withHostExecutionResources).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]![0]?.aborted).toBe(true);

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
