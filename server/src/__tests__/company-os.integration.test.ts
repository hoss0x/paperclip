import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, companies, agents, goals, projects, issues, heartbeatRuns, contextEvents, organizationDeliveries, organizationReceipts, organizationContextPacks, agentWakeupRequests, type Db } from "@paperclipai/db";
import { employeeContractSchema, missionSchema, workstreamSchema, receiptSchema, knowledgeEntitySchema } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { companyOsService, boundariesOverlap } from "../services/company-os.js";
import { compileOrganizationContext, dispatchOrganizationDeliveries, renderOrganizationContext, settleOrganizationRuns, scheduleOrganizationReviews } from "../services/company-os-runtime.js";
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
});
