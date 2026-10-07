// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentAvatarControl } from "./AgentAvatarControl";
import type { Agent } from "@paperclipai/shared";
const upload = vi.fn(), remove = vi.fn();
vi.mock("@/api/agents", () => ({ agentsApi: { uploadAvatar: (...args: unknown[]) => upload(...args), removeAvatar: (...args: unknown[]) => remove(...args) } }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const agent = { id: "a", name: "Omar", companyId: "c", avatarAssetId: "photo", avatarUrl: "/api/assets/11111111-1111-4111-8111-111111111111/content" } as Agent;
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.clearAllMocks(); });
async function render() {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:preview"), revokeObjectURL: vi.fn() }));
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}><AgentAvatarControl agent={agent} /></QueryClientProvider>));
}
async function click(text: string) { await act(async () => { [...host.querySelectorAll("button")].find(b => b.textContent === text)!.click(); await new Promise(r => setTimeout(r, 20)); }); }
describe("profile photo controls", () => {
  it("previews a replacement, saves it and removes an existing photo", async () => {
    upload.mockResolvedValue({}); remove.mockResolvedValue({});
    await render();
    const file = new File(["photo"], "photo.png", { type: "image/png" });
    const input = host.querySelector("input")!;
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    expect(host.querySelector('img[alt="New avatar preview"]')?.getAttribute("src")).toBe("blob:preview");
    await click("Save photo");
    expect(upload).toHaveBeenCalledWith("a", file);
    expect(host.querySelector('img[alt="New avatar preview"]')).toBeNull();
    await click("Remove photo");
    expect(remove).toHaveBeenCalledWith("a");
  });
  it("shows server errors inline and keeps the current avatar", async () => {
    remove.mockRejectedValue(new Error("Cannot remove photo"));
    await render(); await click("Remove photo");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Cannot remove photo");
    expect(host.querySelector("img")?.getAttribute("src")).toBe(agent.avatarUrl);
  });
});
