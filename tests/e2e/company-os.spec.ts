import { randomUUID } from "node:crypto";
import { createLocalAgentJwt } from "../../server/src/agent-auth-jwt";
import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

// Uses the standard throwaway local_trusted instance. Never points at production.
test("board creates employees, contracts, a mission, ownership and a receipt without tasks", async ({ page, request }) => {
  test.setTimeout(120000);
  page.on("pageerror", error => console.error("Native organization browser error:", error.message));
  await page.addLocatorHandler(page.getByRole("button", { name: "Dismiss announcement", exact: true }), async button => { await button.click(); });
  const live = process.env.PAPERCLIP_COMPANY_OS_LIVE === "1";
  if (live) test.setTimeout(900000);
  await request.patch("/api/instance/settings/experimental", { data: { enableConferenceRoomChat: true } });
  await page.goto("/onboarding");
  const start = page.getByRole("button", { name: /Start Onboarding|New Organization|Add Agent/ });
  if (await start.count()) await start.first().click();
  const create = page.getByRole("button", { name: /Build a new organization/ });
  if (await create.count()) await create.first().click();
  await expect(page.getByRole("heading", { name: "What is the name of your organization?" })).toBeVisible();
  await page.getByPlaceholder("e.g. Northwind Labs").fill(`Collaborative organization ${Date.now()}`);
  const created = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/api/companies"));
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const companyResponse = await created;
  expect(companyResponse.ok(), await companyResponse.text()).toBe(true);
  const company = await companyResponse.json();
  expect((await request.patch(`/api/companies/${company.id}`, { data: { requireBoardApprovalForNewAgents: false } })).ok()).toBe(true);
  const base = `/api/companies/${company.id}/organization`;
  await request.patch("/api/instance/settings/experimental", { data: { enableStreamlinedUi: true } });
  const prefix = company.issuePrefix;
  await page.goto(`/${prefix}/company/settings`);
  await page.getByLabel("Company mission", { exact: true }).fill("Produce reliable recommendations through accountable collaboration");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(async () => (await (await request.get(`/api/companies/${company.id}`)).json()).mission).toBe("Produce reliable recommendations through accountable collaboration");
  const projectResponse = await request.post(`/api/companies/${company.id}/projects`, { data: { name: "Recommendation program" } });
  expect(projectResponse.ok(), await projectResponse.text()).toBe(true);
  const project = await projectResponse.json();
  const goalResponse = await request.post(`/api/companies/${company.id}/goals`, { data: { title: "A verified recommendation", level: "company", status: "active" } });
  expect(goalResponse.ok(), await goalResponse.text()).toBe(true);
  const goal = await goalResponse.json();
  const openReceipts = async () => { await page.goto(`/${prefix}/inbox/mine`); await page.getByText("Employee requests and receipts", { exact: true }).click(); await page.getByLabel("Mission", { exact: true }).selectOption({ label: "Produce a verified recommendation" }); };

  for (const name of ["Mission owner", "Service specialist"]) {
    await page.goto(`/${prefix}/agents/new?${new URLSearchParams({ name, adapterType: "antigravity_local" })}`);
    const finish = page.getByRole("button", { name: "Finish setup", exact: true });
    await expect(finish).toBeEnabled({ timeout: 30000 });
    const hired = page.waitForResponse(r => r.request().method() === "POST" && r.url().includes(`/companies/${company.id}/agent-hires`));
    await finish.click();
    const response = await hired;
    expect(response.ok(), await response.text()).toBe(true);
  }
  const employees = await (await request.get(`/api/companies/${company.id}/agents`)).json();
  const owner = employees.find((a: { name: string }) => a.name === "Mission owner");
  const specialist = employees.find((a: { name: string }) => a.name === "Service specialist");
  expect(owner).toBeTruthy(); expect(specialist).toBeTruthy();
  await page.goto(`/${prefix}/agents/${specialist.id}/contract`);
  await expect(page.getByText("Company OS", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Edit contract", exact: true }).click();
  await page.getByLabel("Purpose", { exact: true }).fill("Provide a reusable research service");
  await page.getByLabel("Capabilities (one per line)", { exact: true }).fill("research");
  await page.getByRole("button", { name: "Add service exposure", exact: true }).click();
  await page.getByLabel("Capability / service", { exact: true }).fill("research");
  await page.getByLabel("Service scope", { exact: true }).selectOption("company");
  if (live) {
    await page.getByLabel("receipt.received", { exact: true }).check();
    await page.getByLabel("Runtime instructions", { exact: true }).fill("For an incoming investigation_request, use the Organizational API shown in context and the environment credentials to POST a knowledge entity and POST a result receipt back to the sender with parentReceiptId set to the incoming receipt id. Knowledge fields: kind=finding, key=verified-smoke-fact, name=Verified smoke fact, summary=Receipt service completed, missionId=incoming mission id, projectId=null, metadata={}, provenance=Live Antigravity receipt smoke, confidence=1. Reply payload: {result: 'Receipt service completed'}. Use curl or Python from your shell. Do not create any tasks. Exit after both API writes succeed.");
  }
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Current contract: version 1", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit contract", exact: true }).click();
  await page.getByLabel("Purpose", { exact: true }).fill("Provide verified research");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Current contract: version 2", { exact: true })).toBeVisible();
  const history = await (await request.get(`${base}/contracts/${specialist.id}/history`)).json();
  expect(history.map((r: { version: number }) => r.version)).toEqual([2, 1]);
  if (live) {
    await page.goto(`/${prefix}/agents/${owner.id}/contract`);
    await page.getByRole("button", { name: "Edit contract", exact: true }).click();
    await page.getByLabel("Purpose", { exact: true }).fill("Own the recommendation and consume specialist results");
    await page.getByLabel("mission.complete", { exact: true }).selectOption("denied");
    await page.getByLabel("Additional event subscriptions (one per line)", { exact: true }).fill("finding.page_requested");
    await page.getByLabel("mission.started", { exact: true }).check();
    await page.getByLabel("receipt.response_received", { exact: true }).check();
    await page.getByLabel("Runtime instructions", { exact: true }).fill("For wakeReason mission.started, use the Organizational API and environment credentials to POST exactly one investigation_request receipt: missionId=current mission id, senderAgentId=your employee id, capability=research, subject=Investigate the evidence, payload={content: Return one verified fact.}, idempotencyKey=smoke-request- followed by the mission id. Do not include recipientAgentId when using capability. For receipt.response_received, verify the result and mission context, POST /receipts/<incoming id>/acknowledge, then exit. Do not send another receipt in response to a result. Never create any tasks. For finding.page_requested, inspect the supplied ordered delta and exit successfully without sending receipts.");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Current contract: version 1", { exact: true })).toBeVisible();
    for (const employee of [owner, specialist]) {
      const updated = await request.patch(`/api/agents/${employee.id}`, { data: { adapterConfig: { ...employee.adapterConfig, model: process.env.PAPERCLIP_COMPANY_OS_MODEL, dangerouslySkipPermissions: true, timeoutSec: 240, promptTemplate: "Process the supplied organizational wake event using the employee contract and mission. Complete this interaction using its API and exit.", desiredSkills: [] } } });
      expect(updated.ok(), await updated.text()).toBe(true);
    }
  }
  await page.goto(`/${prefix}/projects/${project.id}/missions`);
  await page.getByRole("button", { name: "New mission", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Produce a verified recommendation");
  await page.getByLabel("Objective", { exact: true }).fill("Use a specialist service while preserving ownership");
  await page.getByLabel("Owner", { exact: true }).selectOption(owner.id);
  await page.getByLabel("A verified recommendation", { exact: true }).check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByLabel("Mission", { exact: true }).selectOption({ label: "Produce a verified recommendation" });
  await page.getByRole("button", { name: "New workstream", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Recommendation ownership");
  await page.getByLabel("Objective", { exact: true }).fill("Owner remains accountable");
  await page.getByLabel("Owner", { exact: true }).selectOption(owner.id);
  await page.getByRole("button", { name: "Add boundary", exact: true }).click();
  await page.getByRole("textbox", { name: "Boundary kind", exact: true }).fill("service");
  await page.getByRole("textbox", { name: "Owned resource", exact: true }).fill("recommendation");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Recommendation ownership · planned", { exact: true })).toBeVisible();
  const savedMissions = await (await request.get(`${base}/missions`)).json();
  const activeMission = savedMissions.find((m: { data: { title: string } }) => m.data.title === "Produce a verified recommendation");
  expect(activeMission.data.participantAgentIds).not.toContain(specialist.id);
  if (live) {
    for (let index = 0; index < 100; index++) {
      const response = await request.post(`${base}/events`, { data: { kind: "finding.observed", subject: `Backlog finding ${index}`, summary: "Evidence awaiting consumption", missionId: activeMission.id, projectId: project.id, entityIds: [], causationId: null, correlationId: null, metadata: {} } });
      expect(response.ok()).toBe(true);
    }
    await page.getByRole("button", { name: "Edit mission", exact: true }).click();
    await page.getByLabel("Status", { exact: true }).selectOption("active");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("active · Version 2", { exact: true })).toBeVisible();
    await openReceipts();
  } else {
    await openReceipts();
    await page.getByRole("button", { name: "Send receipt", exact: true }).click();
    await page.getByLabel("From", { exact: true }).selectOption(owner.id);
    await page.getByLabel("Or target capability / service", { exact: true }).fill("research");
    await page.getByLabel("Subject", { exact: true }).fill("Investigate the evidence");
    await page.getByLabel("Request / response", { exact: true }).fill("Return one verified fact.");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Investigate the evidence · sent", { exact: true })).toBeVisible();
    const receipts = await (await request.get(`${base}/receipts`)).json(); expect(receipts).toHaveLength(1);
  }
  if (live) {
    await expect.poll(async () => (await (await request.get(`${base}/receipts`)).json()).length, { timeout: 420000, intervals: [2000, 5000] }).toBe(2);
    await expect.poll(async () => (await (await request.get(`${base}/receipts`)).json()).find((r: { parentReceiptId: string | null }) => r.parentReceiptId)?.status, { timeout: 120000, intervals: [2000, 5000] }).toBe("acknowledged");
    const roundTrip = await (await request.get(`${base}/receipts`)).json();
    expect(roundTrip[0].correlationId).toBe(roundTrip[1].correlationId);
    const knowledge = await (await request.get(`${base}/knowledge`)).json();
    expect(knowledge.some((e: { data: { key: string } }) => e.data.key === "verified-smoke-fact")).toBe(true);
    const runsUrl = `/api/companies/${company.id}/heartbeat-runs`;
    await expect.poll(async () => {
      const runs = await (await request.get(runsUrl)).json();
      return runs.filter((run: { agentId: string; status: string }) => run.agentId === owner.id && run.status === "succeeded").length === 2 && runs.some((run: { agentId: string; status: string }) => run.agentId === specialist.id && run.status === "succeeded");
    }, { timeout: 120000, intervals: [2000, 5000] }).toBe(true);
    const runs = await (await request.get(runsUrl)).json();
    const packs: Array<Record<string, unknown>> = [];
    for (const employee of [owner, specialist]) {
      const run = runs.find((r: { agentId: string; status: string; contextSnapshot: { wakeReason: string } }) => r.agentId === employee.id && r.status === "succeeded" && r.contextSnapshot.wakeReason === (employee.id === owner.id ? "receipt.response_received" : "receipt.received"));
      const response = await request.get(`${base}/context-packs/${run.id}`);
      expect(response.ok()).toBe(true);
      const pack = await response.json();
      expect(pack.pack.contract.purpose).toBeTruthy();
      expect(pack.pack.companyMission).toContain("accountable collaboration");
      expect(pack.pack.goals.some((g: { id: string }) => g.id === goal.id)).toBe(true);
      expect(pack.pack.delta).toHaveProperty("afterSequence");
      await page.goto(`/${prefix}/agents/${employee.id}/runs/${run.id}`);
      await expect(page.getByText("Context supplied to this run", { exact: true })).toBeVisible();
      expect(pack.pack.mission.id).toBe(roundTrip[0].missionId);
      expect(pack.pack.receipt.recipientAgentId).toBe(employee.id);
      expect(pack.pack.wakeReason).toBe(employee.id === owner.id ? "receipt.response_received" : "receipt.received");
      if (employee.id === owner.id) {
        expect(pack.pack.knowledge.some((entity: { name: string }) => entity.name === "Verified smoke fact")).toBe(true);
      }
      packs.push({ runId: run.id, employeeId: employee.id, status: run.status, packId: pack.id, missionId: pack.missionId, contractVersion: pack.contractVersion, wakeReason: pack.pack.wakeReason, receiptId: pack.pack.receipt.id, previousContextAt: pack.pack.previousContextAt });
    }
    const initiationRun = runs.find((run: { agentId: string; contextSnapshot: { wakeReason: string } }) => run.agentId === owner.id && run.contextSnapshot.wakeReason === "mission.started");
    expect(initiationRun).toBeTruthy();
    const initiation = await (await request.get(`${base}/context-packs/${initiationRun.id}`)).json();
    expect(initiation.pack.receipt).toBeNull();
    expect(initiation.pack.workstreams[0].title).toBe("Recommendation ownership");
    packs.push({ runId: initiationRun.id, employeeId: owner.id, status: initiationRun.status, packId: initiation.id, missionId: initiation.missionId, contractVersion: initiation.contractVersion, wakeReason: initiation.pack.wakeReason, receiptId: null });
    const streams = await (await request.get(`${base}/missions/${roundTrip[0].missionId}/workstreams`)).json();
    expect(streams[0].data.ownerAgentId).toBe(owner.id);
    const events = await (await request.get(`${base}/events?missionId=${roundTrip[0].missionId}`)).json();
    expect(events.some((e: { kind: string }) => e.kind === "receipt.response_received")).toBe(true);
    expect(events.some((e: { kind: string; origin: string }) => e.kind === "run.completed" && e.origin === "system")).toBe(true);
    const ownerContexts: Array<{ runId: string; pack: { changes: Array<{ id: string; kind: string }>; delta: { hasMore: boolean } } }> = [];
    const inspectedRuns = new Set<string>();
    async function collectOwnerContexts() {
      const currentRuns = await (await request.get(runsUrl)).json();
      for (const r of currentRuns.filter((r: { agentId: string; status: string }) => r.agentId === owner.id && r.status === "succeeded")) {
        if (inspectedRuns.has(r.id)) continue;
        const context = await (await request.get(`${base}/context-packs/${r.id}`)).json();
        ownerContexts.push({ runId: r.id, pack: context.pack }); inspectedRuns.add(r.id);
      }
      return new Set(ownerContexts.flatMap(c => c.pack.changes.filter(e => e.kind === "finding.observed").map(e => e.id))).size;
    }
    for (let attempt = 0; attempt < 5 && await collectOwnerContexts() < 100; attempt++) {
      const before = inspectedRuns.size;
      const wake = await request.post(`${base}/events`, { data: { kind: "finding.page_requested", subject: "Consume the next context page", summary: "Inspect the supplied delta and exit", missionId: activeMission.id, projectId: project.id, entityIds: [], causationId: null, correlationId: null, metadata: {} } });
      expect(wake.ok(), await wake.text()).toBe(true);
      await expect.poll(async () => { await collectOwnerContexts(); return inspectedRuns.size; }, { timeout: 120000, intervals: [2000, 5000] }).toBeGreaterThan(before);
    }
    expect(await collectOwnerContexts()).toBe(100);
    expect(ownerContexts.flatMap(c => c.pack.changes.filter(e => e.kind === "finding.observed"))).toHaveLength(100);
    const token = createLocalAgentJwt(owner.id, company.id, "antigravity_local", initiationRun.id);
    expect(token).toBeTruthy();
    const headers = { Authorization: `Bearer ${token}`, "X-Paperclip-Run-Id": initiationRun.id };
    const spoof = await request.post(`${base}/events`, { headers, data: { kind: "mission.completed", subject: "Spoof", summary: "Must be rejected", missionId: activeMission.id, projectId: project.id, entityIds: [], causationId: null, correlationId: null, metadata: {} } });
    expect(spoof.status()).toBe(403);
    const latestMission = await (await request.get(`${base}/missions/${activeMission.id}`)).json();
    const denied = await request.put(`${base}/missions/${activeMission.id}`, { headers, data: { data: { ...latestMission.data, status: "completed" }, expectedVersion: latestMission.version } });
    expect(denied.status()).toBe(403);
    const otherCompanyResponse = await request.post("/api/companies", { data: { name: `Isolated other company ${Date.now()}` } });
    expect(otherCompanyResponse.ok()).toBe(true);
    const otherCompany = await otherCompanyResponse.json();
    expect((await request.get(`/api/companies/${otherCompany.id}/organization/knowledge`, { headers })).status()).toBe(403);
    const otherEmployeeResponse = await request.post(`/api/companies/${otherCompany.id}/agents`, { data: { name: "Other tenant employee", role: "general", adapterType: "antigravity_local", adapterConfig: {} } });
    expect(otherEmployeeResponse.ok(), await otherEmployeeResponse.text()).toBe(true);
    const otherEmployee = await otherEmployeeResponse.json();
    const otherToken = createLocalAgentJwt(otherEmployee.id, otherCompany.id, "antigravity_local", randomUUID());
    const otherHeaders = { Authorization: `Bearer ${otherToken}` };
    expect((await request.get(`${base}/knowledge`, { headers: otherHeaders })).status()).toBe(403);
    expect((await request.post(`${base}/events`, { headers: otherHeaders, data: { kind: "finding.observed", subject: "Foreign write", summary: "Rejected" } })).status()).toBe(403);
    const evidencePath = test.info().outputPath("live-receipt-evidence.json");
    await writeFile(evidencePath, JSON.stringify({ companyId: company.id, adapter: "antigravity_local", model: process.env.PAPERCLIP_COMPANY_OS_MODEL, receipts: roundTrip, knowledge, workstreams: streams, runs: packs, ownerContexts, policyDenialStatus: denied.status(), eventSpoofStatus: spoof.status(), events }, null, 2));
    await test.info().attach("live-receipt-evidence", { path: evidencePath, contentType: "application/json" });
  }
  const tasks = await (await request.get(`/api/companies/${company.id}/issues`)).json(); expect(tasks).toHaveLength(0);
  await page.goto(`/${prefix}/activity/timeline`);
  await expect(page.getByText("Receipt investigation_request", { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("company-os-timeline.png"), fullPage: true });
});
