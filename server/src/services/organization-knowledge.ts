import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { knowledgeEntities, knowledgeRelationships, type Db } from "@paperclipai/db";

export interface KnowledgeRetrievalInput {
  companyId: string; agentId: string; missionId: string | null; projectIds: string[];
  references: unknown[]; query: string;
}
export interface KnowledgeRetriever { retrieve(db: Db, input: KnowledgeRetrievalInput): Promise<{ entities: (typeof knowledgeEntities.$inferSelect)[]; relationships: (typeof knowledgeRelationships.$inferSelect)[] }> }
/** Replaceable deterministic retriever. No company-wide newest-N prompt injection. */
export const structuredKnowledgeRetriever: KnowledgeRetriever = {
  async retrieve(db, input) {
    const scope = and(eq(knowledgeEntities.companyId, input.companyId), or(
      input.missionId ? sql`${knowledgeEntities.data}->>'missionId' = ${input.missionId}` : sql`false`,
      input.projectIds.length ? sql`${knowledgeEntities.data}->>'projectId' in (${sql.join(input.projectIds.map(id => sql`${id}`), sql`, `)})` : sql`false`,
      sql`${knowledgeEntities.data}->>'missionId' is null and ${knowledgeEntities.data}->>'projectId' is null`));
    const ids = new Set<string>(); const keys = new Set<string>();
    // Only declared identifiers/ownership references, not arbitrary string values.
    function refs(value: unknown, depth = 0) {
      if (!value || typeof value !== "object" || depth > 5) return;
      if (Array.isArray(value)) { value.slice(0, 100).forEach(v => refs(v, depth + 1)); return; }
      for (const [key, child] of Object.entries(value)) {
        if (["entityIds", "knowledgeEntityIds"].includes(key) && Array.isArray(child)) child.slice(0, 100).forEach(id => { if (typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)) ids.add(id); });
        else if (["resource", "entityKey"].includes(key) && typeof child === "string") keys.add(child);
        else refs(child, depth + 1);
      }
    }
    input.references.forEach(v => refs(v));
    keys.add(input.agentId);
    const selected = new Map<string, typeof knowledgeEntities.$inferSelect>();
    const add = (rows: (typeof knowledgeEntities.$inferSelect)[]) => { for (const row of rows) if (selected.size < 20) selected.set(row.id, row); };
    add(await db.select().from(knowledgeEntities).where(and(scope, or(ids.size ? inArray(knowledgeEntities.id, [...ids].slice(0, 100)) : sql`false`, sql`${knowledgeEntities.data}->>'key' in (${sql.join([...keys].slice(0, 100).map(k => sql`${k}`), sql`, `)})`))).orderBy(asc(knowledgeEntities.id)).limit(20));
    // Bounded two-hop current graph expansion, preserving explicit references first.
    for (let depth = 0; depth < 2 && selected.size && selected.size < 20; depth++) {
      const frontier = [...selected.keys()];
      const edges = await db.select().from(knowledgeRelationships).where(and(eq(knowledgeRelationships.companyId, input.companyId), isNull(knowledgeRelationships.validTo), or(inArray(knowledgeRelationships.sourceId, frontier), inArray(knowledgeRelationships.targetId, frontier)))).orderBy(asc(knowledgeRelationships.id)).limit(60);
      const neighbors = [...new Set(edges.flatMap(r => [r.sourceId, r.targetId]))];
      if (neighbors.length) add(await db.select().from(knowledgeEntities).where(and(scope, inArray(knowledgeEntities.id, neighbors))).orderBy(asc(knowledgeEntities.id)).limit(20));
    }
    const terms = [...new Set(input.query.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? [])].slice(0, 12);
    if (terms.length && selected.size < 20) add(await db.select().from(knowledgeEntities).where(and(scope, or(...terms.map(term => sql`(${knowledgeEntities.data}->>'name' ilike ${'%' + term + '%'} or ${knowledgeEntities.data}->>'summary' ilike ${'%' + term + '%'})`)))).orderBy(desc(knowledgeEntities.updatedAt), asc(knowledgeEntities.id)).limit(20));
    // Fallback remains scoped to mission/projects; unrelated company updates never fill a pack.
    if (!selected.size && input.missionId) add(await db.select().from(knowledgeEntities).where(and(scope, sql`${knowledgeEntities.data}->>'missionId' = ${input.missionId}`)).orderBy(desc(knowledgeEntities.updatedAt), asc(knowledgeEntities.id)).limit(20));
    const foundIds = [...selected.keys()];
    const relationships = foundIds.length ? await db.select().from(knowledgeRelationships).where(and(eq(knowledgeRelationships.companyId, input.companyId), isNull(knowledgeRelationships.validTo), inArray(knowledgeRelationships.sourceId, foundIds), inArray(knowledgeRelationships.targetId, foundIds))).orderBy(asc(knowledgeRelationships.id)).limit(30) : [];
    return { entities: [...selected.values()], relationships };
  },
};
