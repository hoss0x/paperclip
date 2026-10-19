import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { agents, companies, goals, projects, executionWorkspaces, employeeContracts, missions, missionWorkstreams,
  organizationReceipts, contextEvents, knowledgeEntities, knowledgeRelationships, organizationDeliveries,
  organizationContextPacks, organizationContextCursors, heartbeatRuns, type Db } from "@paperclipai/db";
import type { EmployeeContract, MissionInput, WorkstreamInput, ReceiptInput, ContextEventInput, KnowledgeEntityInput, KnowledgeRelationshipInput, OwnershipBoundary } from "@paperclipai/shared";
import { reservedOrganizationEventKind } from "@paperclipai/shared";
import { assertOrganizationPermission } from "./organization-policy.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";

export interface OrganizationActor { actorType: "agent" | "user" | "system"; actorId: string; runId?: string | null }
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Reader = Pick<Db, "select">;
const scoped = (table: { id: typeof missions.id; companyId: typeof missions.companyId }, companyId: string, id: string) => and(eq(table.companyId, companyId), eq(table.id, id));
// Segmented containment avoids false conflicts between e.g. /sales and /salesforce.
export function boundariesOverlap(a: OwnershipBoundary, b: OwnershipBoundary): boolean {
  if (a.kind !== b.kind || (a.repository ?? "") !== (b.repository ?? "")) return false;
  const normalize = (v: string) => v.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const left = normalize(a.resource), right = normalize(b.resource);
  if (a.kind !== "path") return left === right;
  return left === right || left === "." || right === "." || left === "" || right === "" || left.startsWith(right + "/") || right.startsWith(left + "/");
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ":" + canonicalJson(v)).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}
function assertSelf(actor: OrganizationActor, agentId: string) {
  if (actor.actorType === "agent" && actor.actorId !== agentId) throw forbidden("Employees must act as themselves");
}
export function companyOsService(db: Db) {
  async function one(reader: Reader, table: typeof missions, companyId: string, id: string) {
    const [row] = await reader.select().from(table).where(scoped(table, companyId, id));
    if (!row) throw notFound("Organization resource not found");
    return row;
  }
  async function checkAgent(reader: Reader, companyId: string, agentId: string) {
    const [row] = await reader.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)));
    if (!row) throw badRequest("Employee is not in this company");
    return row;
  }
  async function validateReferences(tx: Reader, companyId: string, data: { ownerAgentId?: string | null; participantAgentIds?: string[]; goalIds?: string[]; projectIds?: string[] }) {
    for (const id of new Set([data.ownerAgentId, ...(data.participantAgentIds ?? [])].filter((v): v is string => Boolean(v)))) await checkAgent(tx, companyId, id);
    for (const id of data.goalIds ?? []) {
      if (!(await tx.select({ id: goals.id }).from(goals).where(and(eq(goals.companyId, companyId), eq(goals.id, id))))[0]) throw badRequest("Goal is not in this company");
    }
    for (const id of data.projectIds ?? []) {
      if (!(await tx.select({ id: projects.id }).from(projects).where(and(eq(projects.companyId, companyId), eq(projects.id, id))))[0]) throw badRequest("Project is not in this company");
    }
  }
  async function mutate<T>(companyId: string, actor: OrganizationActor, fn: (tx: Transaction, publications: ActivityPublication[]) => Promise<T>) {
    const publications: ActivityPublication[] = [];
    const result = await db.transaction(async tx => {
      // Serialize writers, version allocation, references, causal links and overlap checks.
      const [company] = await tx.select().from(companies).where(eq(companies.id, companyId)).for("update");
      if (!company) throw notFound("Company not found");
      if (actor.actorType === "agent") await checkAgent(tx, companyId, actor.actorId);
      return fn(tx, publications);
    });
    publications.forEach(publishActivity);
    return result;
  }
  async function currentContract(reader: Reader, companyId: string, agentId: string) {
    const [row] = await reader.select().from(employeeContracts).where(and(eq(employeeContracts.companyId, companyId), eq(employeeContracts.agentId, agentId))).orderBy(desc(employeeContracts.version)).limit(1);
    return row ?? null;
  }
  async function event(tx: Transaction, publications: ActivityPublication[], companyId: string, actor: OrganizationActor, data: ContextEventInput, direct?: { agentId: string; receiptId: string }, origin: "system" | "employee" | "board" | "integration" = "system") {
    if (data.missionId) await one(tx, missions, companyId, data.missionId);
    await validateReferences(tx, companyId, { projectIds: data.projectId ? [data.projectId] : [] });
    if (data.causationId && !(await tx.select().from(contextEvents).where(and(eq(contextEvents.companyId, companyId), eq(contextEvents.id, data.causationId))))[0]) throw badRequest("Cause is not in this company");
    for (const id of data.entityIds) {
      if (!(await tx.select({ id: knowledgeEntities.id }).from(knowledgeEntities).where(and(eq(knowledgeEntities.companyId, companyId), eq(knowledgeEntities.id, id))))[0]) throw badRequest("Knowledge entity is not in this company");
    }
    const [created] = await tx.insert(contextEvents).values({ ...data, companyId, origin, actorType: actor.actorType, actorId: actor.actorId, runId: actor.runId ?? null }).returning();
    await logActivity(tx as unknown as Db, { companyId, ...actor, agentId: actor.actorType === "agent" ? actor.actorId : null, action: data.kind, entityType: "context_event", entityId: created.id,
      details: { subject: data.subject, missionId: data.missionId, causationId: data.causationId } }, publications);
    const contracts = await tx.select().from(employeeContracts).where(eq(employeeContracts.companyId, companyId)).orderBy(desc(employeeContracts.version));
    const visited = new Set<string>();
    const mission = data.missionId ? await one(tx, missions, companyId, data.missionId) : null;
    for (const contract of contracts) {
      if (visited.has(contract.agentId)) continue;
      visited.add(contract.agentId);
      if (direct && contract.agentId !== direct.agentId) continue;
      if (!direct && actor.actorType === "agent" && contract.agentId === actor.actorId) continue;
      if (!direct && mission && ![mission.data.ownerAgentId, ...mission.data.participantAgentIds].includes(contract.agentId)) continue;
      if (!(contract.contract.eventSubscriptions as string[]).includes(data.kind)) continue;
      await tx.insert(organizationDeliveries).values({ companyId, eventId: created.id, agentId: contract.agentId,
        missionId: data.missionId, receiptId: direct?.receiptId ?? null, reason: data.kind }).onConflictDoNothing();
    }
    return created;
  }
  const eventData = (kind: string, subject: string, summary: string, missionId: string | null = null): ContextEventInput => ({ kind, subject, summary, missionId, projectId: null, entityIds: [], causationId: null, correlationId: null, metadata: {} });
  async function requireMissionParticipant(reader: Reader, companyId: string, missionId: string, agentId: string) {
    const mission = await one(reader, missions, companyId, missionId);
    if (![mission.data.ownerAgentId, ...mission.data.participantAgentIds].includes(agentId)) throw badRequest("Employee must participate in the mission");
    return mission;
  }
  const svc = {
    currentContract: (companyId: string, agentId: string) => currentContract(db, companyId, agentId),
    contractHistory: (companyId: string, agentId: string) => db.select().from(employeeContracts).where(and(eq(employeeContracts.companyId, companyId), eq(employeeContracts.agentId, agentId))).orderBy(desc(employeeContracts.version)).limit(100),
    saveContract: (companyId: string, agentId: string, contract: EmployeeContract, expectedVersion: number, actor: OrganizationActor) => mutate(companyId, actor, async (tx, pubs) => {
      if (actor.actorType !== "user") throw forbidden("Board access required to change contracts");
      await checkAgent(tx, companyId, agentId);
      for (const exposure of contract.serviceExposures ?? []) if (exposure.orgRootAgentId) await checkAgent(tx, companyId, exposure.orgRootAgentId);
      const current = await currentContract(tx, companyId, agentId);
      if ((current?.version ?? 0) !== expectedVersion) throw conflict("Contract changed; reload before saving");
      const [revision] = await tx.insert(employeeContracts).values({ companyId, agentId, version: expectedVersion + 1, contract, actorId: actor.actorId, runId: actor.runId ?? null }).returning();
      await event(tx, pubs, companyId, actor, { ...eventData("contract.updated", "Employee contract updated", `Contract version ${revision.version}`), metadata: { agentId, contractVersion: revision.version } });
      return revision;
    }),
    listMissions: (companyId: string) => db.select().from(missions).where(eq(missions.companyId, companyId)).orderBy(desc(missions.updatedAt)).limit(200),
    getMission: (companyId: string, id: string) => one(db, missions, companyId, id),
    saveMission: (companyId: string, id: string | null, data: MissionInput, expectedVersion: number, actor: OrganizationActor) => mutate(companyId, actor, async (tx, pubs) => {
      await validateReferences(tx, companyId, data);
      const current = id ? await one(tx, missions, companyId, id) : null;
      await assertOrganizationPermission(tx, companyId, actor, id ? "mission.update" : "mission.create", current?.data ?? data);
      if (data.status === "completed") await assertOrganizationPermission(tx, companyId, actor, "mission.complete", current?.data ?? data);
      if ((current?.version ?? 0) !== expectedVersion) throw conflict("Mission changed; reload before saving");
      data = { ...data,
        startedAt: data.startedAt ?? (data.status === "active" ? new Date().toISOString() : null),
        endedAt: data.endedAt ?? (["completed", "cancelled"].includes(data.status) ? new Date().toISOString() : null),
      };
      if (data.startedAt && data.endedAt && data.startedAt > data.endedAt) throw badRequest("End precedes start");
      const values = { data, updatedAt: new Date(), version: expectedVersion + 1 };
      const [saved] = id ? await tx.update(missions).set(values).where(scoped(missions, companyId, id)).returning() : await tx.insert(missions).values({ ...values, companyId }).returning();
      const kind = data.status === "active" && current?.data.status !== "active" ? "mission.started" : data.status === "completed" ? "mission.completed" : data.status === "stalled" ? "mission.stalled" : "mission.updated";
      await event(tx, pubs, companyId, actor, eventData(kind, data.title, data.summary || data.objective, saved.id));
      return saved;
    }),
    listWorkstreams: (companyId: string, missionId: string) => db.select().from(missionWorkstreams).where(and(eq(missionWorkstreams.companyId, companyId), eq(missionWorkstreams.missionId, missionId))).orderBy(asc(missionWorkstreams.createdAt)).limit(200),
    saveWorkstream: (companyId: string, missionId: string, id: string | null, data: WorkstreamInput, expectedVersion: number, actor: OrganizationActor) => mutate(companyId, actor, async (tx, pubs) => {
      const mission = await one(tx, missions, companyId, missionId);
      await validateReferences(tx, companyId, data);
      for (const agentId of [data.ownerAgentId, ...data.participantAgentIds]) if (agentId && ![mission.data.ownerAgentId, ...mission.data.participantAgentIds].includes(agentId)) throw badRequest("Workstream employees must participate in the mission");
      if (data.executionWorkspaceId) {
        const [workspace] = await tx.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.companyId, companyId), eq(executionWorkspaces.id, data.executionWorkspaceId)));
        if (!workspace || !mission.data.projectIds.includes(workspace.projectId)) throw badRequest("Workspace must belong to a linked project");
      }
      const all = await tx.select().from(missionWorkstreams).where(eq(missionWorkstreams.companyId, companyId));
      const current = id ? all.find(w => w.id === id && w.missionId === missionId) : null;
      if (id && !current) throw notFound("Workstream not found");
      await assertOrganizationPermission(tx, companyId, actor, id ? "workstream.update" : "workstream.create", current?.data ?? mission.data);
      if ((current?.version ?? 0) !== expectedVersion) throw conflict("Workstream changed; reload before saving");
      for (const dependencyId of data.dependencyIds) {
        const dep = all.find(w => w.id === dependencyId && w.missionId === missionId);
        if (!dep || dependencyId === id) throw badRequest("Invalid workstream dependency");
        const reaches = (node: string, seen = new Set<string>()): boolean => {
          if (node === id) return true;
          if (seen.has(node)) return false;
          seen.add(node);
          return (all.find(w => w.id === node)?.data.dependencyIds ?? []).some(next => reaches(next, seen));
        };
        if (id && reaches(dependencyId)) throw conflict("Workstream dependencies contain a cycle");
      }
      if (["active", "blocked"].includes(data.status)) {
        const overlapping = all.filter(w => w.id !== id && ["active", "blocked"].includes(w.data.status) && w.data.boundaries.some(a => data.boundaries.some(b => boundariesOverlap(a, b))));
        if (overlapping.length) throw conflict("Active ownership overlaps another workstream", { workstreamIds: overlapping.map(w => w.id) });
      }
      const values = { data, updatedAt: new Date(), version: expectedVersion + 1 };
      const [saved] = id ? await tx.update(missionWorkstreams).set(values).where(and(eq(missionWorkstreams.companyId, companyId), eq(missionWorkstreams.id, id))).returning() : await tx.insert(missionWorkstreams).values({ ...values, companyId, missionId }).returning();
      await event(tx, pubs, companyId, actor, eventData("workstream.updated", data.title, data.objective, missionId));
      return saved;
    }),
    listReceipts: (companyId: string, filter: { missionId?: string; agentId?: string }) => db.select().from(organizationReceipts).where(and(eq(organizationReceipts.companyId, companyId), filter.missionId ? eq(organizationReceipts.missionId, filter.missionId) : undefined,
      filter.agentId ? or(eq(organizationReceipts.senderAgentId, filter.agentId), eq(organizationReceipts.recipientAgentId, filter.agentId)) : undefined)).orderBy(desc(organizationReceipts.createdAt)).limit(200),
    getReceipt: async (companyId: string, id: string) => {
      const [row] = await db.select().from(organizationReceipts).where(and(eq(organizationReceipts.companyId, companyId), eq(organizationReceipts.id, id)));
      if (!row) throw notFound("Receipt not found");
      return row;
    },
    sendReceipt: (companyId: string, input: ReceiptInput, actor: OrganizationActor) => mutate(companyId, actor, async (tx, pubs) => {
      assertSelf(actor, input.senderAgentId);
      await checkAgent(tx, companyId, input.senderAgentId);
      const mission = await one(tx, missions, companyId, input.missionId);
      const [replyParent] = input.parentReceiptId ? await tx.select().from(organizationReceipts).where(and(eq(organizationReceipts.companyId, companyId), eq(organizationReceipts.id, input.parentReceiptId))) : [];
      const replying = replyParent?.missionId === input.missionId && replyParent.recipientAgentId === input.senderAgentId;
      if (!replying) await requireMissionParticipant(tx, companyId, input.missionId, input.senderAgentId);
      await assertOrganizationPermission(tx, companyId, actor, "receipt.send", { ...mission.data, assignedAgentId: replying ? input.senderAgentId : undefined });
      if (input.kind === "decision_request") await assertOrganizationPermission(tx, companyId, actor, "receipt.request_decision", mission.data);
      if (input.projectId && !mission.data.projectIds.includes(input.projectId)) throw badRequest("Receipt project must be linked to the mission");
      const [existing] = await tx.select().from(organizationReceipts).where(and(eq(organizationReceipts.companyId, companyId), eq(organizationReceipts.senderAgentId, input.senderAgentId), eq(organizationReceipts.idempotencyKey, input.idempotencyKey)));
      if (existing) {
        const comparable = ["missionId", "projectId", "kind", "subject", "parentReceiptId", "capability", "priority"] as const;
        if (comparable.some(k => (existing[k] ?? null) !== (input[k] ?? null)) || canonicalJson(existing.payload) !== canonicalJson(input.payload) || canonicalJson(existing.metadata) !== canonicalJson(input.metadata) || (input.recipientAgentId && input.recipientAgentId !== existing.recipientAgentId)) throw conflict("Receipt key already used for another request");
        return existing;
      }
      let recipientAgentId = input.recipientAgentId;
      if (!recipientAgentId) {
        const contracts = await tx.select().from(employeeContracts).where(eq(employeeContracts.companyId, companyId)).orderBy(desc(employeeContracts.version));
        const seen = new Set<string>();
        const advertised = contracts.filter(c => {
          if (seen.has(c.agentId)) return false;
          seen.add(c.agentId);
          return [...c.contract.capabilities, ...c.contract.servicesProvided, ...(c.contract.serviceExposures ?? []).map(e => e.capability)].includes(input.capability!);
        });
        const matches = [];
        const employees = await tx.select({ id: agents.id, reportsTo: agents.reportsTo }).from(agents).where(eq(agents.companyId, companyId));
        for (const provider of advertised) {
          const inMission = [mission.data.ownerAgentId, ...mission.data.participantAgentIds].includes(provider.agentId);
          const exposures = (provider.contract.serviceExposures ?? []).filter(e => e.capability === input.capability);
          const exposed = exposures.some(exposure => {
            if (exposure.scope === "company") return true;
            if (exposure.scope === "mission") return inMission;
            const root = exposure.orgRootAgentId ?? provider.agentId;
            let id: string | null = input.senderAgentId;
            const visited = new Set<string>();
            while (id && !visited.has(id)) {
              if (id === root) return true;
              visited.add(id); id = employees.find(e => e.id === id)?.reportsTo ?? null;
            }
            return false;
          });
          // Explicit scope overrides legacy Mission-local advertising.
          if (exposures.length ? !exposed : !inMission) continue;
          try { await assertOrganizationPermission(tx, companyId, { actorType: "agent", actorId: provider.agentId }, "receipt.read", { ...mission.data, assignedAgentId: provider.agentId }); }
          catch (error) { if ((error as { status?: number }).status === 403) continue; throw error; }
          matches.push(provider);
        }
        if (matches.length !== 1) throw conflict("Capability must resolve to exactly one authorized employee", { candidates: matches.map(c => c.agentId) });
        recipientAgentId = matches[0].agentId;
      }
      const recipient = await checkAgent(tx, companyId, recipientAgentId);
      if (["terminated", "pending_approval"].includes(recipient.status)) throw conflict("Recipient is not available");
      if (!input.capability && !replying) await requireMissionParticipant(tx, companyId, input.missionId, recipientAgentId);
      await assertOrganizationPermission(tx, companyId, { actorType: "agent", actorId: recipientAgentId }, "receipt.read", { ...mission.data, assignedAgentId: recipientAgentId });
      let correlationId: string = randomUUID();
      let causeId: string | null = null;
      if (input.parentReceiptId) {
        const [parent] = await tx.select().from(organizationReceipts).where(and(eq(organizationReceipts.companyId, companyId), eq(organizationReceipts.id, input.parentReceiptId)));
        if (!parent || parent.missionId !== input.missionId || parent.recipientAgentId !== input.senderAgentId || parent.senderAgentId !== recipientAgentId) throw badRequest("Reply must reverse the original mission participants");
        correlationId = parent.correlationId;
        const [cause] = await tx.select().from(contextEvents).where(and(eq(contextEvents.companyId, companyId), eq(contextEvents.correlationId, correlationId))).orderBy(desc(contextEvents.createdAt)).limit(1);
        causeId = cause?.id ?? null;
        if (["result", "decision"].includes(input.kind)) await tx.update(organizationReceipts).set({ status: "resolved", resolvedAt: new Date() }).where(and(eq(organizationReceipts.companyId, companyId), eq(organizationReceipts.id, parent.id)));
      }
      const [receipt] = await tx.insert(organizationReceipts).values({ ...input, companyId, recipientAgentId, correlationId, runId: actor.runId ?? null }).returning();
      const kind = input.parentReceiptId ? "receipt.response_received" : input.kind === "review_request" ? "review.requested" : input.kind === "decision_request" ? "decision.requested" : input.kind === "escalation" ? "employee.escalation" : "receipt.received";
      await event(tx, pubs, companyId, actor, { ...eventData(kind, input.subject, `Receipt ${input.kind}`, input.missionId), correlationId, causationId: causeId, projectId: input.projectId, metadata: { receiptId: receipt.id, senderAgentId: input.senderAgentId, recipientAgentId } }, { agentId: recipientAgentId, receiptId: receipt.id });
      return receipt;
    }),
    acknowledgeReceipt: (companyId: string, id: string, actor: OrganizationActor) => mutate(companyId, actor, async (tx, pubs) => {
      const [receipt] = await tx.select().from(organizationReceipts).where(and(eq(organizationReceipts.companyId, companyId), eq(organizationReceipts.id, id)));
      if (!receipt) throw notFound("Receipt not found");
      assertSelf(actor, receipt.recipientAgentId);
      await assertOrganizationPermission(tx, companyId, actor, "receipt.acknowledge", { assignedAgentId: receipt.recipientAgentId });
      if (receipt.status !== "sent") return receipt;
      const [updated] = await tx.update(organizationReceipts).set({ status: "acknowledged", acknowledgedAt: new Date() }).where(and(eq(organizationReceipts.companyId, companyId), eq(organizationReceipts.id, id))).returning();
      await event(tx, pubs, companyId, actor, { ...eventData("receipt.acknowledged", receipt.subject, "Receipt acknowledged", receipt.missionId), correlationId: receipt.correlationId });
      return updated;
    }),
    appendEvent: (companyId: string, data: ContextEventInput, actor: OrganizationActor) => mutate(companyId, actor, async (tx, pubs) => {
      if (reservedOrganizationEventKind(data.kind)) throw forbidden("Lifecycle events are generated only by trusted domain services");
      const mission = data.missionId ? await one(tx, missions, companyId, data.missionId) : null;
      await assertOrganizationPermission(tx, companyId, actor, "event.emit", mission?.data);
      return event(tx, pubs, companyId, actor, data, undefined, actor.actorType === "agent" ? "employee" : actor.actorType === "user" ? "board" : "system");
    }),
    listEvents: (companyId: string, filter: { missionId?: string; entityId?: string; correlationId?: string; before?: string } = {}) => db.select().from(contextEvents).where(and(eq(contextEvents.companyId, companyId), filter.missionId ? eq(contextEvents.missionId, filter.missionId) : undefined,
      filter.entityId ? sql`${contextEvents.entityIds} @> ${JSON.stringify([filter.entityId])}::jsonb` : undefined, filter.correlationId ? eq(contextEvents.correlationId, filter.correlationId) : undefined,
      filter.before ? sql`${contextEvents.createdAt} < ${filter.before}::timestamptz` : undefined)).orderBy(desc(contextEvents.createdAt), desc(contextEvents.id)).limit(100),
    listKnowledge: (companyId: string, query = "") => db.select().from(knowledgeEntities).where(and(eq(knowledgeEntities.companyId, companyId), query ? sql`(${knowledgeEntities.data}->>'name' ilike ${"%" + query + "%"} or ${knowledgeEntities.data}->>'summary' ilike ${"%" + query + "%"})` : undefined)).orderBy(desc(knowledgeEntities.updatedAt)).limit(200),
    saveKnowledge: (companyId: string, id: string | null, data: KnowledgeEntityInput, expectedVersion: number, actor: OrganizationActor) => mutate(companyId, actor, async (tx, pubs) => {
      const mission = data.missionId ? await one(tx, missions, companyId, data.missionId) : null;
      await assertOrganizationPermission(tx, companyId, actor, "knowledge.write", mission?.data);
      await validateReferences(tx, companyId, { projectIds: data.projectId ? [data.projectId] : [] });
      const [current] = id ? await tx.select().from(knowledgeEntities).where(and(eq(knowledgeEntities.companyId, companyId), eq(knowledgeEntities.id, id))) : [];
      if (id && !current) throw notFound("Knowledge entity not found");
      if ((current?.version ?? 0) !== expectedVersion) throw conflict("Knowledge changed; reload before saving");
      const values = { data, version: expectedVersion + 1, updatedAt: new Date() };
      const [saved] = id ? await tx.update(knowledgeEntities).set(values).where(and(eq(knowledgeEntities.companyId, companyId), eq(knowledgeEntities.id, id))).returning() : await tx.insert(knowledgeEntities).values({ ...values, companyId }).returning();
      await event(tx, pubs, companyId, actor, { ...eventData("knowledge.updated", data.name, data.summary, data.missionId), entityIds: [saved.id], projectId: data.projectId, metadata: { previous: current?.data ?? null, current: data, version: saved.version } });
      return saved;
    }),
    listRelationships: (companyId: string, historical = false) => db.select().from(knowledgeRelationships).where(and(eq(knowledgeRelationships.companyId, companyId), historical ? undefined : isNull(knowledgeRelationships.validTo))).orderBy(desc(knowledgeRelationships.validFrom)).limit(500),
    addRelationship: (companyId: string, data: KnowledgeRelationshipInput, actor: OrganizationActor) => mutate(companyId, actor, async (tx, pubs) => {
      await assertOrganizationPermission(tx, companyId, actor, "knowledge.write");
      const entities = await tx.select().from(knowledgeEntities).where(and(eq(knowledgeEntities.companyId, companyId), inArray(knowledgeEntities.id, [data.sourceId, data.targetId])));
      if (![data.sourceId, data.targetId].every(id => entities.some(e => e.id === id))) throw badRequest("Relationship endpoints must be in this company");
      const now = new Date();
      if (data.supersedesId) {
        const [old] = await tx.select().from(knowledgeRelationships).where(and(eq(knowledgeRelationships.companyId, companyId), eq(knowledgeRelationships.id, data.supersedesId))).for("update");
        if (!old || old.validTo || old.sourceId !== data.sourceId || old.kind !== data.kind) throw conflict("Invalid or superseded relationship");
        await tx.update(knowledgeRelationships).set({ validTo: now }).where(eq(knowledgeRelationships.id, old.id));
      }
      const [saved] = await tx.insert(knowledgeRelationships).values({ ...data, companyId, validFrom: now }).returning();
      await event(tx, pubs, companyId, actor, { ...eventData("knowledge.updated", data.kind, data.provenance), entityIds: [data.sourceId, data.targetId], metadata: { relationshipId: saved.id, supersedesId: data.supersedesId } });
      return saved;
    }),
    getPack: async (companyId: string, runId: string) => {
      const [pack] = await db.select().from(organizationContextPacks).where(and(eq(organizationContextPacks.companyId, companyId), eq(organizationContextPacks.runId, runId)));
      if (!pack) throw notFound("Context pack not found");
      return pack;
    },
  };
  return svc;
}
