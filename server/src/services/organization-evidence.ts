import { and, asc, eq, sql } from "drizzle-orm";
import { activityLog, companies, contextEvents, issues, missions, projects, executionWorkspaces, type Db } from "@paperclipai/db";

/** Idempotent adapter from canonical Paperclip audit evidence. Never infers a
 * deployment from a branch/PR link. External ingestion can use the same source
 * identity + explicit origin contract without changing the graph schema. */
export async function ingestOrganizationEvidence(db: Db) {
  const candidates = await db.select({ activity: activityLog, projectId: sql<string | null>`coalesce(${issues.projectId}, ${projects.id}, ${executionWorkspaces.projectId})` }).from(activityLog)
    .leftJoin(issues, and(eq(issues.companyId, activityLog.companyId), sql`${issues.id}::text = ${activityLog.entityId}`, eq(activityLog.entityType, "issue")))
    .leftJoin(projects, and(eq(projects.companyId, activityLog.companyId), eq(activityLog.entityType, "project"), sql`${projects.id}::text = ${activityLog.entityId}`))
    .leftJoin(executionWorkspaces, and(eq(executionWorkspaces.companyId, activityLog.companyId), eq(activityLog.entityType, "execution_workspace"), sql`${executionWorkspaces.id}::text = ${activityLog.entityId}`))
    .where(and(sql`(${activityLog.action} like 'work_product.%' or ${activityLog.action} like 'issue.work_product_%' or ${activityLog.action} like 'approval.%' or ${activityLog.action} like 'workspace.%' or ${activityLog.action} like 'project.workspace_%' or ${activityLog.action} like 'execution_workspace.%' or ${activityLog.action} like 'workspace_runtime.%')`,
      sql`not exists (select 1 from ${contextEvents} where ${contextEvents.companyId} = ${activityLog.companyId} and ${contextEvents.sourceId} = 'activity:' || ${activityLog.id}::text)`))
    .orderBy(asc(activityLog.createdAt), asc(activityLog.id)).limit(100);
  for (const { activity, projectId } of candidates) {
    await db.transaction(async tx => {
      // Shared lock discipline orders all event insertions before stream cursors.
      await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, activity.companyId)).for("update");
      const related = projectId ? await tx.select().from(missions).where(and(eq(missions.companyId, activity.companyId), sql`${missions.data}->'projectIds' @> ${JSON.stringify([projectId])}::jsonb`)).orderBy(asc(missions.id)).limit(100) : [];
      const record = { companyId: activity.companyId, kind: "paperclip.evidence_recorded", origin: "system", actorType: "system", actorId: "paperclip-evidence", runId: activity.runId,
        subject: `Paperclip evidence: ${activity.action}`, summary: `${activity.entityType} ${activity.entityId}: ${activity.action}`, projectId,
        metadata: { source: "activity", activityId: activity.id, action: activity.action, entityType: activity.entityType, entityId: activity.entityId, originalActorType: activity.actorType, originalActorId: activity.actorId, workProductId: typeof activity.details?.workProductId === "string" ? activity.details.workProductId : null, observedAt: activity.createdAt.toISOString() } };
      await tx.insert(contextEvents).values({ ...record, sourceId: `activity:${activity.id}` }).onConflictDoNothing();
      for (const mission of related) await tx.insert(contextEvents).values({ ...record, missionId: mission.id, sourceId: `activity:${activity.id}:mission:${mission.id}` }).onConflictDoNothing();
    });
  }
  return candidates.length;
}
