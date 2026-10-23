import { and, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import { agents, contextEvents, heartbeatRuns, missions, organizationContextPacks, issues, issueWorkProducts, type Db } from "@paperclipai/db";
import { normalizeRunUsage } from "./work-timeline.js";
import type { OperationsTimelineEntry, OperationsTimelineQuery } from "@paperclipai/shared";

/** Read projection only: every entry retains its canonical source identity. */
export async function readOperationsTimeline(db: Db, companyId: string, query: OperationsTimelineQuery) {
  const limit = 100;
  const before = <T extends typeof contextEvents | typeof heartbeatRuns>(table: T) => query.beforeAt && query.beforeId
    ? or(sql`${table.createdAt} < ${query.beforeAt}::timestamptz`, and(sql`${table.createdAt} = ${query.beforeAt}::timestamptz`, sql`${table.id} < ${query.beforeId}::uuid`)) : undefined;
  const runMissionId = sql<string | null>`coalesce(${organizationContextPacks.missionId}::text, ${heartbeatRuns.contextSnapshot}->>'organizationMissionId')`;
  const runProjectIds = sql`coalesce(${organizationContextPacks.pack}->'mission'->'projectIds', ${missions.data}->'projectIds', '[]'::jsonb)`;
  const runProjectId = sql<string | null>`coalesce(${issues.projectId}::text, case when jsonb_array_length(${runProjectIds}) = 1 then ${runProjectIds}->>0 end)`;
  const runs = query.category && query.category !== "Runs" ? [] : await db.select({
    id: heartbeatRuns.id, at: sql<string>`to_char(${heartbeatRuns.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`, agentId: heartbeatRuns.agentId, agentName: agents.name,
    status: heartbeatRuns.status, startedAt: heartbeatRuns.startedAt, finishedAt: heartbeatRuns.finishedAt,
    usage: heartbeatRuns.usageJson, adapter: sql<string>`coalesce(${heartbeatRuns.runnerProfileJson}->>'adapterType', ${agents.adapterType})`,
    wakeReason: sql<string | null>`${heartbeatRuns.contextSnapshot}->>'wakeReason'`,
    trigger: heartbeatRuns.invocationSource, missionId: runMissionId, missionName: sql<string | null>`coalesce(${organizationContextPacks.pack}->'mission'->>'title', ${missions.data}->>'title')`,
    projectId: runProjectId, issueId: issues.id, issueTitle: issues.title, packId: organizationContextPacks.id,
    receiptId: sql<string | null>`${heartbeatRuns.contextSnapshot}->>'organizationReceiptId'`,
    cost: sql<unknown>`${heartbeatRuns.resultJson}->'costUsd'`,
  }).from(heartbeatRuns)
    .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, companyId)))
    .leftJoin(organizationContextPacks, and(eq(organizationContextPacks.runId, heartbeatRuns.id), eq(organizationContextPacks.companyId, companyId)))
    .leftJoin(missions, and(eq(missions.companyId, companyId), sql`${missions.id}::text = ${runMissionId}`))
    .leftJoin(issues, and(eq(issues.companyId, companyId), sql`${issues.id}::text = ${heartbeatRuns.contextSnapshot}->>'issueId'`))
    .where(and(eq(heartbeatRuns.companyId, companyId), gte(heartbeatRuns.createdAt, new Date(query.from)), lte(heartbeatRuns.createdAt, new Date(query.to)), before(heartbeatRuns),
      query.agentId ? eq(heartbeatRuns.agentId, query.agentId) : undefined,
      query.missionId ? eq(runMissionId, query.missionId) : undefined,
      query.projectId ? or(eq(issues.projectId, query.projectId), sql`${runProjectIds} @> ${JSON.stringify([query.projectId])}::jsonb`) : undefined,
      query.status ? eq(heartbeatRuns.status, query.status) : undefined,
      query.search ? or(ilike(agents.name, `%${query.search}%`), ilike(issues.title, `%${query.search}%`), ilike(sql`${missions.data}->>'title'`, `%${query.search}%`)) : undefined,
    )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(limit + 1);
  const categoryFilter = query.category ? {
    Missions: sql`${contextEvents.kind} like 'mission.%'`, Workstreams: sql`${contextEvents.kind} like 'workstream.%'`,
    Receipts: sql`${contextEvents.kind} like 'receipt.%'`, Knowledge: sql`${contextEvents.kind} like 'knowledge.%'`,
    "Decisions / Escalations": sql`(${contextEvents.kind} like 'decision.%' or ${contextEvents.kind} = 'employee.escalation')`,
    "Issues / Tasks": sql`${contextEvents.metadata}->>'entityType' = 'issue'`,
    "System / Evidence": sql`(${contextEvents.kind} like 'paperclip.%' and coalesce(${contextEvents.metadata}->>'entityType','') <> 'issue')`,
    Runs: sql`false`,
  }[query.category] : undefined;
  const events = await db.select({ event: contextEvents, at: sql<string>`to_char(${contextEvents.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`, agentName: agents.name,
    runAgentId: heartbeatRuns.agentId, status: heartbeatRuns.status, workProductTitle: issueWorkProducts.title,
    missionName: sql<string | null>`${missions.data}->>'title'` })
    .from(contextEvents)
    .leftJoin(heartbeatRuns, and(eq(heartbeatRuns.id, contextEvents.runId), eq(heartbeatRuns.companyId, companyId)))
    .leftJoin(agents, and(eq(agents.companyId, companyId), sql`${agents.id}::text = coalesce(${heartbeatRuns.agentId}::text, case when ${contextEvents.actorType} = 'agent' then ${contextEvents.actorId} end)`))
    .leftJoin(missions, and(eq(missions.companyId, companyId), eq(missions.id, contextEvents.missionId)))
    .leftJoin(issueWorkProducts, and(eq(issueWorkProducts.companyId, companyId), sql`${issueWorkProducts.id}::text = ${contextEvents.metadata}->>'workProductId'`))
    .where(and(eq(contextEvents.companyId, companyId), gte(contextEvents.createdAt, new Date(query.from)), lte(contextEvents.createdAt, new Date(query.to)), before(contextEvents),
      // Completion rows are canonical evidence attached to their Run card,
      // never a second usage-bearing Run entry.
      sql`${contextEvents.kind} <> 'run.completed'`, categoryFilter,
      query.agentId ? or(eq(heartbeatRuns.agentId, query.agentId), and(eq(contextEvents.actorType, "agent"), eq(contextEvents.actorId, query.agentId))) : undefined,
      query.projectId ? eq(contextEvents.projectId, query.projectId) : undefined,
      query.missionId ? eq(contextEvents.missionId, query.missionId) : undefined,
      query.status ? eq(heartbeatRuns.status, query.status) : undefined,
      query.search ? or(ilike(contextEvents.subject, `%${query.search}%`), ilike(contextEvents.summary, `%${query.search}%`)) : undefined,
    )).orderBy(desc(contextEvents.createdAt), desc(contextEvents.id)).limit(limit + 1);
  const entries: OperationsTimelineEntry[] = [
    ...runs.map(r => ({ id: r.id, source: "run" as const, at: r.at, title: r.issueTitle ?? r.missionName ?? "Employee run", category: "Runs", agentId: r.agentId, agentName: r.agentName,
      missionId: r.missionId, missionName: r.missionName, projectId: r.projectId, runId: r.id, status: r.status,
      summary: r.wakeReason ?? r.trigger, usage: normalizeRunUsage(r.usage, r.adapter),
      details: { startedAt: r.startedAt, finishedAt: r.finishedAt, trigger: r.trigger, wakeReason: r.wakeReason, receiptId: r.receiptId, issueId: r.issueId, contextPackId: r.packId, adapter: r.adapter, costUsd: r.cost } })),
    ...events.map(({ event: e, at, agentName, runAgentId, status, missionName, workProductTitle }) => ({ id: e.id, source: "event" as const, at, title: typeof e.metadata.action === "string" ? `${e.metadata.action.replaceAll(".", " ").replaceAll("_", " ")}${workProductTitle ? `: ${workProductTitle}` : ""}` : e.subject, category: eventCategory(e.kind, e.metadata), agentId: runAgentId ?? (e.actorType === "agent" ? e.actorId : null), agentName: agentName ?? (e.actorType === "user" ? "Board" : "System"),
      missionId: e.missionId, missionName, projectId: e.projectId, runId: e.runId, status, summary: e.summary, usage: null,
      details: { kind: e.kind, origin: e.origin, sourceId: e.sourceId, correlationId: e.correlationId, causationId: e.causationId, entityIds: e.entityIds, metadata: e.metadata } })),
  ].sort((a,b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
  const page = entries.slice(0,limit), last = page.at(-1);
  return { entries: page, next: entries.length > limit && last ? { beforeAt: last.at, beforeId: last.id } : null };
}
export function eventCategory(kind: string, metadata: Record<string, unknown>) {
  if (kind.startsWith("mission.")) return "Missions";
  if (kind.startsWith("workstream.")) return "Workstreams";
  if (kind.startsWith("receipt.")) return "Receipts";
  if (kind.startsWith("knowledge.")) return "Knowledge";
  if (kind.startsWith("decision.") || kind === "employee.escalation") return "Decisions / Escalations";
  if (metadata.entityType === "issue") return "Issues / Tasks";
  return "System / Evidence";
}
