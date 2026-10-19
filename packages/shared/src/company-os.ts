import { z } from "zod";

const id = z.string().uuid();
const short = z.string().trim().min(1).max(500);
const text = z.string().max(20000);
const lines = z.array(z.string().trim().min(1).max(2000)).max(100);
const ids = z.array(id).max(100).refine(v => new Set(v).size === v.length, "Duplicate IDs");
const metadata = z.record(z.string().max(100), z.unknown()).refine(v => JSON.stringify(v).length <= 20000, "Metadata too large");
export const organizationEventKinds = ["mission.started", "mission.updated", "mission.completed", "mission.stalled", "receipt.received", "receipt.response_received", "decision.requested", "employee.escalation", "context.created", "goal.at_risk", "review.requested", "review.scheduled", "workstream.updated", "knowledge.updated", "run.completed", "contract.updated"] as const;
// Restrictions intersect company authorization; these are never privilege grants.
export const organizationPolicyModes = ["allowed", "denied", "assigned_only", "owned_only", "participant_only", "approval_required"] as const;
export const organizationActions = ["mission.read", "mission.create", "mission.update", "mission.complete", "workstream.create", "workstream.update", "receipt.read", "receipt.send", "receipt.request_decision", "receipt.acknowledge", "knowledge.read", "knowledge.write", "event.read", "event.emit", "context.read"] as const;
export const organizationPolicySchema = z.object({
  defaultMode: z.enum(["allowed", "denied"]).default("allowed"),
  permissions: z.partialRecord(z.enum(organizationActions), z.enum(organizationPolicyModes)).default({}),
}).strict();
export type OrganizationPolicy = z.infer<typeof organizationPolicySchema>;
export const serviceExposureSchema = z.object({
  capability: short, scope: z.enum(["mission", "org_subtree", "company"]),
  orgRootAgentId: id.optional(),
}).strict();
export const reservedOrganizationEventKind = (kind: string) => /^(mission|workstream|receipt|run|contract|knowledge|review|decision|employee|paperclip)\./.test(kind);
export const employeeContractSchema = z.object({
  policy: organizationPolicySchema.default({ defaultMode: "allowed", permissions: {} }),
  serviceExposures: z.array(serviceExposureSchema).max(100).default([]),
  purpose: text.default(""), mission: text.default(""), responsibilities: lines.default([]),
  expectedOutcomes: lines.default([]), authority: lines.default([]), prohibitedActions: lines.default([]),
  capabilities: lines.default([]), servicesProvided: lines.default([]), servicesConsumed: lines.default([]),
  eventSubscriptions: z.array(short).max(100).default([]),
  escalationRules: lines.default([]), collaborationRules: lines.default([]), operatingPolicies: lines.default([]),
  runtimeInstructions: text.default(""), reportingExpectations: text.default(""),
  scheduledReviewMinutes: z.number().int().min(15).max(525600).nullable().default(null),
}).strict().refine(v => JSON.stringify(v).length <= 24000, "Contract must fit within 24,000 characters");
export type EmployeeContract = z.infer<typeof employeeContractSchema>;
export const saveEmployeeContractSchema = z.object({ expectedVersion: z.number().int().min(0), contract: employeeContractSchema }).strict();
export const missionSchema = z.object({
  title: short, objective: text, ownerAgentId: id.nullable(), participantAgentIds: ids,
  goalIds: ids, projectIds: ids, status: z.enum(["planned", "active", "paused", "stalled", "completed", "cancelled"]),
  roadmap: text, successCriteria: lines, constraints: lines, summary: text,
  startedAt: z.iso.datetime().nullable(), endedAt: z.iso.datetime().nullable(), metadata,
}).strict().refine(v => JSON.stringify(v).length <= 30000, "Mission must fit within 30,000 characters");
export type MissionInput = z.infer<typeof missionSchema>;
export const ownershipBoundarySchema = z.object({ kind: short, resource: short, repository: short.optional() }).strict();
export type OwnershipBoundary = z.infer<typeof ownershipBoundarySchema>;
export const workstreamSchema = z.object({
  title: short, objective: text, ownerAgentId: id.nullable(), participantAgentIds: ids,
  status: z.enum(["planned", "active", "blocked", "completed", "cancelled"]), dependencyIds: ids,
  acceptanceCriteria: lines, boundaries: z.array(ownershipBoundarySchema).max(100), constraints: lines,
  executionWorkspaceId: id.nullable(),
}).strict().refine(v => JSON.stringify(v).length <= 16000, "Workstream must fit within 16,000 characters");
export type WorkstreamInput = z.infer<typeof workstreamSchema>;
export const receiptKinds = ["information_request", "investigation_request", "result", "review_request", "decision_request", "decision", "escalation", "notice", "handoff"] as const;
export const receiptSchema = z.object({
  missionId: id, projectId: id.nullable().default(null), senderAgentId: id,
  recipientAgentId: id.optional(), capability: short.optional(), kind: z.enum(receiptKinds), subject: short,
  payload: metadata, priority: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  parentReceiptId: id.nullable().default(null), idempotencyKey: short, metadata: metadata.default({}),
}).strict().refine(v => Boolean(v.recipientAgentId) !== Boolean(v.capability), "Choose an employee or capability");
export type ReceiptInput = z.infer<typeof receiptSchema>;
export const contextEventSchema = z.object({
  kind: short, subject: short, summary: text, missionId: id.nullable(), projectId: id.nullable(),
  entityIds: ids, causationId: id.nullable(), correlationId: id.nullable(), metadata,
}).strict();
export type ContextEventInput = z.infer<typeof contextEventSchema>;
export const knowledgeEntitySchema = z.object({
  kind: short, key: short, name: short, summary: text, missionId: id.nullable(), projectId: id.nullable(),
  metadata, provenance: text, confidence: z.number().min(0).max(1).nullable(),
}).strict();
export type KnowledgeEntityInput = z.infer<typeof knowledgeEntitySchema>;
export const knowledgeRelationshipSchema = z.object({
  sourceId: id, targetId: id, kind: short, provenance: text, confidence: z.number().min(0).max(1).nullable(),
  supersedesId: id.nullable(), metadata,
}).strict();
export type KnowledgeRelationshipInput = z.infer<typeof knowledgeRelationshipSchema>;

export interface OrganizationRecord<T> { id: string; companyId: string; data: T; createdAt: string; updatedAt: string }
export type Mission = OrganizationRecord<MissionInput>;
export type Workstream = OrganizationRecord<WorkstreamInput> & { missionId: string };
export interface ContractRevision { id: string; companyId: string; agentId: string; version: number; contract: EmployeeContract; createdAt: string; actorId: string; runId: string | null }
export interface Receipt extends ReceiptInput { id: string; companyId: string; recipientAgentId: string; correlationId: string; status: string; acknowledgedAt: string | null; resolvedAt: string | null; createdAt: string }
export interface ContextEvent extends ContextEventInput { origin?: "system" | "employee" | "board" | "integration"; sourceId?: string | null; id: string; companyId: string; actorType: string; actorId: string; runId: string | null; createdAt: string }
export type KnowledgeEntity = OrganizationRecord<KnowledgeEntityInput>;
export interface KnowledgeRelationship extends KnowledgeRelationshipInput { id: string; companyId: string; validFrom: string; validTo: string | null }
