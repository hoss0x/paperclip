import { cloneElement, useId, useState, type ReactElement, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "../lib/router";
import { employeeContractSchema, organizationActions, organizationPolicyModes, organizationEventKinds, receiptKinds, type EmployeeContract, type MissionInput, type WorkstreamInput, type KnowledgeEntityInput, type Receipt } from "@paperclipai/shared";
import { companyOsApi as api } from "../api/company-os";
import { agentsApi } from "../api/agents";
import { goalsApi } from "../api/goals";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";

const split = (v: string) => v.split("\n").map(s => s.trim()).filter(Boolean);
const emptyMission = (): MissionInput => ({ title: "", objective: "", ownerAgentId: null, participantAgentIds: [], goalIds: [], projectIds: [], status: "planned", roadmap: "", successCriteria: [], constraints: [], summary: "", startedAt: null, endedAt: null, metadata: {} });
const emptyWorkstream = (): WorkstreamInput => ({ title: "", objective: "", ownerAgentId: null, participantAgentIds: [], status: "planned", dependencyIds: [], acceptanceCriteria: [], boundaries: [], constraints: [], executionWorkspaceId: null });
const emptyKnowledge = (): KnowledgeEntityInput => ({ kind: "", key: "", name: "", summary: "", missionId: null, projectId: null, metadata: {}, provenance: "", confidence: null });
const selectClass = "rounded-md border border-input bg-background px-3 py-2 text-sm w-full";
function Field({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return <div className="flex flex-col gap-2 text-sm"><label htmlFor={id}>{label}</label>{cloneElement(children as ReactElement<{ id?: string }>, { id })}</div>;
}
function Lines({ label, value, onChange }: { label: string; value: string[]; onChange: (v: string[]) => void }) {
  // Keep the raw draft so Enter can add a new line before another character is typed.
  const [raw, setRaw] = useState(value.join("\n"));
  return <Field label={`${label} (one per line)`}><Textarea value={raw} onChange={e => { setRaw(e.target.value); onChange(split(e.target.value)); }} /></Field>;
}
function Choices({ label, options, values, onChange }: { label: string; options: { id: string; name: string }[]; values: string[]; onChange: (v: string[]) => void }) {
  return <fieldset className="space-y-2"><legend className="text-sm font-medium">{label}</legend>{options.map(o => <label key={o.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={values.includes(o.id)} onChange={e => onChange(e.target.checked ? [...values, o.id] : values.filter(v => v !== o.id))} />{o.name}</label>)}</fieldset>;
}
function Select({ label, value, onChange, options, optional = false }: { label: string; value: string; onChange: (v: string) => void; options: { id: string; name: string }[]; optional?: boolean }) {
  return <Field label={label}><select className={selectClass} value={value} onChange={e => onChange(e.target.value)}><option value="">{optional ? "None" : "Choose…"}</option>{options.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select></Field>;
}
function Form({ children, save, cancel, busy }: { children: ReactNode; save: () => void; cancel: () => void; busy: boolean }) {
  return <form className="space-y-4 rounded-lg border p-4" onSubmit={e => { e.preventDefault(); save(); }}><fieldset disabled={busy} className="space-y-4">{children}<div className="flex items-center justify-between gap-4"><Button type="button" variant="outline" onClick={cancel}>Cancel</Button><Button type="submit">{busy ? "Saving…" : "Save"}</Button></div></fieldset></form>;
}
export type OrganizationSection = "Missions" | "Contracts" | "Receipts" | "Knowledge" | "Timeline" | "Run context";
export function OrganizationPanel(props: { section: OrganizationSection; companyId?: string; agentId?: string; projectId?: string; runId?: string }) {
  const { selectedCompanyId } = useCompany();
  const companyId = props.companyId ?? selectedCompanyId;
  return companyId ? <Organization key={[companyId, props.agentId, props.projectId, props.runId, props.section].join(":")} {...props} companyId={companyId} /> : <p>Select a company.</p>;
}
function Organization({ companyId: c, section, agentId, projectId, runId: fixedRunId }: { companyId: string; section: OrganizationSection; agentId?: string; projectId?: string; runId?: string }) {
  const cache = useQueryClient();
  const tab = section;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [missionId, setMissionId] = useState("");
  const [contractAgent, setContractAgent] = useState(agentId ?? "");
  const [contractExpectedVersion, setContractExpectedVersion] = useState(0);
  const [contractDraft, setContractDraft] = useState<EmployeeContract | null>(null);
  const [missionDraft, setMissionDraft] = useState<{ id: string | null; version: number; data: MissionInput } | null>(null);
  const [workDraft, setWorkDraft] = useState<{ id: string | null; version: number; data: WorkstreamInput } | null>(null);
  const [knowledgeDraft, setKnowledgeDraft] = useState<{ id: string | null; version: number; data: KnowledgeEntityInput } | null>(null);
  const [search, setSearch] = useState("");
  const [runInput, setRunInput] = useState("");
  const [runId, setRunId] = useState(fixedRunId ?? "");
  const [history, setHistory] = useState(false);
  const [before, setBefore] = useState<string | undefined>();
  const [receiptDraft, setReceiptDraft] = useState<{ sender: string; recipient: string; capability: string; kind: string; subject: string; content: string; parent: Receipt | null; key: string } | null>(null);
  const [relation, setRelation] = useState({ source: "", target: "", kind: "", provenance: "", supersedes: "" });
  const companyPrefix = ["organization", c];
  const prefix = [...companyPrefix, projectId ?? null, agentId ?? null];
  const agents = useQuery({ queryKey: [...prefix, "agents"], queryFn: () => agentsApi.list(c), enabled: tab !== "Run context" });
  const goals = useQuery({ queryKey: [...prefix, "goals"], queryFn: () => goalsApi.list(c), enabled: tab === "Contracts" || tab === "Missions" });
  const projects = useQuery({ queryKey: [...prefix, "projects"], queryFn: () => projectsApi.list(c), enabled: tab !== "Run context" });
  const missions = useQuery({ queryKey: [...prefix, "missions"], queryFn: async () => (await api.missions(c)).filter(m => !projectId || m.data.projectIds.includes(projectId)), enabled: tab !== "Run context" && tab !== "Contracts" });
  const workstreams = useQuery({ queryKey: [...prefix, "workstreams", missionId], queryFn: () => api.workstreams(c, missionId), enabled: !!missionId });
  const receipts = useQuery({ queryKey: [...prefix, "receipts", missionId], queryFn: () => api.receipts(c, missionId || undefined), enabled: tab === "Receipts", refetchInterval: 10000 });
  const events = useQuery({ queryKey: [...prefix, "events", missionId, before], queryFn: () => api.events(c, missionId || undefined, before), enabled: tab === "Timeline", refetchInterval: before ? false : 10000 });
  const knowledge = useQuery({ queryKey: [...prefix, "knowledge", search], queryFn: async () => (await api.knowledge(c, search)).filter(e => !projectId || e.data.projectId === projectId || !!missions.data?.some(m => m.id === e.data.missionId)), enabled: tab === "Knowledge" });
  const relationships = useQuery({ queryKey: [...prefix, "relationships", history], queryFn: () => api.relationships(c, history), enabled: tab === "Knowledge" });
  const contract = useQuery({ queryKey: [...prefix, "contract", contractAgent], queryFn: () => api.contract(c, contractAgent), enabled: !!contractAgent });
  const revisions = useQuery({ queryKey: [...prefix, "history", contractAgent], queryFn: () => api.history(c, contractAgent), enabled: !!contractAgent });
  const pack = useQuery({ queryKey: [...prefix, "pack", runId], queryFn: async () => { try { return await api.pack(c, runId); } catch (error) { if ((error as { status?: number }).status === 404) return null; throw error; } }, enabled: !!runId, retry: false });
  const employeeOptions = (agents.data ?? []).map(a => ({ id: a.id, name: a.name }));
  const selectedMission = missions.data?.find(m => m.id === missionId);
  const missionOptions = (missions.data ?? []).map(m => ({ id: m.id, name: m.data.title }));
  const participantOptions = employeeOptions.filter(a => [selectedMission?.data.ownerAgentId, ...(selectedMission?.data.participantAgentIds ?? [])].includes(a.id));
  const save = async (action: () => Promise<unknown>, onSaved: () => void = () => {}) => {
    setBusy(true); setError("");
    try { await action(); onSaved(); await cache.invalidateQueries({ queryKey: companyPrefix }); } catch (e) { setError(e instanceof Error ? e.message : "Could not save changes"); } finally { setBusy(false); }
  };
  const queryError = [agents, goals, projects, missions, workstreams, receipts, events, knowledge, relationships, contract, revisions, pack].find(q => q.error)?.error;
  const updateMission = (data: Partial<MissionInput>) => setMissionDraft(d => d ? { ...d, data: { ...d.data, ...data } } : d);
  const updateWork = (data: Partial<WorkstreamInput>) => setWorkDraft(d => d ? { ...d, data: { ...d.data, ...data } } : d);
  const updateKnowledge = (data: Partial<KnowledgeEntityInput>) => setKnowledgeDraft(d => d ? { ...d, data: { ...d.data, ...data } } : d);
  const newReceipt = (parent: Receipt | null = null) => setReceiptDraft({ sender: parent?.recipientAgentId ?? "", recipient: parent?.senderAgentId ?? "", capability: "", kind: parent ? "result" : "investigation_request", subject: parent ? `Re: ${parent.subject}` : "", content: "", parent, key: crypto.randomUUID() });
  if (fixedRunId && !pack.isLoading && !pack.data && !pack.error) return null;
  return <div className="space-y-4">
    <h2 className="text-lg font-medium">{section === "Timeline" ? "Operational context" : section === "Run context" ? "Context supplied to this run" : section}</h2>
    {(error || queryError) && <p role="alert" className="text-sm text-destructive">{error || queryError?.message}</p>}
    {missions.isLoading && <p>Loading organization…</p>}
    {["Missions", "Receipts", "Timeline"].includes(tab) && <Select label="Mission" value={missionId} onChange={v => { setMissionId(v); setWorkDraft(null); setReceiptDraft(null); setBefore(undefined); }} options={missionOptions} optional />}
    {tab === "Missions" && <>
      <Button onClick={() => setMissionDraft({ id: null, version: 0, data: { ...emptyMission(), projectIds: projectId ? [projectId] : [] } })}>New mission</Button>
      {!missionId && !missionDraft && <div className="space-y-2">{missions.data?.map(m => <Button variant="outline" key={m.id} onClick={() => setMissionId(m.id)}>{m.data.title} · {m.data.status}</Button>)}</div>}
      {selectedMission && !missionDraft && <section className="space-y-3 rounded-lg border p-4"><h2 className="text-lg font-medium">{selectedMission.data.title}</h2><p>{selectedMission.data.objective}</p><p className="text-sm">{selectedMission.data.status} · Version {selectedMission.version}</p><p className="whitespace-pre-wrap">{selectedMission.data.summary}</p><p className="whitespace-pre-wrap">{selectedMission.data.roadmap}</p><Button variant="outline" onClick={() => setMissionDraft({ id: selectedMission.id, version: selectedMission.version, data: selectedMission.data })}>Edit mission</Button></section>}
      {missionDraft && <Form busy={busy} cancel={() => setMissionDraft(null)} save={() => void save(() => api.saveMission(c, missionDraft.id, missionDraft.data, missionDraft.version), () => setMissionDraft(null))}>
        <Field label="Title"><Input required value={missionDraft.data.title} onChange={e => updateMission({ title: e.target.value })} /></Field>
        <Field label="Objective"><Textarea required value={missionDraft.data.objective} onChange={e => updateMission({ objective: e.target.value })} /></Field>
        <Select label="Owner" value={missionDraft.data.ownerAgentId ?? ""} onChange={v => updateMission({ ownerAgentId: v || null })} options={employeeOptions} optional />
        <Choices label="Participants" values={missionDraft.data.participantAgentIds} options={employeeOptions} onChange={v => updateMission({ participantAgentIds: v })} />
        <Choices label="Goals" values={missionDraft.data.goalIds} options={(goals.data ?? []).map(g => ({ id: g.id, name: g.title }))} onChange={v => updateMission({ goalIds: v })} />
        <Choices label="Projects" values={missionDraft.data.projectIds} options={(projects.data ?? []).map(p => ({ id: p.id, name: p.name }))} onChange={v => updateMission({ projectIds: v })} />
        <Select label="Status" value={missionDraft.data.status} onChange={v => updateMission({ status: v as MissionInput["status"] })} options={["planned", "active", "paused", "stalled", "completed", "cancelled"].map(id => ({ id, name: id }))} />
        <Field label="Roadmap / plan"><Textarea value={missionDraft.data.roadmap} onChange={e => updateMission({ roadmap: e.target.value })} /></Field>
        <Lines key={`criteria-${missionDraft.id}`} label="Success criteria" value={missionDraft.data.successCriteria} onChange={v => updateMission({ successCriteria: v })} />
        <Lines key={`constraints-${missionDraft.id}`} label="Constraints" value={missionDraft.data.constraints} onChange={v => updateMission({ constraints: v })} />
        <Field label="Current summary"><Textarea value={missionDraft.data.summary} onChange={e => updateMission({ summary: e.target.value })} /></Field>
      </Form>}
      {missionId && <section className="space-y-3"><div className="flex items-center justify-between"><h2 className="text-lg font-medium">Workstreams and ownership</h2><Button onClick={() => setWorkDraft({ id: null, version: 0, data: emptyWorkstream() })}>New workstream</Button></div>
        {workstreams.data?.map(w => <article key={w.id} className="space-y-2 rounded-lg border p-4"><h3 className="font-medium">{w.data.title} · {w.data.status}</h3><p>{w.data.objective}</p><p className="text-sm">Owner: {employeeOptions.find(a => a.id === w.data.ownerAgentId)?.name ?? "Unassigned"}</p><ul>{w.data.boundaries.map((b, i) => <li key={i}>{b.kind}: {b.repository ? `${b.repository}: ` : ""}{b.resource}</li>)}</ul><Button variant="outline" onClick={() => setWorkDraft({ id: w.id, version: w.version, data: w.data })}>Edit workstream</Button></article>)}
        {workDraft && <Form busy={busy} cancel={() => setWorkDraft(null)} save={() => void save(() => api.saveWorkstream(c, missionId, workDraft.id, workDraft.data, workDraft.version), () => setWorkDraft(null))}>
          <Field label="Title"><Input required value={workDraft.data.title} onChange={e => updateWork({ title: e.target.value })} /></Field>
          <Field label="Objective"><Textarea value={workDraft.data.objective} onChange={e => updateWork({ objective: e.target.value })} /></Field>
          <Select label="Owner" value={workDraft.data.ownerAgentId ?? ""} onChange={v => updateWork({ ownerAgentId: v || null })} options={participantOptions} optional />
          <Choices label="Participants" values={workDraft.data.participantAgentIds} options={participantOptions} onChange={v => updateWork({ participantAgentIds: v })} />
          <Select label="Status" value={workDraft.data.status} onChange={v => updateWork({ status: v as WorkstreamInput["status"] })} options={["planned", "active", "blocked", "completed", "cancelled"].map(id => ({ id, name: id }))} />
          <Choices label="Dependencies" values={workDraft.data.dependencyIds} options={(workstreams.data ?? []).filter(w => w.id !== workDraft.id).map(w => ({ id: w.id, name: w.data.title }))} onChange={v => updateWork({ dependencyIds: v })} />
          <Lines key={`accept-${workDraft.id}`} label="Acceptance criteria" value={workDraft.data.acceptanceCriteria} onChange={v => updateWork({ acceptanceCriteria: v })} />
          <Lines key={`work-constraints-${workDraft.id}`} label="Constraints" value={workDraft.data.constraints} onChange={v => updateWork({ constraints: v })} />
          <fieldset className="space-y-2"><legend>Ownership boundaries</legend>{workDraft.data.boundaries.map((b, i) => <div key={i} className="flex flex-wrap items-center gap-2"><Input aria-label="Boundary kind" placeholder="Kind (path, service, territory…)" value={b.kind} onChange={e => updateWork({ boundaries: workDraft.data.boundaries.map((v, j) => j === i ? { ...v, kind: e.target.value } : v) })} /><Input aria-label="Owned resource" placeholder="Owned resource" value={b.resource} onChange={e => updateWork({ boundaries: workDraft.data.boundaries.map((v, j) => j === i ? { ...v, resource: e.target.value } : v) })} /><Input aria-label="Repository" placeholder="Repository (optional)" value={b.repository ?? ""} onChange={e => updateWork({ boundaries: workDraft.data.boundaries.map((v, j) => j === i ? { ...v, repository: e.target.value || undefined } : v) })} /><Button type="button" variant="outline" onClick={() => updateWork({ boundaries: workDraft.data.boundaries.filter((_, j) => j !== i) })}>Remove</Button></div>)}<Button type="button" variant="outline" onClick={() => updateWork({ boundaries: [...workDraft.data.boundaries, { kind: "", resource: "" }] })}>Add boundary</Button></fieldset>
          <Field label="Execution workspace ID (optional)"><Input value={workDraft.data.executionWorkspaceId ?? ""} onChange={e => updateWork({ executionWorkspaceId: e.target.value || null })} /></Field>
        </Form>}
      </section>}
    </>}
    {tab === "Contracts" && <>
      {agentId && <section className="space-y-2"><h3 className="font-medium">Employee goals</h3>{goals.data?.filter(g => g.ownerAgentId === agentId).map(g => <p key={g.id}><Link to={`/goals/${g.id}`}>{g.title}</Link> · {g.status}</p>)}</section>}

      <p className="text-sm"><Link className="underline" to="/agents">Create employees and edit reporting relationships</Link> · <Link className="underline" to="/goals">Manage goals</Link></p>
      {!agentId && <Select label="Employee" value={contractAgent} options={employeeOptions} onChange={v => { setContractAgent(v); setContractDraft(null); }} />}
      {contractAgent && !contract.isLoading && !contractDraft && <><p>Current contract: {contract.data ? `version ${contract.data.version}` : "not defined"}</p><Button onClick={() => { setContractExpectedVersion(contract.data?.version ?? 0); setContractDraft(employeeContractSchema.parse(contract.data?.contract ?? {})); }}>Edit contract</Button></>}
      {contractDraft && <Form busy={busy} cancel={() => setContractDraft(null)} save={() => void save(() => api.saveContract(c, contractAgent, contractDraft, contractExpectedVersion), () => setContractDraft(null))}>
        {([['purpose', 'Purpose'], ['mission', 'Persistent objective'], ['runtimeInstructions', 'Runtime instructions'], ['reportingExpectations', 'Reporting expectations']] as const).map(([field, label]) => <Field key={field} label={label}><Textarea value={contractDraft[field]} onChange={e => setContractDraft({ ...contractDraft, [field]: e.target.value })} /></Field>)}
        {([['responsibilities', 'Responsibilities'], ['expectedOutcomes', 'Expected outcomes'], ['authority', 'Decision rights'], ['prohibitedActions', 'Prohibited actions'], ['capabilities', 'Capabilities'], ['servicesProvided', 'Services provided'], ['servicesConsumed', 'Services consumed'], ['escalationRules', 'Escalation rules'], ['collaborationRules', 'Collaboration rules'], ['operatingPolicies', 'Operating policies']] as const).map(([field, label]) => <Lines key={field} label={label} value={contractDraft[field]} onChange={v => setContractDraft({ ...contractDraft, [field]: v })} />)}
        <h3 className="font-medium">Enforced action policy</h3>
        <Select label="Default action policy" value={contractDraft.policy.defaultMode} options={["allowed", "denied"].map(id => ({ id, name: id }))} onChange={v => setContractDraft({ ...contractDraft, policy: { ...contractDraft.policy, defaultMode: v as "allowed" | "denied" } })} />
        {organizationActions.map(action => <Select key={action} label={action} optional value={contractDraft.policy.permissions[action] ?? ""} options={organizationPolicyModes.map(id => ({ id, name: id }))} onChange={v => { const permissions = { ...contractDraft.policy.permissions }; if (v) permissions[action] = v as typeof organizationPolicyModes[number]; else delete permissions[action]; setContractDraft({ ...contractDraft, policy: { ...contractDraft.policy, permissions } }); }} />)}
        <h3 className="font-medium">Service exposure</h3>
        {contractDraft.serviceExposures.map((exposure, index) => <div key={index} className="space-y-2 rounded-lg border p-3">
          <Field label="Capability / service"><Input required value={exposure.capability} onChange={e => setContractDraft({ ...contractDraft, serviceExposures: contractDraft.serviceExposures.map((v, i) => i === index ? { ...v, capability: e.target.value } : v) })} /></Field>
          <Select label="Service scope" value={exposure.scope} options={["mission", "org_subtree", "company"].map(id => ({ id, name: id }))} onChange={v => setContractDraft({ ...contractDraft, serviceExposures: contractDraft.serviceExposures.map((e, i) => i === index ? { ...e, scope: v as typeof exposure.scope } : e) })} />
          {exposure.scope === "org_subtree" && <Select label="Organization subtree root" optional value={exposure.orgRootAgentId ?? ""} options={employeeOptions} onChange={v => setContractDraft({ ...contractDraft, serviceExposures: contractDraft.serviceExposures.map((e, i) => i === index ? { ...e, orgRootAgentId: v || undefined } : e) })} />}
          <Button type="button" variant="outline" onClick={() => setContractDraft({ ...contractDraft, serviceExposures: contractDraft.serviceExposures.filter((_, i) => i !== index) })}>Remove service exposure</Button>
        </div>)}
        <Button type="button" variant="outline" onClick={() => setContractDraft({ ...contractDraft, serviceExposures: [...contractDraft.serviceExposures, { capability: "", scope: "mission" }] })}>Add service exposure</Button>
        <Choices label="Wake subscriptions" values={contractDraft.eventSubscriptions} options={organizationEventKinds.map(id => ({ id, name: id }))} onChange={v => setContractDraft({ ...contractDraft, eventSubscriptions: v as EmployeeContract["eventSubscriptions"] })} />
        <Lines label="Additional event subscriptions" value={contractDraft.eventSubscriptions.filter(v => !(organizationEventKinds as readonly string[]).includes(v))} onChange={v => setContractDraft({ ...contractDraft, eventSubscriptions: [...new Set([...contractDraft.eventSubscriptions.filter(value => (organizationEventKinds as readonly string[]).includes(value)), ...v])] })} />
        <Field label="Scheduled review interval in minutes (optional, at least 15)"><Input type="number" min={15} value={contractDraft.scheduledReviewMinutes ?? ""} onChange={e => setContractDraft({ ...contractDraft, scheduledReviewMinutes: e.target.value ? Number(e.target.value) : null })} /></Field>
      </Form>}
      {revisions.data?.map(r => <details key={r.id} className="rounded-lg border p-3"><summary>Version {r.version} · {new Date(r.createdAt).toLocaleString()}</summary><pre className="overflow-auto whitespace-pre-wrap text-sm">{JSON.stringify(r.contract, null, 2)}</pre></details>)}
    </>}
    {tab === "Receipts" && <>
      <p className="text-sm text-muted-foreground">Receipts request a service. They keep the sender’s work ownership. Automatic wakes require the recipient’s matching contract subscription.</p>
      <Button disabled={!missionId} onClick={() => newReceipt()}>Send receipt</Button>
      {receiptDraft && <Form busy={busy} cancel={() => setReceiptDraft(null)} save={() => void save(() => api.sendReceipt(c, { missionId: receiptDraft.parent?.missionId ?? missionId, projectId: receiptDraft.parent?.projectId ?? null, senderAgentId: receiptDraft.sender, ...(receiptDraft.capability ? { capability: receiptDraft.capability } : { recipientAgentId: receiptDraft.recipient }), kind: receiptDraft.kind as Receipt["kind"], subject: receiptDraft.subject, payload: { content: receiptDraft.content }, priority: "medium", parentReceiptId: receiptDraft.parent?.id ?? null, idempotencyKey: receiptDraft.key, metadata: {} }), () => setReceiptDraft(null))}>
        <Select label="From" value={receiptDraft.sender} options={participantOptions} onChange={v => setReceiptDraft({ ...receiptDraft, sender: v })} />
        <Select label="To" value={receiptDraft.recipient} options={participantOptions} onChange={v => setReceiptDraft({ ...receiptDraft, recipient: v, capability: "" })} />
        {!receiptDraft.parent && <Field label="Or target capability / service"><Input value={receiptDraft.capability} onChange={e => setReceiptDraft({ ...receiptDraft, capability: e.target.value, recipient: "" })} /></Field>}
        <Select label="Kind" value={receiptDraft.kind} options={receiptKinds.map(id => ({ id, name: id }))} onChange={v => setReceiptDraft({ ...receiptDraft, kind: v })} />
        <Field label="Subject"><Input required value={receiptDraft.subject} onChange={e => setReceiptDraft({ ...receiptDraft, subject: e.target.value })} /></Field>
        <Field label="Request / response"><Textarea required value={receiptDraft.content} onChange={e => setReceiptDraft({ ...receiptDraft, content: e.target.value })} /></Field>
      </Form>}
      {receipts.isLoading && <p>Loading receipts…</p>}
      {receipts.data?.map(r => <article key={r.id} className="space-y-2 rounded-lg border p-4"><h2 className="font-medium">{r.subject} · {r.status}</h2><p className="text-sm">{employeeOptions.find(a => a.id === r.senderAgentId)?.name} → {employeeOptions.find(a => a.id === r.recipientAgentId)?.name} · {r.kind}</p><pre className="whitespace-pre-wrap text-sm">{JSON.stringify(r.payload, null, 2)}</pre><p className="text-sm text-muted-foreground">Correlation: {r.correlationId}{r.parentReceiptId ? ` · Reply to ${r.parentReceiptId}` : ""}</p><div className="flex gap-2"><Button variant="outline" onClick={() => { setMissionId(r.missionId); newReceipt(r); }}>Reply</Button>{r.status === "sent" && <Button disabled={busy} variant="outline" onClick={() => void save(() => api.acknowledge(c, r.id))}>Acknowledge</Button>}</div></article>)}
    </>}
    {tab === "Knowledge" && <>
      <Field label="Search knowledge"><Input value={search} onChange={e => setSearch(e.target.value)} /></Field><Button onClick={() => setKnowledgeDraft({ id: null, version: 0, data: emptyKnowledge() })}>Add knowledge</Button>
      {knowledgeDraft && <Form busy={busy} cancel={() => setKnowledgeDraft(null)} save={() => void save(() => api.saveKnowledge(c, knowledgeDraft.id, knowledgeDraft.data, knowledgeDraft.version), () => setKnowledgeDraft(null))}>
        {([['kind', 'Entity type'], ['key', 'Stable key'], ['name', 'Name'], ['provenance', 'Source / provenance']] as const).map(([field, label]) => <Field key={field} label={label}><Input required value={knowledgeDraft.data[field]} onChange={e => updateKnowledge({ [field]: e.target.value })} /></Field>)}
        <Field label="Current truth / summary"><Textarea value={knowledgeDraft.data.summary} onChange={e => updateKnowledge({ summary: e.target.value })} /></Field>
        <Select label="Mission scope" optional value={knowledgeDraft.data.missionId ?? ""} options={missionOptions} onChange={v => updateKnowledge({ missionId: v || null })} />
        <Select label="Project scope" optional value={knowledgeDraft.data.projectId ?? ""} options={(projects.data ?? []).map(p => ({ id: p.id, name: p.name }))} onChange={v => updateKnowledge({ projectId: v || null })} />
        <Field label="Confidence (0–1, optional)"><Input type="number" min={0} max={1} step="any" value={knowledgeDraft.data.confidence ?? ""} onChange={e => updateKnowledge({ confidence: e.target.value ? Number(e.target.value) : null })} /></Field>
      </Form>}
      {knowledge.data?.map(e => <article key={e.id} className="space-y-2 rounded-lg border p-4"><h2 className="font-medium">{e.data.name} · {e.data.kind}</h2><p className="whitespace-pre-wrap">{e.data.summary}</p><p className="text-sm text-muted-foreground">Source: {e.data.provenance} · Version {e.version}</p><Button variant="outline" onClick={() => setKnowledgeDraft({ id: e.id, version: e.version, data: e.data })}>Edit</Button></article>)}
      <h2 className="text-lg font-medium">Relationships</h2><label className="flex gap-2 text-sm"><input type="checkbox" checked={history} onChange={e => setHistory(e.target.checked)} />Show superseded relationships</label>
      {relationships.data?.map(r => <article key={r.id} className="space-y-2 rounded-lg border p-3"><p>{knowledge.data?.find(e => e.id === r.sourceId)?.data.name ?? r.sourceId} → {r.kind} → {knowledge.data?.find(e => e.id === r.targetId)?.data.name ?? r.targetId}</p><p className="text-sm">{r.provenance} · {r.validTo ? "Superseded" : "Current"}</p>{!r.validTo && <Button variant="outline" onClick={() => setRelation({ source: r.sourceId, target: "", kind: r.kind, provenance: "", supersedes: r.id })}>Supersede</Button>}</article>)}
      <Form busy={busy} cancel={() => setRelation({ source: "", target: "", kind: "", provenance: "", supersedes: "" })} save={() => void save(() => api.addRelationship(c, { sourceId: relation.source, targetId: relation.target, kind: relation.kind, provenance: relation.provenance, confidence: null, supersedesId: relation.supersedes || null, metadata: {} }), () => setRelation({ source: "", target: "", kind: "", provenance: "", supersedes: "" }))}>
        <h3 className="font-medium">{relation.supersedes ? "Replace relationship" : "Add relationship"}</h3>
        <Select label="Source" value={relation.source} options={(knowledge.data ?? []).map(e => ({ id: e.id, name: e.data.name }))} onChange={v => setRelation({ ...relation, source: v })} />
        <Field label="Relationship type"><Input required value={relation.kind} onChange={e => setRelation({ ...relation, kind: e.target.value })} /></Field>
        <Select label="Target" value={relation.target} options={(knowledge.data ?? []).map(e => ({ id: e.id, name: e.data.name }))} onChange={v => setRelation({ ...relation, target: v })} />
        <Field label="Source / reason"><Input required value={relation.provenance} onChange={e => setRelation({ ...relation, provenance: e.target.value })} /></Field>
      </Form>
    </>}
    {tab === "Timeline" && <>
      <p className="text-sm text-muted-foreground">Append-only company history, including mission changes, receipt exchanges, knowledge provenance, and run outcomes.</p>
      {events.data?.map(e => <article key={e.id} className="space-y-2 rounded-lg border p-4"><h2 className="font-medium">{e.subject}</h2><p className="text-sm">{e.kind} · {e.origin ?? e.actorType} · {new Date(e.createdAt).toLocaleString()}</p><p className="whitespace-pre-wrap">{e.summary}</p><p className="text-sm text-muted-foreground">{e.actorType}: {e.actorId}{e.causationId ? ` · Caused by ${e.causationId}` : ""}{e.correlationId ? ` · Correlation ${e.correlationId}` : ""}</p>{e.runId && <span>Run {e.runId}</span>}</article>)}
      <div className="flex gap-2"><Button variant="outline" onClick={() => setBefore(undefined)}>Latest</Button><Button variant="outline" disabled={!events.data?.length} onClick={() => setBefore(events.data?.at(-1)?.createdAt)}>Older events</Button></div>
    </>}
    {tab === "Run context" && <>
      {!fixedRunId && <form className="flex items-end gap-2" onSubmit={e => { e.preventDefault(); setRunId(runInput); }}><Field label="Run ID"><Input required value={runInput} onChange={e => setRunInput(e.target.value)} /></Field><Button>Inspect</Button></form>}
      {pack.isLoading && <p>Loading context…</p>}{pack.data && <section className="space-y-3"><p>Contract version: {pack.data.contractVersion ?? "None"} · Built {new Date(pack.data.createdAt).toLocaleString()}</p><pre className="overflow-auto whitespace-pre-wrap rounded-lg border p-4 text-sm">{JSON.stringify(pack.data.pack, null, 2)}</pre></section>}
    </>}
  </div>;
}

export function InboxReceipts() {
  const [open, setOpen] = useState(false);
  return <details className="rounded-lg border p-4" onToggle={e => setOpen(e.currentTarget.open)}><summary className="cursor-pointer font-medium">Employee requests and receipts</summary>{open && <OrganizationPanel section="Receipts" />}</details>;
}
