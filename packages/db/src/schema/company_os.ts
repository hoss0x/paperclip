import { sql } from "drizzle-orm";
import { bigserial, bigint, pgTable, uuid, text, integer, timestamp, jsonb, index, uniqueIndex, unique, foreignKey } from "drizzle-orm/pg-core";
import type { EmployeeContract, MissionInput, WorkstreamInput, KnowledgeEntityInput } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

const companyId = () => uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" });
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
export const employeeContracts = pgTable("employee_contracts", {
  id: uuid("id").primaryKey().defaultRandom(), companyId: companyId(), agentId: uuid("agent_id").notNull(),
  version: integer("version").notNull(), contract: jsonb("contract").$type<EmployeeContract>().notNull(),
  actorId: text("actor_id").notNull(), runId: uuid("run_id"), createdAt: createdAt(),
}, t => [uniqueIndex("employee_contract_version_uq").on(t.companyId, t.agentId, t.version),
  foreignKey({ columns: [t.companyId, t.agentId], foreignColumns: [agents.companyId, agents.id] }).onDelete("cascade")]);
export const missions = pgTable("missions", {
  id: uuid("id").primaryKey().defaultRandom(), companyId: companyId(), data: jsonb("data").$type<MissionInput>().notNull(),
  version: integer("version").notNull().default(1), createdAt: createdAt(), updatedAt: updatedAt(),
}, t => [unique("missions_company_id_uq").on(t.companyId, t.id)]);
export const missionWorkstreams = pgTable("mission_workstreams", {
  id: uuid("id").primaryKey().defaultRandom(), companyId: companyId(), missionId: uuid("mission_id").notNull(),
  data: jsonb("data").$type<WorkstreamInput>().notNull(), version: integer("version").notNull().default(1), createdAt: createdAt(), updatedAt: updatedAt(),
}, t => [index("workstreams_mission_idx").on(t.companyId, t.missionId),
  foreignKey({ columns: [t.companyId, t.missionId], foreignColumns: [missions.companyId, missions.id] }).onDelete("cascade")]);
export const organizationReceipts = pgTable("organization_receipts", {
  id: uuid("id").primaryKey().defaultRandom(), companyId: companyId(), missionId: uuid("mission_id").notNull(), projectId: uuid("project_id"),
  senderAgentId: uuid("sender_agent_id").notNull(), recipientAgentId: uuid("recipient_agent_id").notNull(), capability: text("capability"),
  kind: text("kind").notNull(), subject: text("subject").notNull(), payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  priority: text("priority").notNull(), correlationId: uuid("correlation_id").notNull(), parentReceiptId: uuid("parent_receipt_id"),
  status: text("status").notNull().default("sent"), idempotencyKey: text("idempotency_key").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }), resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  runId: uuid("run_id"), createdAt: createdAt(),
}, t => [unique("receipts_company_id_uq").on(t.companyId, t.id), uniqueIndex("receipts_sender_key_uq").on(t.companyId, t.senderAgentId, t.idempotencyKey),
  foreignKey({ name: "receipt_parent_company_fk", columns: [t.companyId, t.parentReceiptId], foreignColumns: [t.companyId, t.id] }),
  index("receipts_inbox_idx").on(t.companyId, t.recipientAgentId, t.createdAt),
  foreignKey({ columns: [t.companyId, t.missionId], foreignColumns: [missions.companyId, missions.id] }),
  foreignKey({ columns: [t.companyId, t.senderAgentId], foreignColumns: [agents.companyId, agents.id] }),
  foreignKey({ columns: [t.companyId, t.recipientAgentId], foreignColumns: [agents.companyId, agents.id] })]);
export const contextEvents = pgTable("context_events", {
  sequence: bigserial("sequence", { mode: "number" }).notNull(),
  origin: text("origin").notNull().default("employee"),
  sourceId: text("source_id"),
  id: uuid("id").primaryKey().defaultRandom(), companyId: companyId(), kind: text("kind").notNull(), subject: text("subject").notNull(), summary: text("summary").notNull(),
  missionId: uuid("mission_id"), projectId: uuid("project_id"), entityIds: jsonb("entity_ids").$type<string[]>().notNull().default([]),
  causationId: uuid("causation_id"), correlationId: uuid("correlation_id"), actorType: text("actor_type").notNull(), actorId: text("actor_id").notNull(),
  runId: uuid("run_id"), metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}), createdAt: createdAt(),
}, t => [uniqueIndex("context_events_source_uq").on(t.companyId, t.sourceId), index("context_events_stream_idx").on(t.companyId, t.missionId, t.sequence), unique("context_events_company_id_uq").on(t.companyId, t.id), index("context_events_scope_idx").on(t.companyId, t.missionId, t.createdAt),
  foreignKey({ name: "context_event_cause_company_fk", columns: [t.companyId, t.causationId], foreignColumns: [t.companyId, t.id] }),
  index("context_events_cause_idx").on(t.companyId, t.causationId)]);
