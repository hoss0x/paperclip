import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, activityLog, companies, agents, goals, projects, issues, heartbeatRuns, contextEvents, organizationDeliveries, organizationReceipts, organizationContextPacks, agentWakeupRequests, type Db } from "@paperclipai/db";
import { employeeContractSchema, missionSchema, workstreamSchema, receiptSchema, knowledgeEntitySchema } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { companyOsService, boundariesOverlap } from "../services/company-os.js";
import { compileOrganizationContext, dispatchOrganizationDeliveries, renderOrganizationContext, settleOrganizationRuns, scheduleOrganizationReviews } from "../services/company-os-runtime.js";
import { ingestOrganizationEvidence } from "../services/organization-evidence.js";
import { companyOsRoutes } from "../routes/company-os.js";
import { errorHandler } from "../middleware/error-handler.js";

const board = { actorType: "user" as const, actorId: "board" };
const asAgent = (id: string) => ({ actorType: "agent" as const, actorId: id });
describe("Company OS: isolated PostgreSQL domain/API/runtime", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let c: string, other: string, a: string, b: string, outsider: string, goalId: string, projectId: string;
  let svc: ReturnType<typeof companyOsService>;
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("company-os-"); db = createDb(temporary.connectionString); svc = companyOsService(db); }, 90000);
  afterAll(async () => { await temporary?.cleanup(); }, 30000);
  beforeEach(async () => {
    [c, other, a, b, outsider, goalId, projectId] = Array.from({ length: 7 }, () => randomUUID());
    await db.insert(companies).values([{ id: c, name: "First company", issuePrefix: "C" + c.slice(0, 6) }, { id: other, name: "Other company", issuePrefix: "O" + other.slice(0, 6) }]);
    await db.insert(agents).values([{ id: a, companyId: c, name: "Owner" }, { id: b, companyId: c, name: "Specialist" }, { id: outsider, companyId: other, name: "Outside employee" }]);
    await db.insert(goals).values({ id: goalId, companyId: c, title: "Desired outcome", level: "company" });
    await db.insert(projects).values({ id: projectId, companyId: c, name: "Operational project" });
  });
  const missionInput = () => missionSchema.parse({ title: "Coordinated outcome", objective: "Learn and report", ownerAgentId: a, participantAgentIds: [a, b], goalIds: [goalId], projectIds: [projectId], status: "active", roadmap: "Investigate, decide, deliver", successCriteria: ["Evidence returned"], constraints: ["Keep ownership"], summary: "Starting", startedAt: null, endedAt: null, metadata: {} });
  const mission = () => svc.saveMission(c, null, missionInput(), 0, board);
  const contract = (subscriptions: string[] = []) => employeeContractSchema.parse({ purpose: "Persistent employee", eventSubscriptions: subscriptions, capabilities: ["research"] });
  const knowledge = (name: string, missionId: string | null, project: string | null = projectId) => knowledgeEntitySchema.parse({ kind: "resource", key: name, name, summary: name, missionId, projectId: project, metadata: {}, provenance: "Verified fixture", confidence: 1 });
  const run = async (agentId: string, context: Record<string, unknown>, status = "running") => (await db.insert(heartbeatRuns).values({ companyId: c, agentId, invocationSource: "automation", status, contextSnapshot: context }).returning())[0];
  function app(companyId: string, agentId?: string) {
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = agentId ? { type: "agent", agentId, companyId, source: "agent_key" } : { type: "board", source: "session", userId: "board", companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "owner" }] } as typeof req.actor; next(); });
    app.use("/api", companyOsRoutes(db)); app.use(errorHandler); return app;
  }
  it("versions contracts through API, rejects stale/agent edits, and preserves history", async () => {
    const url = `/api/companies/${c}/organization/contracts/${b}`;
    expect((await request(app(c)).put(url).send({ expectedVersion: 0, contract: contract() })).status).toBe(200);
    expect((await request(app(c)).put(url).send({ expectedVersion: 1, contract: { ...contract(), purpose: "Updated purpose" } })).body.version).toBe(2);
    expect((await request(app(c)).put(url).send({ expectedVersion: 1, contract: contract() })).status).toBe(409);
    expect((await request(app(c, a)).put(url).send({ expectedVersion: 2, contract: contract() })).status).toBe(403);
    const history = (await request(app(c)).get(url + "/history")).body;
    expect(history.map((r: { version: number }) => r.version)).toEqual([2, 1]);
    expect(history[1].contract.purpose).toBe("Persistent employee");
  });
  it("allocates exactly one next contract revision under competing writes", async () => {
    const attempts = await Promise.allSettled([svc.saveContract(c, b, contract(), 0, board), svc.saveContract(c, b, contract(), 0, board)]);
    expect(attempts.filter(x => x.status === "fulfilled")).toHaveLength(1);
    expect(await svc.contractHistory(c, b)).toHaveLength(1);
  });
  it("isolates two companies' reads and every linked reference", async () => {
    const m = await mission(); await svc.saveContract(c, b, contract(), 0, board);
    const entity = await svc.saveKnowledge(c, null, knowledge("Private company truth", m.id), 0, board);
    expect(await svc.listMissions(other)).toEqual([]); expect(await svc.listKnowledge(other)).toEqual([]);
    expect(await svc.currentContract(other, b)).toBeNull(); expect(await svc.listReceipts(other, {})).toEqual([]);
    await expect(svc.getMission(other, m.id)).rejects.toMatchObject({ status: 404 });
    await expect(svc.saveMission(other, null, missionInput(), 0, board)).rejects.toMatchObject({ status: 400 });
    await expect(svc.saveContract(other, b, contract(), 0, board)).rejects.toMatchObject({ status: 400 });
    await expect(svc.addRelationship(other, { sourceId: entity.id, targetId: entity.id, kind: "USES", provenance: "test", confidence: null, supersedesId: null, metadata: {} }, board)).rejects.toMatchObject({ status: 400 });
    expect((await request(app(other, outsider)).get(`/api/companies/${c}/organization/missions`)).status).toBe(403);
    expect((await request(app(other)).get(`/api/companies/${other}/organization/missions/${m.id}`)).status).toBe(404);
    expect((await request(app(other)).get(`/api/companies/${other}/organization/context-packs/${randomUUID()}`)).status).toBe(404);
  });
  it("records mission updates, goals, roadmap and ownership conflict atomically", async () => {
    const m = await mission();
    const changed = await svc.saveMission(c, m.id, { ...m.data, roadmap: "Revised roadmap", status: "stalled" }, 1, board);
    expect(changed.version).toBe(2); expect(changed.data.goalIds).toEqual([goalId]);
    const ws = workstreamSchema.parse({ title: "First boundary", objective: "Own resource", ownerAgentId: a, participantAgentIds: [a], status: "active", dependencyIds: [], acceptanceCriteria: ["Reviewed"], boundaries: [{ kind: "path", repository: "repo", resource: "service/a" }], constraints: [], executionWorkspaceId: null });
    await svc.saveWorkstream(c, m.id, null, ws, 0, board);
    await svc.saveWorkstream(c, m.id, null, { ...ws, title: "Second boundary", ownerAgentId: b, boundaries: [{ kind: "path", repository: "repo", resource: "service/b" }] }, 0, board);
    await expect(svc.saveWorkstream(c, m.id, null, { ...ws, boundaries: [{ kind: "path", repository: "repo", resource: "service/a/sub" }] }, 0, board)).rejects.toMatchObject({ status: 409 });
    expect(await svc.listWorkstreams(c, m.id)).toHaveLength(2);
    expect((await svc.listEvents(c, { missionId: m.id })).map(e => e.kind)).toEqual(expect.arrayContaining(["mission.started", "mission.stalled", "workstream.updated"]));
  });
  it("delivers issue-free receipt requests/responses with contract, mission, knowledge and correlation", async () => {
    await svc.saveContract(c, a, contract(["receipt.response_received"]), 0, board);
    await svc.saveContract(c, b, contract(["receipt.received"]), 0, board);
    const m = await mission(); await svc.saveKnowledge(c, null, knowledge("Relevant truth", m.id), 0, board);
    const incoming = receiptSchema.parse({ missionId: m.id, senderAgentId: a, capability: "research", kind: "investigation_request", subject: "Find evidence", payload: { question: "What changed?" }, idempotencyKey: "request-1" });
    // Both advertise research; explicit address avoids ambiguous routing.
    await expect(svc.sendReceipt(c, incoming, asAgent(a))).rejects.toMatchObject({ status: 409 });
    const direct = receiptSchema.parse({ ...incoming, capability: undefined, recipientAgentId: b });
    const receipt = await svc.sendReceipt(c, direct, asAgent(a));
    expect((await svc.sendReceipt(c, direct, asAgent(a))).id).toBe(receipt.id);
    const wakes: { agentId: string; context: Record<string, unknown>; runId: string }[] = [];
    const wake = vi.fn(async (agentId: string, options: { contextSnapshot?: Record<string, unknown>; idempotencyKey?: string }) => {
      const r = await run(agentId, options.contextSnapshot ?? {});
      await db.insert(agentWakeupRequests).values({ companyId: c, agentId, source: "automation", reason: "receipt.received", status: "queued", runId: r.id, idempotencyKey: options.idempotencyKey });
      wakes.push({ agentId, context: options.contextSnapshot!, runId: r.id }); return r;
    });
    await dispatchOrganizationDeliveries(db, wake);
    expect(wakes).toHaveLength(1); expect(wakes[0].agentId).toBe(b); expect(wakes[0].context.issueId).toBeUndefined();
    const r = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wakes[0].runId)))[0];
    const pack = await compileOrganizationContext(db, r, wakes[0].context);
    expect(pack?.pack).toMatchObject({ contract: { version: 1 }, mission: { id: m.id }, receipt: { id: receipt.id } });
    expect(JSON.stringify(pack?.pack)).toContain("Relevant truth");
    expect(renderOrganizationContext(pack!, false)).toContain("Do not look for, create, or check out an Issue");
    await svc.acknowledgeReceipt(c, receipt.id, asAgent(b));
    const response = await svc.sendReceipt(c, receiptSchema.parse({ missionId: m.id, senderAgentId: b, recipientAgentId: a, kind: "result", subject: "Evidence", payload: { result: "Found" }, parentReceiptId: receipt.id, idempotencyKey: "response-1" }), asAgent(b));
    expect(response.correlationId).toBe(receipt.correlationId);
    expect((await svc.getReceipt(c, receipt.id)).status).toBe("resolved");
    await dispatchOrganizationDeliveries(db, wake);
    expect(wakes.map(w => w.agentId)).toEqual([b, a]);
    await dispatchOrganizationDeliveries(db, wake); expect(wake).toHaveBeenCalledTimes(2);
    expect(await db.select().from(issues).where(eq(issues.companyId, c))).toEqual([]);
    expect((await svc.listEvents(c, { correlationId: receipt.correlationId })).some(e => e.causationId)).toBe(true);
    await expect(svc.sendReceipt(c, direct, asAgent(b))).rejects.toMatchObject({ status: 403 });
  });
  it("never wakes for goals alone, filters unsubscribed events, and retries deferred delivery", async () => {
    const wake = vi.fn(async () => null);
    await svc.saveContract(c, b, contract(["mission.started"]), 0, board);
    await dispatchOrganizationDeliveries(db, wake); expect(wake).not.toHaveBeenCalled();
    await mission(); await dispatchOrganizationDeliveries(db, wake); expect(wake).toHaveBeenCalledTimes(1);
    const [delivery] = await db.select().from(organizationDeliveries).where(eq(organizationDeliveries.companyId, c));
    expect(delivery.status).toBe("pending"); expect(delivery.error).toContain("deferred");
    await svc.saveContract(c, b, contract([]), 1, board);
    await db.update(organizationDeliveries).set({ availableAt: new Date(0) }).where(eq(organizationDeliveries.id, delivery.id));
    await dispatchOrganizationDeliveries(db, wake); expect(wake).toHaveBeenCalledTimes(1);
    expect((await db.select().from(organizationDeliveries).where(eq(organizationDeliveries.id, delivery.id)))[0].status).toBe("cancelled");
  });
  it("supplies the triggering event for issue-free company-wide wakes and rejects other tenants", async () => {
    await svc.saveContract(c, b, contract(["context.created"]), 0, board);
    const event = await svc.appendEvent(c, { kind: "context.created", subject: "Shared policy changed", summary: "Use the new service window", missionId: null, projectId: null, entityIds: [], causationId: null, correlationId: null, metadata: {} }, board);
    let context: Record<string, unknown> = {};
    const wake = vi.fn(async (agentId: string, options: { contextSnapshot: Record<string, unknown> }) => {
      context = options.contextSnapshot;
      return run(agentId, context);
    });
    await dispatchOrganizationDeliveries(db, wake);
    expect(wake).toHaveBeenCalledTimes(1);
    const r = await run(b, context);
    const pack = await compileOrganizationContext(db, r, context);
    expect(pack?.pack).toMatchObject({ wakeEvent: { id: event.id, kind: "context.created", summary: "Use the new service window" }, mission: null, receipt: null });
    expect(context.issueId).toBeUndefined();
    const foreign = await svc.appendEvent(other, { kind: "context.created", subject: "Private", summary: "Other tenant policy", missionId: null, projectId: null, entityIds: [], causationId: null, correlationId: null, metadata: {} }, board);
    const denied = await run(b, { organizationEventId: foreign.id });
    await expect(compileOrganizationContext(db, denied, denied.contextSnapshot!)).rejects.toMatchObject({ status: 403 });
  });
  it("keeps superseded structural truth and causal incident history", async () => {
    const m = await mission();
    const first = await svc.saveKnowledge(c, null, knowledge("A", m.id), 0, board);
    const second = await svc.saveKnowledge(c, null, knowledge("B", m.id), 0, board);
    const old = await svc.addRelationship(c, { sourceId: first.id, targetId: second.id, kind: "OWNS", provenance: "Initial", confidence: 0.9, supersedesId: null, metadata: {} }, board);
    const replacement = await svc.addRelationship(c, { sourceId: first.id, targetId: first.id, kind: "OWNS", provenance: "Ownership changed", confidence: 1, supersedesId: old.id, metadata: {} }, board);
    expect((await svc.listRelationships(c)).map(r => r.id)).toEqual([replacement.id]);
    expect(await svc.listRelationships(c, true)).toHaveLength(2);
    let cause: string | null = null;
    const chain: string[] = [];
    for (const kind of ["incident", "investigation", "decision", "change", "resolution"]) {
      const event = await svc.appendEvent(c, { kind, subject: kind, summary: "Evidence", missionId: m.id, projectId, entityIds: [first.id], causationId: cause, correlationId: first.id, metadata: {} }, asAgent(a));
      cause = event.id; chain.push(event.id);
    }
    const history = await svc.listEvents(c, { entityId: first.id });
    expect(history.filter(e => chain.includes(e.id))).toHaveLength(5);
    expect(history.find(e => e.id === chain[4])?.causationId).toBe(chain[3]);
    await expect(svc.appendEvent(other, { kind: "invalid", subject: "x", summary: "x", missionId: null, projectId: null, entityIds: [], causationId: cause, correlationId: null, metadata: {} }, board)).rejects.toMatchObject({ status: 400 });
  });
  it("preserves deltas on failed runs, consumes only successful packs, excludes unrelated history", async () => {
    await svc.saveContract(c, b, contract(), 0, board); const m = await mission();
    const unrelatedProject = (await db.insert(projects).values({ companyId: c, name: "Unrelated project" }).returning())[0];
    await svc.saveKnowledge(c, null, knowledge("Hidden unrelated project", null, unrelatedProject.id), 0, board);
    await svc.saveKnowledge(other, null, { ...knowledge("Other tenant data", null, null) }, 0, board);
    const failed = await run(b, { organizationMissionId: m.id });
    const initial = await compileOrganizationContext(db, failed, failed.contextSnapshot!);
    expect(JSON.stringify(initial?.pack)).not.toContain("Hidden unrelated"); expect(JSON.stringify(initial?.pack)).not.toContain("Other tenant data");
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, failed.id)); await settleOrganizationRuns(db);
    const retry = await run(b, { organizationMissionId: m.id }); const retried = await compileOrganizationContext(db, retry, retry.contextSnapshot!);
    expect(retried!.eventIds).toEqual(expect.arrayContaining(initial!.eventIds));
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, retry.id)); await settleOrganizationRuns(db);
    const later = await run(b, { organizationMissionId: m.id }); const delta = await compileOrganizationContext(db, later, later.contextSnapshot!);
    expect((delta!.pack.changes as { id: string }[]).map(e => e.id).filter(id => initial!.eventIds.includes(id))).toEqual([]);
    expect((await compileOrganizationContext(db, later, later.contextSnapshot!))?.id).toBe(delta!.id);
    await expect(svc.getPack(other, later.id)).rejects.toMatchObject({ status: 404 });
  });
  it("bounds oversized context and acknowledges only events actually included", async () => {
    await svc.saveContract(c, b, { ...contract(), purpose: "x".repeat(20000) }, 0, board);
    const m = await svc.saveMission(c, null, { ...missionInput(), objective: "x".repeat(20000) }, 0, board);
    for (let n = 0; n < 6; n++) await svc.saveWorkstream(c, m.id, null, workstreamSchema.parse({ title: "Large boundary set", objective: "Bound context", ownerAgentId: b, participantAgentIds: [], status: "planned", dependencyIds: [], acceptanceCriteria: [], constraints: [], executionWorkspaceId: null, boundaries: Array.from({ length: 20 }, (_, i) => ({ kind: "service", resource: String(i).padEnd(500, "x") })) }), 0, board);
    for (let i = 0; i < 15; i++) await svc.appendEvent(c, { kind: "context.created", subject: "Large event", summary: "x".repeat(20000), missionId: m.id, projectId: null, entityIds: [], causationId: null, correlationId: null, metadata: {} }, board);
    const r = await run(b, { organizationMissionId: m.id });
    const pack = await compileOrganizationContext(db, r, r.contextSnapshot!);
    expect(JSON.stringify(pack!.pack).length).toBeLessThanOrEqual(100000);
    expect(pack!.eventIds).toEqual((pack!.pack.changes as { id: string }[]).map(e => e.id));
    expect(pack!.pack).toMatchObject({ contract: { version: 1 }, mission: { id: m.id } });
  });
  it("detects generic and nested path conflicts without sibling-prefix false positives", () => {
    expect(boundariesOverlap({ kind: "path", resource: "src/auth" }, { kind: "path", resource: "src/auth/api" })).toBe(true);
    expect(boundariesOverlap({ kind: "path", resource: "src/auth" }, { kind: "path", resource: "src/authors" })).toBe(false);
    expect(boundariesOverlap({ kind: "territory", resource: "North" }, { kind: "territory", resource: "North" })).toBe(true);
    expect(boundariesOverlap({ kind: "service", resource: "billing", repository: "A" }, { kind: "service", resource: "billing", repository: "B" })).toBe(false);
  });
  it("enforces restrictive company/contract intersections inside domain transactions", async () => {
    await svc.saveContract(c, a, { ...contract(), policy: { defaultMode: "allowed", permissions: { "mission.update": "owned_only", "knowledge.write": "denied" } } }, 0, board);
    const m = await svc.saveMission(c, null, { ...missionInput(), ownerAgentId: b }, 0, board);
    await expect(svc.saveMission(c, m.id, { ...m.data, ownerAgentId: a }, 1, asAgent(a))).rejects.toMatchObject({ status: 403 });
    await expect(svc.saveKnowledge(c, null, knowledge("Disallowed", m.id), 0, asAgent(a))).rejects.toMatchObject({ status: 403 });
    await db.update(companies).set({ organizationPolicy: { defaultMode: "allowed", permissions: { "mission.create": "denied" } } }).where(eq(companies.id, c));
    await expect(svc.saveMission(c, null, missionInput(), 0, asAgent(a))).rejects.toMatchObject({ status: 403 });
    await svc.saveContract(c, a, { ...contract(), policy: { defaultMode: "allowed", permissions: { "mission.create": "allowed" } } }, 1, board);
    await expect(svc.saveMission(c, null, missionInput(), 0, asAgent(a))).rejects.toMatchObject({ status: 403 });
    expect((await request(app(c, a)).put(`/api/companies/${c}/organization/contracts/${a}`).send({ expectedVersion: 2, contract: contract() })).status).toBe(403);
  });
  it("enforces scoped resource reads using persisted ownership rather than query hints", async () => {
    const owned = await mission();
    const foreign = await svc.saveMission(c, null, { ...missionInput(), ownerAgentId: b, participantAgentIds: [b] }, 0, board);
    await svc.saveContract(c, a, { ...contract(), policy: { defaultMode: "allowed", permissions: { "mission.read": "owned_only" } } }, 0, board);
    const root = `/api/companies/${c}/organization`;
    expect((await request(app(c, a)).get(`${root}/missions/${owned.id}`)).status).toBe(200);
    expect((await request(app(c, a)).get(`${root}/missions/${foreign.id}?ownerAgentId=${a}`)).status).toBe(403);
    expect((await request(app(c, a)).get(`${root}/contracts/${a}`)).status).toBe(200);
    expect((await request(app(c, a)).get(`${root}/contracts/${b}`)).status).toBe(403);
    expect((await request(app(c, a)).get(`${root}/missions`)).status).toBe(403);
  });
  it("rejects protected event spoofing and records observation authority", async () => {
    const m = await mission();
    const observation = { kind: "finding.observed", subject: "Evidence", summary: "Observed fact", missionId: m.id, projectId: projectId, entityIds: [], causationId: null, correlationId: null, metadata: {} };
    for (const kind of ["mission.started", "mission.completed", "run.completed", "contract.updated", "paperclip.evidence_recorded"]) {
      expect((await request(app(c, a)).post(`/api/companies/${c}/organization/events`).send({ ...observation, kind })).status).toBe(403);
    }
    const e = await svc.appendEvent(c, observation, asAgent(a));
    expect(e.origin).toBe("employee");
    expect((await svc.listEvents(c, { missionId: m.id })).find(e => e.kind === "mission.started")?.origin).toBe("system");
    expect((await request(app(c, a)).post(`/api/companies/${c}/organization/events`).send({ ...observation, origin: "system" })).status).toBe(400);
  });
  it("drains a 100-event backlog in deterministic pages and never advances failed runs", async () => {
    const m = await mission();
    for (let index = 0; index < 100; index++) await svc.appendEvent(c, { kind: "finding.observed", subject: `Finding ${index}`, summary: "Relevant delta", missionId: m.id, projectId, entityIds: [], causationId: null, correlationId: null, metadata: {} }, board);
    const failed = await run(a, {}, "failed");
    const initial = await compileOrganizationContext(db, failed, { organizationMissionId: m.id });
    expect((initial!.pack.delta as { hasMore: boolean }).hasMore).toBe(true);
    await settleOrganizationRuns(db);
    const delivered: string[] = [];
    let last = 0;
    for (let index = 0; index < 5; index++) {
      const r = await run(a, {}, "succeeded");
      const pack = await compileOrganizationContext(db, r, { organizationMissionId: m.id });
      const changes = pack!.pack.changes as { id: string; kind: string; sequence: number }[];
      if (!index) expect(changes.map(e => e.id)).toEqual((initial!.pack.changes as { id: string }[]).map(e => e.id));
      for (const e of changes) { expect(e.sequence).toBeGreaterThan(last); last = e.sequence; if (e.kind === "finding.observed") delivered.push(e.id); }
      await settleOrganizationRuns(db);
    }
    expect(delivered).toHaveLength(100); expect(new Set(delivered).size).toBe(100);
  }, 30000);
  it("includes all linked goals even when another employee owns them", async () => {
    const [linked, unrelated] = [randomUUID(), randomUUID()];
    await db.insert(goals).values([{ id: linked, companyId: c, title: "Linked specialist outcome", level: "agent", ownerAgentId: b }, { id: unrelated, companyId: c, title: "Unrelated outcome", level: "agent", ownerAgentId: b }]);
    const m = await svc.saveMission(c, null, { ...missionInput(), goalIds: [goalId, linked] }, 0, board);
    await db.update(companies).set({ mission: "Long-term company purpose" }).where(eq(companies.id, c));
    const pack = await compileOrganizationContext(db, await run(a, {}), { organizationMissionId: m.id });
    expect(pack!.pack.companyMission).toBe("Long-term company purpose");
    expect((pack!.pack.goals as { id: string }[]).map(g => g.id)).toEqual(expect.arrayContaining([goalId, linked]));
    expect(JSON.stringify(pack!.pack.goals)).not.toContain(unrelated);
  });
  it("routes to a company specialist outside mission membership and preserves reply ownership", async () => {
    await svc.saveContract(c, a, { ...contract(["receipt.response_received"]), capabilities: [] }, 0, board);
    await svc.saveContract(c, b, { ...contract(["receipt.received"]), serviceExposures: [{ capability: "research", scope: "company" }] }, 0, board);
    const m = await svc.saveMission(c, null, { ...missionInput(), participantAgentIds: [a] }, 0, board);
    const receipt = await svc.sendReceipt(c, receiptSchema.parse({ missionId: m.id, senderAgentId: a, capability: "research", kind: "investigation_request", subject: "Specialist request", payload: {}, idempotencyKey: randomUUID() }), asAgent(a));
    expect(receipt.recipientAgentId).toBe(b);
    expect((await db.select().from(organizationDeliveries).where(eq(organizationDeliveries.receiptId, receipt.id)))).toHaveLength(1);
    const pack = await compileOrganizationContext(db, await run(b, {}), { organizationReceiptId: receipt.id });
    expect(pack!.pack.mission).toMatchObject({ id: m.id });
    await svc.sendReceipt(c, receiptSchema.parse({ missionId: m.id, senderAgentId: b, recipientAgentId: a, parentReceiptId: receipt.id, kind: "result", subject: "Evidence", payload: {}, idempotencyKey: randomUUID() }), asAgent(b));
    expect((await svc.getMission(c, m.id)).data).toMatchObject({ ownerAgentId: a, participantAgentIds: [a] });
    const extra = randomUUID(); await db.insert(agents).values({ id: extra, companyId: c, name: "Another provider" });
    await svc.saveContract(c, extra, { ...contract(), serviceExposures: [{ capability: "research", scope: "company" }] }, 0, board);
    await expect(svc.sendReceipt(c, receiptSchema.parse({ missionId: m.id, senderAgentId: a, capability: "research", kind: "information_request", subject: "Ambiguous", payload: {}, idempotencyKey: randomUUID() }), asAgent(a))).rejects.toMatchObject({ status: 409 });
  });
  it("retrieves old explicit knowledge and its current graph neighborhood before new unrelated records", async () => {
    const m = await mission();
    const old = await svc.saveKnowledge(c, null, knowledge("Older relevant evidence", m.id), 0, board);
    const neighbor = await svc.saveKnowledge(c, null, knowledge("Structural dependency", m.id), 0, board);
    await svc.addRelationship(c, { sourceId: old.id, targetId: neighbor.id, kind: "DEPENDS_ON", provenance: "Verified", confidence: 1, supersedesId: null, metadata: {} }, board);
    for (let i = 0; i < 24; i++) await svc.saveKnowledge(c, null, knowledge(`New unrelated ${i}`, null, null), 0, board);
    await svc.saveMission(c, m.id, { ...m.data, metadata: { entityIds: [old.id] } }, 1, board);
    const pack = await compileOrganizationContext(db, await run(a, {}), { organizationMissionId: m.id });
    const ids = (pack!.pack.knowledge as { id: string }[]).map(e => e.id);
    expect(ids.slice(0, 2)).toEqual(expect.arrayContaining([old.id, neighbor.id]));
    expect(JSON.stringify(pack!.pack.knowledge)).not.toContain("New unrelated");
  });
  it("ingests canonical activity evidence once with trusted origin and source provenance", async () => {
    const m = await mission();
    const issueId = randomUUID(); await db.insert(issues).values({ id: issueId, companyId: c, projectId, title: "Evidence-bearing work" });
    await db.insert(activityLog).values({ companyId: c, actorType: "agent", actorId: a, action: "issue.work_product_created", entityType: "issue", entityId: issueId });
    await ingestOrganizationEvidence(db); await ingestOrganizationEvidence(db);
    const events = (await svc.listEvents(c, { missionId: m.id })).filter(e => e.kind === "paperclip.evidence_recorded");
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ origin: "system", metadata: { source: "activity", originalActorId: a } });
    expect((await svc.listEvents(other)).filter(e => e.kind === "paperclip.evidence_recorded")).toHaveLength(0);
  });

});
