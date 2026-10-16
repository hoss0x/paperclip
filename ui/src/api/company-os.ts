import type { ContractRevision, EmployeeContract, Mission, MissionInput, Workstream, WorkstreamInput, Receipt, ReceiptInput, ContextEvent, ContextEventInput, KnowledgeEntity, KnowledgeEntityInput, KnowledgeRelationship, KnowledgeRelationshipInput } from "@paperclipai/shared";
import { api } from "./client";
const base = (companyId: string) => `/companies/${companyId}/organization`;
export const companyOsApi = {
  contract: (c: string, agent: string) => api.get<ContractRevision | null>(`${base(c)}/contracts/${agent}`),
  history: (c: string, agent: string) => api.get<ContractRevision[]>(`${base(c)}/contracts/${agent}/history`),
  saveContract: (c: string, agent: string, contract: EmployeeContract, expectedVersion: number) => api.put<ContractRevision>(`${base(c)}/contracts/${agent}`, { contract, expectedVersion }),
  missions: (c: string) => api.get<(Mission & { version: number })[]>(`${base(c)}/missions`),
  saveMission: (c: string, id: string | null, data: MissionInput, expectedVersion: number) => id ? api.put(`${base(c)}/missions/${id}`, { data, expectedVersion }) : api.post(`${base(c)}/missions`, data),
  workstreams: (c: string, missionId: string) => api.get<(Workstream & { version: number })[]>(`${base(c)}/missions/${missionId}/workstreams`),
  saveWorkstream: (c: string, missionId: string, id: string | null, data: WorkstreamInput, expectedVersion: number) => id ? api.put(`${base(c)}/missions/${missionId}/workstreams/${id}`, { data, expectedVersion }) : api.post(`${base(c)}/missions/${missionId}/workstreams`, data),
  receipts: (c: string, missionId?: string) => api.get<Receipt[]>(`${base(c)}/receipts${missionId ? `?missionId=${missionId}` : ""}`),
  sendReceipt: (c: string, data: ReceiptInput) => api.post<Receipt>(`${base(c)}/receipts`, data),
  acknowledge: (c: string, id: string) => api.post(`${base(c)}/receipts/${id}/acknowledge`, {}),
  events: (c: string, missionId?: string, before?: string) => api.get<ContextEvent[]>(`${base(c)}/events?${new URLSearchParams({ ...(missionId ? { missionId } : {}), ...(before ? { before } : {}) })}`),
  appendEvent: (c: string, data: ContextEventInput) => api.post(`${base(c)}/events`, data),
  knowledge: (c: string, query: string) => api.get<(KnowledgeEntity & { version: number })[]>(`${base(c)}/knowledge?q=${encodeURIComponent(query)}`),
  saveKnowledge: (c: string, id: string | null, data: KnowledgeEntityInput, expectedVersion: number) => id ? api.put(`${base(c)}/knowledge/${id}`, { data, expectedVersion }) : api.post(`${base(c)}/knowledge`, data),
  relationships: (c: string, history = false) => api.get<KnowledgeRelationship[]>(`${base(c)}/relationships?history=${history}`),
  addRelationship: (c: string, data: KnowledgeRelationshipInput) => api.post(`${base(c)}/relationships`, data),
  pack: (c: string, runId: string) => api.get<{ id: string; runId: string; contractVersion: number | null; pack: Record<string, unknown>; createdAt: string }>(`${base(c)}/context-packs/${runId}`),
};
