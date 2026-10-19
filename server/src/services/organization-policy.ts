import { and, desc, eq } from "drizzle-orm";
import { agents, companies, employeeContracts, type Db } from "@paperclipai/db";
import { organizationPolicySchema, type OrganizationPolicy } from "@paperclipai/shared";
import { forbidden, notFound } from "../errors.js";

type Reader = Pick<Db, "select">;
export interface PolicyActor { actorType: string; actorId: string }
export interface PolicyScope { ownerAgentId?: string | null; assignedAgentId?: string | null; participantAgentIds?: string[] }
export function evaluateOrganizationPolicy(policy: OrganizationPolicy, action: string, agentId: string, scope: PolicyScope = {}) {
  const mode = policy.permissions[action as keyof typeof policy.permissions] ?? policy.defaultMode;
  switch (mode) {
    case "allowed": return true;
    case "owned_only": return scope.ownerAgentId === agentId;
    case "assigned_only": return scope.assignedAgentId === agentId || scope.ownerAgentId === agentId;
    case "participant_only": return scope.ownerAgentId === agentId || !!scope.participantAgentIds?.includes(agentId);
    // Approval is not a prompt instruction or an arbitrary approved issue. A board
    // operator performs the reviewed action through the ordinary authorized API.
    case "approval_required": case "denied": return false;
  }
}
/** Restrictive intersection, after the route's normal auth/company access checks. */
export async function assertOrganizationPermission(reader: Reader, companyId: string, actor: PolicyActor, action: string, scope: PolicyScope = {}) {
  if (actor.actorType !== "agent") return;
  const [employee] = await reader.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, actor.actorId)));
  if (!employee) throw forbidden("Employee is not in this company");
  const [company] = await reader.select({ policy: companies.organizationPolicy }).from(companies).where(eq(companies.id, companyId));
  if (!company) throw notFound("Company not found");
  const [contract] = await reader.select().from(employeeContracts).where(and(eq(employeeContracts.companyId, companyId), eq(employeeContracts.agentId, actor.actorId))).orderBy(desc(employeeContracts.version)).limit(1);
  for (const raw of [company.policy, contract?.contract.policy ?? { defaultMode: "allowed", permissions: {} }]) {
    const parsed = organizationPolicySchema.safeParse(raw);
    if (!parsed.success || !evaluateOrganizationPolicy(parsed.data, action, actor.actorId, scope)) throw forbidden(`Contract/company policy restricts ${action}; board review is required for approval_required actions`);
  }
}