export const knowledgeEntities = pgTable("knowledge_entities", {
  id: uuid("id").primaryKey().defaultRandom(), companyId: companyId(), data: jsonb("data").$type<KnowledgeEntityInput>().notNull(),
  version: integer("version").notNull().default(1), createdAt: createdAt(), updatedAt: updatedAt(),
}, t => [unique("knowledge_entities_company_id_uq").on(t.companyId, t.id), uniqueIndex("knowledge_entity_key_uq").on(t.companyId, sql`(${t.data}->>'kind')`, sql`(${t.data}->>'key')`)]);
export const knowledgeRelationships = pgTable("knowledge_relationships", {
  id: uuid("id").primaryKey().defaultRandom(), companyId: companyId(), sourceId: uuid("source_id").notNull(), targetId: uuid("target_id").notNull(),
  kind: text("kind").notNull(), provenance: text("provenance").notNull(), confidence: jsonb("confidence").$type<number | null>(),
  supersedesId: uuid("supersedes_id"), metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
  validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(), validTo: timestamp("valid_to", { withTimezone: true }),
}, t => [unique("knowledge_relationships_company_id_uq").on(t.companyId, t.id),
  foreignKey({ name: "knowledge_relationship_supersedes_fk", columns: [t.companyId, t.supersedesId], foreignColumns: [t.companyId, t.id] }),
  index("knowledge_relationships_source_idx").on(t.companyId, t.sourceId), index("knowledge_relationships_target_idx").on(t.companyId, t.targetId),
  foreignKey({ name: "knowledge_relationship_source_fk", columns: [t.companyId, t.sourceId], foreignColumns: [knowledgeEntities.companyId, knowledgeEntities.id] }),
  foreignKey({ name: "knowledge_relationship_target_fk", columns: [t.companyId, t.targetId], foreignColumns: [knowledgeEntities.companyId, knowledgeEntities.id] })]);
export const organizationDeliveries = pgTable("organization_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(), companyId: companyId(), eventId: uuid("event_id").notNull(), agentId: uuid("agent_id").notNull(),
  receiptId: uuid("receipt_id"), missionId: uuid("mission_id"), reason: text("reason").notNull(),
  status: text("status").notNull().default("pending"), attempts: integer("attempts").notNull().default(0),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(), error: text("error"), createdAt: createdAt(),
}, t => [uniqueIndex("organization_delivery_event_agent_uq").on(t.companyId, t.eventId, t.agentId), index("organization_delivery_pending_idx").on(t.status, t.availableAt),
  foreignKey({ name: "organization_delivery_receipt_fk", columns: [t.companyId, t.receiptId], foreignColumns: [organizationReceipts.companyId, organizationReceipts.id] }),
  foreignKey({ columns: [t.companyId, t.agentId], foreignColumns: [agents.companyId, agents.id] }).onDelete("cascade"),
  foreignKey({ columns: [t.companyId, t.eventId], foreignColumns: [contextEvents.companyId, contextEvents.id] }).onDelete("cascade")]);
export const organizationContextPacks = pgTable("organization_context_packs", {
  id: uuid("id").primaryKey().defaultRandom(), companyId: companyId(), agentId: uuid("agent_id").notNull(), runId: uuid("run_id").notNull(),
  missionId: uuid("mission_id"), contractVersion: integer("contract_version"), pack: jsonb("pack").$type<Record<string, unknown>>().notNull(),
  eventIds: jsonb("event_ids").$type<string[]>().notNull(), settledAt: timestamp("settled_at", { withTimezone: true }), createdAt: createdAt(),
}, t => [uniqueIndex("organization_pack_run_uq").on(t.companyId, t.runId), index("organization_pack_settlement_idx").on(t.settledAt), index("organization_pack_agent_mission_idx").on(t.companyId, t.agentId, t.missionId),
  foreignKey({ name: "organization_pack_employee_fk", columns: [t.companyId, t.agentId], foreignColumns: [agents.companyId, agents.id] })]);
export const organizationContextCursors = pgTable("organization_context_cursors", {
  companyId: companyId(), agentId: uuid("agent_id").notNull(), missionId: uuid("mission_id").notNull(),
  lastSequence: bigint("last_sequence", { mode: "number" }).notNull().default(0),
  seenEventIds: jsonb("seen_event_ids").$type<string[]>().notNull().default([]), updatedAt: updatedAt(),
}, t => [uniqueIndex("organization_cursor_uq").on(t.companyId, t.agentId, t.missionId),
  foreignKey({ columns: [t.companyId, t.agentId], foreignColumns: [agents.companyId, agents.id] }).onDelete("cascade"),
  foreignKey({ columns: [t.companyId, t.missionId], foreignColumns: [missions.companyId, missions.id] }).onDelete("cascade")]);
