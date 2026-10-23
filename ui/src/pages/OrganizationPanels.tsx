import { cloneElement, useId, useState, type ReactElement, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "../lib/router";
import { employeeOrganizationConfigSchema, organizationActions, organizationPolicyModes, organizationEventKinds, receiptKinds, type EmployeeOrganizationConfig, type MissionInput, type WorkstreamInput, type KnowledgeEntityInput, type Receipt } from "@paperclipai/shared";
import { companyOsApi as api } from "../api/company-os";
import { agentsApi } from "../api/agents";
import { goalsApi } from "../api/goals";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "../components/ui/dialog";

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
function Select({ label, value, onChange, options, optional = false, emptyLabel }: { label: string; value: string; onChange: (v: string) => void; options: { id: string; name: string }[]; optional?: boolean; emptyLabel?: string }) {
  return <Field label={label}><select className={selectClass} value={value} onChange={e => onChange(e.target.value)}><option value="">{emptyLabel ?? (optional ? "None" : "Choose…")}</option>{options.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select></Field>;
}
function Form({ children, save, cancel, busy }: { children: ReactNode; save: () => void; cancel: () => void; busy: boolean }) {
  return <form className="space-y-4 rounded-lg border p-4" onSubmit={e => { e.preventDefault(); save(); }}><fieldset disabled={busy} className="space-y-4">{children}<div className="flex items-center justify-between gap-4"><Button type="button" variant="outline" onClick={cancel}>Cancel</Button><Button type="submit">{busy ? "Saving…" : "Save"}</Button></div></fieldset></form>;
}
function EditorDialog({ title, description, close, busy, error, children }: { title: string; description: string; close: () => void; busy: boolean; error: string; children: ReactNode }) {
  return <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}><DialogContent className="max-h-dialog overflow-y-auto sm:max-w-2xl" showCloseButton={!busy}>
    <DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}{children}
  </DialogContent></Dialog>;
}
function RoleCharterEvidence({ provenance }: { provenance: unknown }) {
  const [open, setOpen] = useState(false);
  if (!provenance || typeof provenance !== "object") return <p>Legacy run: the governing Contract is retained in the saved historical pack.</p>;
  const record = provenance as { source?: string; errorCode?: string; entryFile?: string; contentHash?: string; revisionId?: string; contentBase64?: string };
  let snapshot = record.source === "instruction_file_unavailable" ? `The instruction snapshot was unavailable at run start (${record.errorCode ?? "read failed"}). No file contents are asserted by this record.` : "No instruction file was configured for this run.";
  if (record.contentBase64) {
    try { snapshot = new TextDecoder().decode(Uint8Array.from(atob(record.contentBase64), c => c.charCodeAt(0))); }
    catch { snapshot = "The stored instruction snapshot could not be decoded."; }
  }
  return <section className="space-y-2"><h3 className="font-medium">Role / Contract at run start</h3><p>{record.entryFile ?? "AGENTS.md"}</p>
    {record.contentHash && <p className="break-all font-mono text-sm">SHA-256: {record.contentHash}</p>}
    {record.revisionId && <p className="font-mono text-sm">Instruction revision: {record.revisionId}</p>}
    <Button variant="outline" onClick={() => setOpen(true)}>View governing role charter</Button>
    {open && <EditorDialog title="Role charter at run start" description="Immutable audit snapshot. The model received this through its normal instruction path." close={() => setOpen(false)} busy={false} error=""><pre className="whitespace-pre-wrap text-sm">{snapshot}</pre></EditorDialog>}
  </section>;
}
export type OrganizationSection = "Missions" | "Services & Automation" | "Permissions" | "Receipts" | "Knowledge" | "Timeline" | "Run context";
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
  const [settingsAgent, setSettingsAgent] = useState(agentId ?? "");
  const [settingsExpectedVersion, setSettingsExpectedVersion] = useState(0);
  const [settingsDraft, setSettingsDraft] = useState<EmployeeOrganizationConfig | null>(null);
  const [missionDraft, setMissionDraft] = useState<{ id: string | null; version: number; data: MissionInput } | null>(null);
  const [workDraft, setWorkDraft] = useState<{ id: string | null; version: number; data: WorkstreamInput } | null>(null);
  const [knowledgeDraft, setKnowledgeDraft] = useState<{ id: string | null; version: number; data: KnowledgeEntityInput } | null>(null);
  const [search, setSearch] = useState("");
  const [runInput, setRunInput] = useState("");
  const [runId, setRunId] = useState(fixedRunId ?? "");
  const [history, setHistory] = useState(false);
  const [before, setBefore] = useState<string | undefined>();
  const [receiptDraft, setReceiptDraft] = useState<{ sender: string; recipient: string; capability: string; kind: string; subject: string; content: string; parent: Receipt | null; key: string } | null>(null);
  const [relationshipOpen, setRelationshipOpen] = useState(false);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [receiptSearch, setReceiptSearch] = useState("");
  const [receiptKind, setReceiptKind] = useState("");
  const [relation, setRelation] = useState({ source: "", target: "", kind: "", provenance: "", supersedes: "" });
  const companyPrefix = ["organization", c];
  const prefix = [...companyPrefix, projectId ?? null, agentId ?? null];
  const agents = useQuery({ queryKey: [...prefix, "agents"], queryFn: () => agentsApi.list(c), enabled: tab !== "Run context" });
  const goals = useQuery({ queryKey: [...prefix, "goals"], queryFn: () => goalsApi.list(c), enabled: ["Services & Automation", "Permissions"].includes(tab) || tab === "Missions" });
  const projects = useQuery({ queryKey: [...prefix, "projects"], queryFn: () => projectsApi.list(c), enabled: tab !== "Run context" });
  const missions = useQuery({ queryKey: [...prefix, "missions"], queryFn: async () => (await api.missions(c)).filter(m => !projectId || m.data.projectIds.includes(projectId)), enabled: tab !== "Run context" && !["Services & Automation", "Permissions"].includes(tab) });
  const workstreams = useQuery({ queryKey: [...prefix, "workstreams", missionId], queryFn: () => api.workstreams(c, missionId), enabled: !!missionId });
  const receipts = useQuery({ queryKey: [...prefix, "receipts", missionId], queryFn: () => api.receipts(c, missionId || undefined), enabled: tab === "Receipts", refetchInterval: 10000 });
  const events = useQuery({ queryKey: [...prefix, "events", missionId, before], queryFn: () => api.events(c, missionId || undefined, before), enabled: tab === "Timeline", refetchInterval: before ? false : 10000 });
  const knowledge = useQuery({ queryKey: [...prefix, "knowledge", search, missions.data?.map(m => m.id).join(":")], queryFn: async () => (await api.knowledge(c, search)).filter(e => !projectId || e.data.projectId === projectId || !!missions.data?.some(m => m.id === e.data.missionId)), enabled: tab === "Knowledge" });
  const relationships = useQuery({ queryKey: [...prefix, "relationships", history], queryFn: () => api.relationships(c, history), enabled: tab === "Knowledge" });
  const settings = useQuery({ queryKey: [...prefix, "settings", settingsAgent], queryFn: () => api.employeeSettings(c, settingsAgent), enabled: !!settingsAgent });
  const pack = useQuery({ queryKey: [...prefix, "pack", runId], queryFn: async () => { try { return await api.pack(c, runId); } catch (error) { if ((error as { status?: number }).status === 404) return null; throw error; } }, enabled: !!runId, retry: false });
  const employeeOptions = (agents.data ?? []).map(a => ({ id: a.id, name: a.name }));
  const selectedMission = missions.data?.find(m => m.id === missionId);
  const missionOptions = (missions.data ?? []).map(m => ({ id: m.id, name: m.data.title }));
  const participantOptions = employeeOptions.filter(a => [selectedMission?.data.ownerAgentId, ...(selectedMission?.data.participantAgentIds ?? [])].includes(a.id));
  const save = async (action: () => Promise<unknown>, onSaved: () => void = () => {}) => {
    setBusy(true); setError("");
    try { await action(); onSaved(); await cache.invalidateQueries({ queryKey: companyPrefix }); } catch (e) { setError(e instanceof Error ? e.message : "Could not save changes"); } finally { setBusy(false); }
  };
  const queryError = [agents, goals, projects, missions, workstreams, receipts, events, knowledge, relationships, settings, pack].find(q => q.error)?.error;
  const updateMission = (data: Partial<MissionInput>) => setMissionDraft(d => d ? { ...d, data: { ...d.data, ...data } } : d);
  const updateWork = (data: Partial<WorkstreamInput>) => setWorkDraft(d => d ? { ...d, data: { ...d.data, ...data } } : d);
  const updateKnowledge = (data: Partial<KnowledgeEntityInput>) => setKnowledgeDraft(d => d ? { ...d, data: { ...d.data, ...data } } : d);
  const newReceipt = (parent: Receipt | null = null) => setReceiptDraft({ sender: parent?.recipientAgentId ?? "", recipient: parent?.senderAgentId ?? "", capability: "", kind: parent ? "result" : "investigation_request", subject: parent ? `Re: ${parent.subject}` : "", content: "", parent, key: crypto.randomUUID() });
  if (fixedRunId && !pack.isLoading && !pack.data && !pack.error) return null;
  return <div className="space-y-4">
    <h2 className="text-lg font-medium">{section === "Timeline" ? "Operational context" : section === "Run context" ? "Context supplied to this run" : section}</h2>
    {((error && !missionDraft && !receiptDraft && !knowledgeDraft && !relationshipOpen) || queryError) && <p role="alert" className="text-sm text-destructive">{error || queryError?.message}</p>}
    {missions.isLoading && <p>Loading organization…</p>}
    {["Missions", "Receipts", "Timeline"].includes(tab) && <Select label="Mission" value={missionId} onChange={v => { setMissionId(v); setWorkDraft(null); setReceiptDraft(null); setBefore(undefined); }} options={missionOptions} optional />}
    {tab === "Missions" && <>
      <Button onClick={() => setMissionDraft({ id: null, version: 0, data: { ...emptyMission(), projectIds: projectId ? [projectId] : [] } })}>New Mission</Button>
      {!missionId && !missionDraft && <div className="space-y-2">{missions.data?.map(m => <Button variant="outline" key={m.id} onClick={() => setMissionId(m.id)}>{m.data.title} · {m.data.status}</Button>)}</div>}
      {selectedMission && !missionDraft && <section className="space-y-3 rounded-lg border p-4"><h2 className="text-lg font-medium">{selectedMission.data.title}</h2><p>{selectedMission.data.objective}</p><p className="text-sm">{selectedMission.data.status} · Version {selectedMission.version}</p><p className="whitespace-pre-wrap">{selectedMission.data.summary}</p><p className="whitespace-pre-wrap">{selectedMission.data.roadmap}</p><Button variant="outline" onClick={() => setMissionDraft({ id: selectedMission.id, version: selectedMission.version, data: selectedMission.data })}>Edit mission</Button></section>}
      {missionDraft && <EditorDialog title="Mission" description="Coordinate an operational effort toward Goals. Employees can also create Missions through their permitted actions." close={() => setMissionDraft(null)} busy={busy} error={error}><Form busy={busy} cancel={() => setMissionDraft(null)} save={() => void save(() => api.saveMission(c, missionDraft.id, missionDraft.data, missionDraft.version), () => setMissionDraft(null))}>
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
      </Form></EditorDialog>}
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
    {["Services & Automation", "Permissions"].includes(tab) && <>
      {agentId && <section className="space-y-2"><h3 className="font-medium">Employee goals</h3>{goals.data?.filter(g => g.ownerAgentId === agentId).map(g => <p key={g.id}><Link to={`/goals/${g.id}`}>{g.title}</Link> · {g.status}</p>)}</section>}

      <p className="text-sm"><Link className="underline" to="/agents">Create employees and edit reporting relationships</Link> · <Link className="underline" to="/goals">Manage goals</Link></p>
      {!agentId && <Select label="Employee" value={settingsAgent} options={employeeOptions} onChange={v => { setSettingsAgent(v); setSettingsDraft(null); }} />}
      {settingsAgent && !settings.isLoading && !settingsDraft && <><p>Machine settings: {settings.data ? `version ${settings.data.version}` : "not defined"}</p><Button onClick={() => { setSettingsExpectedVersion(settings.data?.version ?? 0); setSettingsDraft(employeeOrganizationConfigSchema.parse(settings.data?.config ?? {})); }}>Edit settings</Button></>}
      {settings.data && !settingsDraft && <section className="space-y-3">
        {tab === "Services & Automation" ? <>
          <p><strong>Capabilities:</strong> {settings.data.config.capabilities.join(", ") || "None configured"}</p>
          <p><strong>Services provided:</strong> {settings.data.config.servicesProvided.join(", ") || "None configured"}</p>
          <p><strong>Services consumed:</strong> {settings.data.config.servicesConsumed.join(", ") || "None configured"}</p>
          <h3 className="font-medium">Exposed services</h3>{settings.data.config.serviceExposures.length ? settings.data.config.serviceExposures.map((e,i) => <p key={i}>{e.capability} · {e.scope.replaceAll("_", " ")}</p>) : <p>No services exposed.</p>}
          <p><strong>Wake subscriptions:</strong> {settings.data.config.eventSubscriptions.map(s => s.replaceAll(".", " ").replaceAll("_", " ")).join(", ") || "None configured"}</p>
          <p><strong>Periodic review:</strong> {settings.data.config.scheduledReviewMinutes === null ? "Off" : `Every ${settings.data.config.scheduledReviewMinutes / 60} hours`}</p>
          <p className="text-sm text-muted-foreground">Matching subscriptions and configured reviews may start model Runs and consume tokens. Saving an event alone does not call a model.</p>
        </> : <>
          <p>Employee default: {settings.data.config.policy.defaultMode}. Organization policy and base Paperclip permissions still apply.</p>
          {Object.entries(settings.data.config.policy.permissions).map(([action,mode]) => <p key={action}>{action}: {mode?.replaceAll("_", " ") ?? "No action override"}</p>)}
        </>}
      </section>}
      {settingsDraft && <Form busy={busy} cancel={() => setSettingsDraft(null)} save={() => void save(() => api.saveEmployeeSettings(c, settingsAgent, settingsDraft, settingsExpectedVersion), () => setSettingsDraft(null))}>
        {tab === "Services & Automation" && <>
        <p className="text-sm text-muted-foreground">Capabilities describe what this employee can do. Services provided are offerings; services consumed describe what they request. Exposing a capability lets another employee address a Receipt to it. Scope controls eligible callers; ambiguous providers are rejected.</p>
        {([['capabilities', 'Capabilities'], ['servicesProvided', 'Services provided'], ['servicesConsumed', 'Services consumed']] as const).map(([field, label]) => <Lines key={field} label={label} value={settingsDraft[field]} onChange={v => setSettingsDraft({ ...settingsDraft, [field]: v })} />)}
        </>}
        {tab === "Permissions" && <>
        <h3 className="font-medium">Enforced action policy</h3>
        <Select label="Default action policy" value={settingsDraft.policy.defaultMode} options={["allowed", "denied"].map(id => ({ id, name: id }))} onChange={v => setSettingsDraft({ ...settingsDraft, policy: { ...settingsDraft.policy, defaultMode: v as "allowed" | "denied" } })} />
        {organizationActions.map(action => <Select key={action} label={action} emptyLabel="No employee override" optional value={settingsDraft.policy.permissions[action] ?? ""} options={organizationPolicyModes.map(id => ({ id, name: id.replaceAll("_", " ") }))} onChange={v => { const permissions = { ...settingsDraft.policy.permissions }; if (v) permissions[action] = v as typeof organizationPolicyModes[number]; else delete permissions[action]; setSettingsDraft({ ...settingsDraft, policy: { ...settingsDraft.policy, permissions } }); }} />)}
        <p className="text-sm text-muted-foreground">Effective permission requires base Paperclip authorization AND organization policy AND these employee restrictions. Allowed adds no restriction and never grants a missing base permission. Denied blocks the action. No employee override uses the employee default together with organization policy. Owned only requires ownership; assigned only accepts assignment or ownership; participant only requires Mission participation. Approval required blocks employees until a board operator reviews and performs the action.</p>
        </>}
        {tab === "Services & Automation" && <>
        <h3 className="font-medium">Service exposure</h3>
        {settingsDraft.serviceExposures.map((exposure, index) => <div key={index} className="space-y-2 rounded-lg border p-3">
          <Field label="Capability / service"><Input required value={exposure.capability} onChange={e => setSettingsDraft({ ...settingsDraft, serviceExposures: settingsDraft.serviceExposures.map((v, i) => i === index ? { ...v, capability: e.target.value } : v) })} /></Field>
          <Select label="Service scope" value={exposure.scope} options={["mission", "org_subtree", "company"].map(id => ({ id, name: id }))} onChange={v => setSettingsDraft({ ...settingsDraft, serviceExposures: settingsDraft.serviceExposures.map((e, i) => i === index ? { ...e, scope: v as typeof exposure.scope } : e) })} />
          {exposure.scope === "org_subtree" && <Select label="Organization subtree root" optional value={exposure.orgRootAgentId ?? ""} options={employeeOptions} onChange={v => setSettingsDraft({ ...settingsDraft, serviceExposures: settingsDraft.serviceExposures.map((e, i) => i === index ? { ...e, orgRootAgentId: v || undefined } : e) })} />}
          <Button type="button" variant="outline" onClick={() => setSettingsDraft({ ...settingsDraft, serviceExposures: settingsDraft.serviceExposures.filter((_, i) => i !== index) })}>Remove service exposure</Button>
        </div>)}
        <Button type="button" variant="outline" onClick={() => setSettingsDraft({ ...settingsDraft, serviceExposures: [...settingsDraft.serviceExposures, { capability: "", scope: "mission" }] })}>Add service exposure</Button>
        <p className="text-sm text-muted-foreground">Persisting an event is not a model call. A matching wake subscription may start a provider Run and consume tokens.</p>
        {Object.entries({ Mission: ["mission."], Receipt: ["receipt."], "Decision / Escalation": ["decision.", "employee.escalation"], "Goal / Review": ["goal.", "review."], "Knowledge / Context": ["knowledge.", "context."], "Workstream / Run": ["workstream.", "run."], "Role / permissions": ["contract.updated"] }).map(([group, prefixes]) => {
          const options = organizationEventKinds.filter(kind => prefixes.some(prefix => kind.startsWith(prefix)));
          return <Choices key={group} label={group} values={settingsDraft.eventSubscriptions} options={options.map(id => ({ id, name: id === "contract.updated" ? "employee settings updated" : id.replaceAll(".", " ").replaceAll("_", " ") }))} onChange={v => setSettingsDraft({ ...settingsDraft, eventSubscriptions: [...settingsDraft.eventSubscriptions.filter(kind => !options.includes(kind as typeof options[number])), ...v.filter(kind => options.includes(kind as typeof options[number]))] })} />;
        })}
        <details><summary>Advanced event subscriptions</summary><Lines label="Additional event subscriptions" value={settingsDraft.eventSubscriptions.filter(v => !(organizationEventKinds as readonly string[]).includes(v))} onChange={v => setSettingsDraft({ ...settingsDraft, eventSubscriptions: [...new Set([...settingsDraft.eventSubscriptions.filter(value => (organizationEventKinds as readonly string[]).includes(value)), ...v])] })} /></details>
        <Field label="Periodic review"><select className={selectClass} value={settingsDraft.scheduledReviewMinutes === null ? "off" : [60, 240, 1440].includes(settingsDraft.scheduledReviewMinutes) ? String(settingsDraft.scheduledReviewMinutes) : "custom"} onChange={e => setSettingsDraft({ ...settingsDraft, scheduledReviewMinutes: e.target.value === "off" ? null : e.target.value === "custom" ? 15 : Number(e.target.value) })}><option value="off">Off</option><option value="60">Every hour</option><option value="240">Every 4 hours</option><option value="1440">Every 24 hours</option><option value="custom">Custom</option></select></Field>
        {settingsDraft.scheduledReviewMinutes !== null && ![60, 240, 1440].includes(settingsDraft.scheduledReviewMinutes) && <Field label="Custom review interval (minutes)"><Input type="number" min={15} value={settingsDraft.scheduledReviewMinutes} onChange={e => setSettingsDraft({ ...settingsDraft, scheduledReviewMinutes: Number(e.target.value) })} /></Field>}
        <p className="text-sm text-muted-foreground">A periodic review may start a model Run even without another event and consume tokens. Select the Goal / Review subscription “review scheduled” to receive these reviews. Saving preserves your current schedule unless you change it.</p>
        </>}
      </Form>}

    </>}
    {tab === "Receipts" && <>
      <p className="text-sm text-muted-foreground">Receipts request a service. They keep the sender’s work ownership. Employees can send Receipts through the API. A matching wake subscription can start a recipient Run.</p>
      <Button onClick={() => newReceipt()}>New Receipt</Button>
      <Field label="Search receipts"><Input value={receiptSearch} onChange={e => setReceiptSearch(e.target.value)} /></Field>
      <Select label="Receipt kind" optional value={receiptKind} onChange={setReceiptKind} options={receiptKinds.map(id => ({ id, name: id.replaceAll("_", " ") }))} />
      {receiptDraft && <EditorDialog title="Receipt" description="Employees exchange requests and results directly or through a service. The sender keeps work ownership." close={() => setReceiptDraft(null)} busy={busy} error={error}><Form busy={busy} cancel={() => setReceiptDraft(null)} save={() => void save(() => api.sendReceipt(c, { missionId: receiptDraft.parent?.missionId ?? missionId, projectId: receiptDraft.parent?.projectId ?? null, senderAgentId: receiptDraft.sender, ...(receiptDraft.capability ? { capability: receiptDraft.capability } : { recipientAgentId: receiptDraft.recipient }), kind: receiptDraft.kind as Receipt["kind"], subject: receiptDraft.subject, payload: { content: receiptDraft.content }, priority: "medium", parentReceiptId: receiptDraft.parent?.id ?? null, idempotencyKey: receiptDraft.key, metadata: {} }), () => setReceiptDraft(null))}>
        <Select label="Mission for receipt" value={receiptDraft.parent?.missionId ?? missionId} options={missionOptions} onChange={setMissionId} />
        <Select label="From" value={receiptDraft.sender} options={participantOptions} onChange={v => setReceiptDraft({ ...receiptDraft, sender: v })} />
        <Select label="To" value={receiptDraft.recipient} options={employeeOptions} onChange={v => setReceiptDraft({ ...receiptDraft, recipient: v, capability: "" })} />
        {!receiptDraft.parent && <Field label="Or target capability / service"><Input value={receiptDraft.capability} onChange={e => setReceiptDraft({ ...receiptDraft, capability: e.target.value, recipient: "" })} /></Field>}
        <Select label="Kind" value={receiptDraft.kind} options={receiptKinds.map(id => ({ id, name: id }))} onChange={v => setReceiptDraft({ ...receiptDraft, kind: v })} />
        <Field label="Subject"><Input required value={receiptDraft.subject} onChange={e => setReceiptDraft({ ...receiptDraft, subject: e.target.value })} /></Field>
        <Field label="Request / response"><Textarea required value={receiptDraft.content} onChange={e => setReceiptDraft({ ...receiptDraft, content: e.target.value })} /></Field>
      </Form></EditorDialog>}
      {receipts.isLoading && <p>Loading receipts…</p>}
      {receipts.data?.filter(r => (!receiptKind || r.kind === receiptKind) && `${r.subject} ${JSON.stringify(r.payload)}`.toLowerCase().includes(receiptSearch.toLowerCase())).map(r => <article key={r.id} className="space-y-2 rounded-lg border p-4"><h2 className="font-medium">{r.subject} · {r.status}</h2><p className="text-sm">{employeeOptions.find(a => a.id === r.senderAgentId)?.name} → {employeeOptions.find(a => a.id === r.recipientAgentId)?.name} · {r.kind}</p><pre className="whitespace-pre-wrap text-sm">{JSON.stringify(r.payload, null, 2)}</pre><p className="text-sm text-muted-foreground">Correlation: {r.correlationId}{r.parentReceiptId ? ` · Reply to ${r.parentReceiptId}` : ""}</p><div className="flex gap-2"><Button variant="outline" onClick={() => { setMissionId(r.missionId); newReceipt(r); }}>Reply</Button>{r.status === "sent" && <Button disabled={busy} variant="outline" onClick={() => void save(() => api.acknowledge(c, r.id))}>Acknowledge</Button>}</div></article>)}
    </>}
    {tab === "Knowledge" && <>
      <Field label="Search knowledge"><Input value={search} onChange={e => setSearch(e.target.value)} /></Field><Button onClick={() => setKnowledgeDraft({ id: null, version: 0, data: { ...emptyKnowledge(), projectId: projectId ?? null } })}>Add Knowledge</Button>
      {knowledgeDraft && <EditorDialog title="Knowledge" description="Record shared information and the source that supports it." close={() => setKnowledgeDraft(null)} busy={busy} error={error}><Form busy={busy} cancel={() => setKnowledgeDraft(null)} save={() => void save(() => api.saveKnowledge(c, knowledgeDraft.id, knowledgeDraft.data, knowledgeDraft.version), () => setKnowledgeDraft(null))}>
        {([['kind', 'Entity type'], ['key', 'Stable key'], ['name', 'Name'], ['provenance', 'Source / provenance']] as const).map(([field, label]) => <Field key={field} label={label}><Input required value={knowledgeDraft.data[field]} onChange={e => updateKnowledge({ [field]: e.target.value })} /></Field>)}
        <Field label="Current truth / summary"><Textarea value={knowledgeDraft.data.summary} onChange={e => updateKnowledge({ summary: e.target.value })} /></Field>
        <Select label="Mission scope" optional value={knowledgeDraft.data.missionId ?? ""} options={missionOptions} onChange={v => updateKnowledge({ missionId: v || null })} />
        <Select label="Project scope" optional value={knowledgeDraft.data.projectId ?? ""} options={(projects.data ?? []).map(p => ({ id: p.id, name: p.name }))} onChange={v => updateKnowledge({ projectId: v || null })} />
        <Field label="Confidence (0–1, optional)"><Input type="number" min={0} max={1} step="any" value={knowledgeDraft.data.confidence ?? ""} onChange={e => updateKnowledge({ confidence: e.target.value ? Number(e.target.value) : null })} /></Field>
      </Form></EditorDialog>}
      {knowledge.data?.map(e => <article key={e.id} className="space-y-2 rounded-lg border p-4"><Button variant="link" onClick={() => setSelectedEntityId(e.id)}>{e.data.name} · {e.data.kind}</Button><p className="whitespace-pre-wrap">{e.data.summary}</p><p className="text-sm text-muted-foreground">Source: {e.data.provenance} · Updated {new Date(e.updatedAt).toLocaleString()} · Version {e.version}</p><Button variant="outline" onClick={() => setKnowledgeDraft({ id: e.id, version: e.version, data: e.data })}>Edit</Button></article>)}
      {!knowledge.isLoading && !knowledge.data?.length && <p className="text-sm text-muted-foreground">No Knowledge entities match this view. Add Knowledge first; relationship endpoints need existing entities.</p>}
      {selectedEntityId && knowledge.data?.filter(e => e.id === selectedEntityId).map(e => <EditorDialog key={e.id} title={e.data.name} description={e.data.kind} close={() => setSelectedEntityId(null)} busy={false} error="">
        <p className="whitespace-pre-wrap">{e.data.summary}</p><p>Source: {e.data.provenance}</p><p>Updated {new Date(e.updatedAt).toLocaleString()} · Version {e.version}</p>
        <p>Project: {projects.data?.find(p => p.id === e.data.projectId)?.name ?? "Company-wide"} · Mission: {missionOptions.find(m => m.id === e.data.missionId)?.name ?? "None"}</p>
        <h3 className="font-medium">Relationships</h3>{relationships.data?.filter(r => r.sourceId === e.id || r.targetId === e.id).map(r => <p key={r.id}>{knowledge.data?.find(k => k.id === r.sourceId)?.data.name ?? "Related entity"} → {r.kind} → {knowledge.data?.find(k => k.id === r.targetId)?.data.name ?? "Related entity"} · {r.validTo ? "Superseded" : "Current"}<br />Source: {r.provenance}</p>)}
      </EditorDialog>)}
      <div className="flex items-center justify-between gap-4"><h2 className="text-lg font-medium">Relationships</h2><Button disabled={!knowledge.data?.length} onClick={() => { setRelation({ source: "", target: "", kind: "", provenance: "", supersedes: "" }); setRelationshipOpen(true); }}>Add Relationship</Button></div><label className="flex gap-2 text-sm"><input type="checkbox" checked={history} onChange={e => setHistory(e.target.checked)} />Show superseded relationships</label>
      {relationships.data?.map(r => <article key={r.id} className="space-y-2 rounded-lg border p-3"><p>{knowledge.data?.find(e => e.id === r.sourceId)?.data.name ?? r.sourceId} → {r.kind} → {knowledge.data?.find(e => e.id === r.targetId)?.data.name ?? r.targetId}</p><p className="text-sm">{r.provenance} · {r.validTo ? "Superseded" : "Current"}</p>{!r.validTo && <Button variant="outline" onClick={() => { setRelation({ source: r.sourceId, target: "", kind: r.kind, provenance: "", supersedes: r.id }); setRelationshipOpen(true); }}>Supersede</Button>}</article>)}
      {relationshipOpen && <EditorDialog title={relation.supersedes ? "Replace relationship" : "Add Relationship"} description="Connect existing Knowledge entities and record the supporting source." close={() => setRelationshipOpen(false)} busy={busy} error={error}><Form busy={busy} cancel={() => setRelationshipOpen(false)} save={() => void save(() => api.addRelationship(c, { sourceId: relation.source, targetId: relation.target, kind: relation.kind, provenance: relation.provenance, confidence: null, supersedesId: relation.supersedes || null, metadata: {} }), () => setRelationshipOpen(false))}>
        <h3 className="font-medium">{relation.supersedes ? "Replace relationship" : "Add relationship"}</h3>
        <Select label="Source" value={relation.source} options={(knowledge.data ?? []).map(e => ({ id: e.id, name: e.data.name }))} onChange={v => setRelation({ ...relation, source: v })} />
        <Field label="Relationship type"><Input required value={relation.kind} onChange={e => setRelation({ ...relation, kind: e.target.value })} /></Field>
        <Select label="Target" value={relation.target} options={(knowledge.data ?? []).map(e => ({ id: e.id, name: e.data.name }))} onChange={v => setRelation({ ...relation, target: v })} />
        <Field label="Source / reason"><Input required value={relation.provenance} onChange={e => setRelation({ ...relation, provenance: e.target.value })} /></Field>
      </Form></EditorDialog>}
    </>}
    {tab === "Timeline" && <>
      <p className="text-sm text-muted-foreground">Append-only company history, including mission changes, receipt exchanges, knowledge provenance, and run outcomes.</p>
      {events.data?.map(e => <article key={e.id} className="space-y-2 rounded-lg border p-4"><h2 className="font-medium">{e.subject}</h2><p className="text-sm">{e.kind} · {e.origin ?? e.actorType} · {new Date(e.createdAt).toLocaleString()}</p><p className="whitespace-pre-wrap">{e.summary}</p><p className="text-sm text-muted-foreground">{e.actorType}: {e.actorId}{e.causationId ? ` · Caused by ${e.causationId}` : ""}{e.correlationId ? ` · Correlation ${e.correlationId}` : ""}</p>{e.runId && <span>Run {e.runId}</span>}</article>)}
      <div className="flex gap-2"><Button variant="outline" onClick={() => setBefore(undefined)}>Latest</Button><Button variant="outline" disabled={!events.data?.length} onClick={() => setBefore(events.data?.at(-1)?.createdAt)}>Older events</Button></div>
    </>}
    {tab === "Run context" && <>
      {!fixedRunId && <form className="flex items-end gap-2" onSubmit={e => { e.preventDefault(); setRunId(runInput); }}><Field label="Run ID"><Input required value={runInput} onChange={e => setRunInput(e.target.value)} /></Field><Button>Inspect</Button></form>}
      {pack.isLoading && <p>Loading context…</p>}{pack.data && <section className="space-y-3">
        <p>Built {new Date(pack.data.createdAt).toLocaleString()}</p>
        <RoleCharterEvidence provenance={pack.data.pack.instructionProvenance} />
        <details><summary>Context records supplied to the run</summary><pre className="overflow-auto whitespace-pre-wrap rounded-lg border p-4 text-sm">{JSON.stringify(Object.fromEntries(Object.entries(pack.data.pack).filter(([key]) => key !== "instructionProvenance")), null, 2)}</pre></details>
      </section>}

    </>}
  </div>;
}

export function InboxReceipts() {
  return <OrganizationPanel section="Receipts" />;
}
