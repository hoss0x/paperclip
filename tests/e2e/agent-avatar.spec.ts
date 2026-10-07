import fs from "node:fs/promises";
import path from "node:path";
import { expect as baseExpect, test } from "@playwright/test";

import { json } from "./agent-chat.shared";

const expect = baseExpect.configure({ timeout: 20_000 });

test.use({ viewport: { width: 1440, height: 1000 } });

test("profile photos persist, replace and reset across the organization chart", async ({ page, request }) => {
  test.setTimeout(180_000);
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
    const target = process.env.PAPERCLIP_AVATAR_EVIDENCE_DIR
      ?? (process.env.PAPERCLIP_RUN_SCRATCH_DIR ? path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR, "evidence") : undefined);
    if (target) await page.screenshot({ path: path.join(target, name), fullPage: true });
  };
  try {
    await page.goto(`${prefix}/agents/${chief.id}/runtime`, { waitUntil: "domcontentloaded" });
    const control = page.getByRole("region", { name: "Agent profile photo" });
    await expect(control.getByRole("button", { name: "Upload photo" })).toBeVisible({ timeout: 20_000 });
    await control.getByLabel("Choose profile photo").setInputFiles(photoInput);
    await expect(control.getByAltText("New avatar preview")).toBeVisible();
    await control.getByRole("button", { name: "Save photo" }).click();
    await expect(control.getByRole("button", { name: "Remove photo" })).toBeVisible();
    const first = await json(await request.get(`/api/agents/${chief.id}`));
    expect(first.avatarAssetId).toBeTruthy();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(control.locator("img")).toHaveAttribute("src", first.avatarUrl);
    await evidence("avatar-management.png");
    await page.goto(`${prefix}/agents/${chief.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator(`img[src="${first.avatarUrl}"]`).first()).toBeVisible();
    await evidence("agent-overview.png");

    await page.goto(`${prefix}/agents/all`, { waitUntil: "domcontentloaded" });
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
    const interactionStyle = (node: typeof uploaded) => node.evaluate(el => {
      const avatar = el.querySelector('[data-slot="agent-avatar"]')!;
      const buttonStyle = getComputedStyle(el);
      const avatarStyle = getComputedStyle(avatar);
      return {
        background: buttonStyle.backgroundColor, outline: buttonStyle.outlineStyle,
        nodeShadow: buttonStyle.boxShadow, portraitShadow: avatarStyle.boxShadow,
        circular: parseFloat(avatarStyle.borderRadius) >= parseFloat(avatarStyle.width) / 2,
        clipped: avatarStyle.overflow === "hidden", focusVisible: el.matches(":focus-visible"),
      };
    });
    const settlePortrait = (node: typeof uploaded) => node.locator('[data-slot="agent-avatar"]').evaluate(async el => {
      getComputedStyle(el).boxShadow;
      await Promise.all(el.getAnimations().map(animation => animation.finished));
    });
    for (const mode of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: mode });
      if (mode === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
      else await expect(page.locator("html")).not.toHaveClass(/dark/);
      await page.mouse.move(0, 0);
      const resting = await interactionStyle(uploaded);
      for (const node of [uploaded, fallback]) {
        await node.evaluate(el => el.blur());
        await node.hover();
        await settlePortrait(node);
        await expect.poll(async () => (await interactionStyle(node)).portraitShadow).not.toBe(resting.portraitShadow);
        expect(await interactionStyle(node)).toMatchObject({
          background: "rgba(0, 0, 0, 0)", outline: "none", nodeShadow: "none", circular: true, clipped: true,
        });
        const hovered = await interactionStyle(node);
        await page.keyboard.press("Tab");
        await node.focus();
        await settlePortrait(node);
        await expect.poll(async () => (await interactionStyle(node)).focusVisible).toBe(true);
        await expect.poll(async () => (await interactionStyle(node)).portraitShadow).not.toBe(hovered.portraitShadow);
        expect(await interactionStyle(node)).toMatchObject({
          outline: "none", nodeShadow: "none", circular: true, clipped: true,
        });
      }
      await uploaded.hover();
      await fallback.focus();
      await Promise.all([settlePortrait(uploaded), settlePortrait(fallback)]);
      await evidence(`organization-${mode}-photo-hover-fallback-focus.png`);
      await fallback.hover();
      await uploaded.focus();
      await Promise.all([settlePortrait(uploaded), settlePortrait(fallback)]);
      await evidence(`organization-${mode}-photo-focus-fallback-hover.png`);
      await uploaded.hover();
      await page.mouse.down();
      expect(await uploaded.evaluate(el => el.matches(":active"))).toBe(true);
      expect(await interactionStyle(uploaded)).toMatchObject({ outline: "none", nodeShadow: "none", circular: true });
      await page.mouse.move(0, 0);
      await page.mouse.up();
    }
    await page.emulateMedia({ colorScheme: "light" });
    await uploaded.focus();
    await evidence("organization-focus.png");
    const layer = page.getByTestId("org-chart-card-layer");
    const before = await layer.getAttribute("style");
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    expect(await layer.getAttribute("style")).not.toBe(before);
    await page.getByRole("button", { name: "Fit chart to screen" }).click();
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await evidence("organization-dark.png");
    await uploaded.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/agents/${chief.urlKey}`));

    await page.goto(`${prefix}/agents/${chief.id}/runtime`, { waitUntil: "domcontentloaded" });
    await control.getByLabel("Choose profile photo").setInputFiles(photoInput);
    await control.getByRole("button", { name: "Save photo" }).click();
    await expect(control.getByRole("button", { name: "Remove photo" })).toBeVisible();
    const second = await json(await request.get(`/api/agents/${chief.id}`));
    expect(second.avatarAssetId).not.toBe(first.avatarAssetId);
    expect((await request.get(first.avatarUrl)).status()).toBe(404);
    await control.getByRole("button", { name: "Remove photo" }).click();
    await expect(control.getByRole("button", { name: "Upload photo" })).toBeVisible({ timeout: 20_000 });
    expect((await request.get(second.avatarUrl)).status()).toBe(404);
    await page.reload({ waitUntil: "domcontentloaded" });
    expect((await json(await request.get(`/api/agents/${chief.id}`))).avatarAssetId).toBeNull();
    await expect(control.locator("img")).toHaveAttribute("src", /\/api\/agent-avatars\//);
  } finally {
    await json(await request.patch("/api/instance/settings/experimental", { data: { enableStreamlinedUi: original.enableStreamlinedUi } }));
    await request.delete(`/api/companies/${company.id}`);
  }
});
