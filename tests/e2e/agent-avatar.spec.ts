import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { json } from "./agent-chat.shared";

test.use({ viewport: { width: 1440, height: 1000 } });

test("profile photos persist, replace and reset across the organization chart", async ({ page, request }) => {
  test.setTimeout(120_000);
  const company = await json(await request.post("/api/companies", { data: { name: "Avatar Review" } }));
  const original = await json(await request.get("/api/instance/settings/experimental"));
  await json(await request.patch("/api/instance/settings/experimental", { data: { enableStreamlinedUi: true } }));
  const create = async (name: string, role: string, title: string, reportsTo?: string) => json(
    await request.post(`/api/companies/${company.id}/agents`, { data: {
      name, role, title, reportsTo, adapterType: "process", adapterConfig: { command: "true" },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    } }),
  );
  const chief = await create("Omar", "ceo", "Chief of Staff");
  await create("Tala", "engineer", "Platform Engineer", chief.id);
  await create("Mira", "designer", "Product Designer", chief.id);
  const photo = await fs.readFile(path.resolve("doc/assets/avatars/zinc.png"));
  const photoInput = { name: "portrait.png", mimeType: "image/png", buffer: photo };
  const prefix = `/${company.issuePrefix}`;
  const evidence = async (name: string) => {
    const target = process.env.PAPERCLIP_AVATAR_EVIDENCE_DIR;
    if (target) await page.screenshot({ path: path.join(target, name), fullPage: true });
  };
  try {
    await page.goto(`${prefix}/agents/${chief.id}/runtime`);
    const control = page.getByRole("region", { name: "Agent profile photo" });
    await expect(control.getByRole("button", { name: "Upload photo" })).toBeVisible();
    await control.getByLabel("Choose profile photo").setInputFiles(photoInput);
    await expect(control.getByAltText("New avatar preview")).toBeVisible();
    await control.getByRole("button", { name: "Save photo" }).click();
    await expect(control.getByRole("button", { name: "Remove photo" })).toBeVisible();
    const first = await json(await request.get(`/api/agents/${chief.id}`));
    expect(first.avatarAssetId).toBeTruthy();
    await page.reload();
    await expect(control.locator("img")).toHaveAttribute("src", first.avatarUrl);
    await evidence("avatar-management.png");
    await page.goto(`${prefix}/agents/${chief.id}`);
    await expect(page.locator(`img[src="${first.avatarUrl}"]`).first()).toBeVisible();
    await evidence("agent-overview.png");

    await page.goto(`${prefix}/agents/all`);
    await page.getByRole("button", { name: "Org chart view" }).click();
    const nodes = page.locator("[data-org-card]");
    await expect(nodes).toHaveCount(3);
    const uploaded = nodes.filter({ hasText: "Omar" });
    const fallback = nodes.filter({ hasText: "Tala" });
    await expect(uploaded.locator("img")).toHaveAttribute("src", first.avatarUrl);
    await expect(fallback.locator("img")).toHaveAttribute("src", /\/api\/agent-avatars\//);
    const geometry = (node: typeof uploaded) => node.locator('[data-slot="agent-avatar"]').evaluate(el => {
      const style = getComputedStyle(el); return [style.width, style.height, style.borderRadius];
    });
    expect(await geometry(uploaded)).toEqual(await geometry(fallback));
    await evidence("organization-light.png");
    await uploaded.hover();
    await uploaded.focus();
    await evidence("organization-focus.png");
    const layer = page.getByTestId("org-chart-card-layer");
    const before = await layer.getAttribute("style");
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    expect(await layer.getAttribute("style")).not.toBe(before);
    await page.getByRole("button", { name: "Fit chart to screen" }).click();
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await evidence("organization-dark.png");
    await uploaded.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/agents/${chief.urlKey}`));

    await page.goto(`${prefix}/agents/${chief.id}/runtime`);
    await control.getByLabel("Choose profile photo").setInputFiles(photoInput);
    await control.getByRole("button", { name: "Save photo" }).click();
    await expect(control.getByRole("button", { name: "Remove photo" })).toBeVisible();
    const second = await json(await request.get(`/api/agents/${chief.id}`));
    expect(second.avatarAssetId).not.toBe(first.avatarAssetId);
    expect((await request.get(first.avatarUrl)).status()).toBe(404);
    await control.getByRole("button", { name: "Remove photo" }).click();
    await expect(control.getByRole("button", { name: "Upload photo" })).toBeVisible();
    expect((await request.get(second.avatarUrl)).status()).toBe(404);
    await page.reload();
    expect((await json(await request.get(`/api/agents/${chief.id}`))).avatarAssetId).toBeNull();
    await expect(control.locator("img")).toHaveAttribute("src", /\/api\/agent-avatars\//);
  } finally {
    await json(await request.patch("/api/instance/settings/experimental", { data: { enableStreamlinedUi: original.enableStreamlinedUi } }));
    await request.delete(`/api/companies/${company.id}`);
  }
});
