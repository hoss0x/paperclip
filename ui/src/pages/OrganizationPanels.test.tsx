// @vitest-environment jsdom
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationPanel } from "./OrganizationPanels";

vi.mock("../lib/router", async () => ({ Link: (await import("react-router-dom")).Link }));

const state = vi.hoisted(() => ({ company: "company-a", saveMission: vi.fn(), saveEmployeeSettings: vi.fn(), setBreadcrumbs: vi.fn() }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: state.company }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: state.setBreadcrumbs }) }));
vi.mock("../api/agents", () => ({ agentsApi: { list: async () => [{ id: "employee-a", name: "Owner" }, { id: "employee-b", name: "Specialist" }] } }));
vi.mock("../api/goals", () => ({ goalsApi: { list: async () => [{ id: "goal-a", title: "Desired result" }] } }));
vi.mock("../api/projects", () => ({ projectsApi: { list: async () => [] } }));
vi.mock("../api/company-os", () => ({ companyOsApi: {
  missions: async () => [], workstreams: async () => [], receipts: async () => [], knowledge: async () => [], relationships: async () => [], events: async () => [],
  employeeSettings: async () => null, saveMission: state.saveMission, saveEmployeeSettings: state.saveEmployeeSettings,
} }));
let container: HTMLDivElement, root: Root;
const flush = async () => { await Promise.resolve(); await new Promise(r => setTimeout(r, 0)); };
async function until(assertion: () => void) { let error: unknown; for (let i = 0; i < 30; i++) { await flush(); try { assertion(); return; } catch (e) { error = e; } } throw error; }
const button = (text: string) => Array.from(document.body.querySelectorAll("button")).find(b => b.textContent === text)!;
function fill(label: string, value: string) {
  const field = Array.from(document.body.querySelectorAll("label")).find(l => l.textContent === label)!;
  const input = document.getElementById(field.htmlFor) as HTMLInputElement;
  const prototype = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : input.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
  flushSync(() => input.dispatchEvent(new Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true })));
}
function render(section: "Missions" | "Services & Automation" | "Receipts" | "Knowledge" = "Missions") {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  flushSync(() => root.render(<QueryClientProvider client={cache}><MemoryRouter><OrganizationPanel section={section} /></MemoryRouter></QueryClientProvider>));
}
beforeEach(() => { state.company = "company-a"; state.saveMission.mockReset().mockResolvedValue({}); state.saveEmployeeSettings.mockReset().mockResolvedValue({}); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { flushSync(() => root.unmount()); container.remove(); });
describe("Native organizational editors", () => {
  it("saves a mission with outcome criteria and retains draft on conflict", async () => {
    render(); await until(() => expect(container.textContent).toContain("New Mission"));
    flushSync(() => button("New Mission").click()); fill("Title", "A clear outcome"); fill("Objective", "Coordinate the team");
    fill("Success criteria (one per line)", "First result\nSecond result");
    state.saveMission.mockRejectedValueOnce(new Error("Mission changed; reload before saving"));
    flushSync(() => document.body.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await until(() => expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("Mission changed"));
    expect((document.body.querySelector('[role="dialog"] input') as HTMLInputElement).value).toBe("A clear outcome");
    expect(state.saveMission).toHaveBeenCalledWith("company-a", null, expect.objectContaining({ title: "A clear outcome", successCriteria: ["First result", "Second result"] }), 0);
  });
  it("edits machine settings without a second role prose editor", async () => {
    render("Services & Automation"); await until(() => expect(container.textContent).toContain("Specialist"));
    fill("Employee", "employee-b"); await until(() => expect(container.textContent).toContain("Edit settings"));
    flushSync(() => button("Edit settings").click()); fill("Capabilities (one per line)", "research\nreview");
    flushSync(() => document.body.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await until(() => expect(state.saveEmployeeSettings).toHaveBeenCalledWith("company-a", "employee-b", expect.objectContaining({ capabilities: ["research", "review"] }), 0));
  });
  it("drops a company-specific draft when switching companies", async () => {
    render(); flushSync(() => button("New Mission").click()); fill("Title", "Private first-company draft");
    state.company = "company-b"; render();
    expect(document.body.querySelector("form")).toBeNull(); expect(container.textContent).not.toContain("Private first-company draft");
  });
  it("offers a visible Receipt composer without a Mission selection first", async () => {
    render("Receipts"); await until(() => expect(button("New Receipt")).toBeTruthy());
    expect(container.querySelector("details")).toBeNull();
    flushSync(() => button("New Receipt").click());
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain("Mission for receipt");
    expect(document.body.textContent).toContain("sender keeps work ownership");
  });
  it("explains empty Knowledge and does not show a relationship form", async () => {
    render("Knowledge"); await until(() => expect(container.textContent).toContain("Add Knowledge first"));
    expect(button("Add Relationship").disabled).toBe(true);
    expect(document.body.querySelector("form")).toBeNull();
    flushSync(() => button("Add Knowledge").click());
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  });

});
