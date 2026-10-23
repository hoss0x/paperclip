import { useState } from "react";
import { OrganizationPanel } from "../OrganizationPanels";
import { useCompany } from "../../context/CompanyContext";
import { useQuery } from "@tanstack/react-query";
import { operationsTimelineCategories, type OperationsTimelineEntry, type OperationsTimelineQuery } from "@paperclipai/shared";
import { companyOsApi } from "../../api/company-os";
import { agentsApi } from "../../api/agents";
import { projectsApi } from "../../api/projects";
import { Link } from "../../lib/router";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "../../components/ui/sheet";

export function groupTimelineEvidence(entries: OperationsTimelineEntry[]) {
  const grouped = new Map<string, OperationsTimelineEntry[]>();
  for (const entry of entries) {
    const metadata = entry.details.metadata as Record<string, unknown> | undefined;
    const key = entry.source === "event" && typeof metadata?.activityId === "string" ? `activity:${metadata.activityId}` : `${entry.source}:${entry.id}`;
    grouped.set(key, [...(grouped.get(key) ?? []),entry]);
  }
  return Array.from(grouped.values()).map(records => records.length === 1 ? records[0] : ({ ...records[0], details: { ...records[0].details, scopeProjections: records.map(r => ({ id:r.id, missionId:r.missionId, sourceId:r.details.sourceId })) } }));
}
const selectClass = "rounded-md border border-input bg-background px-3 py-2 text-sm";
const dateInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0,16);
export function timelineQueryRange(range: { from: string; to: string }) {
  // datetime-local is minute-granular. Include the entire selected end minute,
  // otherwise a freshly created event is invisible for up to 59 seconds.
  return { from: new Date(range.from).toISOString(), to: new Date(Date.parse(range.to) + 59999).toISOString() };
}
export function timelineRange(days: number, now = new Date()) {
  const start = new Date(now);
  if (days === 1) start.setHours(0,0,0,0); else start.setDate(start.getDate() - days);
  return { from: dateInput(start), to: dateInput(now) };
}
export function OperationsTimeline({ companyId }: { companyId: string }) {
  const [range, setRange] = useState(() => timelineRange(7));
  const [preset, setPreset] = useState("7");
  const [filters, setFilters] = useState<Partial<OperationsTimelineQuery>>({});
  const [cursor, setCursor] = useState<{ beforeAt: string; beforeId: string } | null>(null);
  const [selected, setSelected] = useState<OperationsTimelineEntry | null>(null);
  const [density, setDensity] = useState("comfortable");
  const [lanes, setLanes] = useState(false);
  const [raw, setRaw] = useState(false);
  const agents = useQuery({ queryKey: ["organization",companyId,"agents"], queryFn: () => agentsApi.list(companyId) });
  const projects = useQuery({ queryKey: ["organization",companyId,"projects"], queryFn: () => projectsApi.list(companyId) });
  const missions = useQuery({ queryKey: ["organization",companyId,"timeline-missions"], queryFn: () => companyOsApi.missions(companyId) });
  const valid = Number.isFinite(Date.parse(range.from)) && Number.isFinite(Date.parse(range.to)) && Date.parse(range.from) <= Date.parse(range.to);
  const query = valid ? { ...filters, ...timelineQueryRange(range), ...cursor } : null;
  const page = useQuery({ queryKey: ["organization",companyId,"operations",query], queryFn: () => companyOsApi.operationsTimeline(companyId, query!), enabled: !!query });
  function filter(key: keyof OperationsTimelineQuery, value: string) { setFilters(f => ({ ...f, [key]: value || undefined })); setCursor(null); }
  function shift(direction: number) { const width = Date.parse(range.to)-Date.parse(range.from); setRange({ from: dateInput(new Date(Date.parse(range.from)+direction*width)), to: dateInput(new Date(Date.parse(range.to)+direction*width)) }); setPreset("custom"); setCursor(null); }
  function zoom(factor: number) { const end = Date.parse(range.to), width = Math.max(60000,(end-Date.parse(range.from))*factor); setRange({ from: dateInput(new Date(end-width)), to:range.to }); setPreset("custom"); setCursor(null); }
  const entries = groupTimelineEvidence(page.data?.entries ?? []);
  const groups = lanes ? [...new Set(entries.map(e => e.agentName))].map(name => ({ name, entries: entries.filter(e => e.agentName === name) })) : [{ name: "Operational history", entries }];
  const error = [page,agents,projects,missions].find(q => q.error)?.error;
  return <section className="space-y-4" aria-label="Operations Timeline">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-medium">Operations Timeline</h2><Link to="/activity">Raw Events / Technical Audit</Link></div>
    <p className="text-sm text-muted-foreground">Runs and organizational evidence, newest first. Each card keeps its source identity. Tokens are provider-reported usage for that Run; cached input is a breakdown and depends on the provider’s accounting.</p>
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-2 text-sm">Range<select className={selectClass} value={preset} onChange={e => { setPreset(e.target.value); if(e.target.value !== "custom") setRange(timelineRange(Number(e.target.value))); setCursor(null); }}><option value="1">Today</option><option value="7">7 days</option><option value="30">30 days</option><option value="custom">Custom range</option></select></label>
      <label className="flex flex-col gap-2 text-sm">From<Input type="datetime-local" value={range.from} onChange={e => { setRange(r => ({ ...r,from:e.target.value })); setPreset("custom"); setCursor(null); }} /></label>
      <label className="flex flex-col gap-2 text-sm">To<Input type="datetime-local" value={range.to} onChange={e => { setRange(r => ({ ...r,to:e.target.value })); setPreset("custom"); setCursor(null); }} /></label>
      <Button variant="outline" disabled={!valid} onClick={() => zoom(0.5)}>Zoom in</Button><Button variant="outline" disabled={!valid} onClick={() => zoom(2)}>Zoom out</Button>
      <Button variant="outline" disabled={!valid} onClick={() => shift(-1)}>Previous range</Button><Button variant="outline" disabled={!valid} onClick={() => shift(1)}>Next range</Button>
    </div>
    <div className="flex flex-wrap items-end gap-3">
      {([ ["agentId","Agent",agents.data?.map(a => ({id:a.id,name:a.name}))], ["projectId","Project",projects.data?.map(p => ({id:p.id,name:p.name}))], ["missionId","Mission",missions.data?.map(m => ({id:m.id,name:m.data.title}))], ["category","Category",operationsTimelineCategories.map(id => ({id,name:id}))], ["status","Run outcome",["queued","running","succeeded","failed","cancelled","timed_out"].map(id => ({id,name:id.replaceAll("_"," ")}))] ] as const).map(([key,label,options]) => <label key={key} className="flex flex-col gap-2 text-sm">{label}<select className={selectClass} value={filters[key] ?? ""} onChange={e => filter(key,e.target.value)}><option value="">All</option>{options?.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>)}
      <label className="flex flex-col gap-2 text-sm">Search<Input value={filters.search ?? ""} onChange={e => filter("search",e.target.value)} placeholder="Title, employee or summary" /></label>
      <Button variant="outline" onClick={() => { setFilters({}); setRange(timelineRange(7)); setPreset("7"); setCursor(null); }}>Reset filters</Button>
    </div>
    <div className="flex flex-wrap items-center gap-3"><Button variant="outline" onClick={() => { if(preset !== "custom") setRange(timelineRange(Number(preset))); setCursor(null); void page.refetch(); }}>Refresh history</Button><label className="text-sm">Density <select className={selectClass} value={density} onChange={e => setDensity(e.target.value)}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={lanes} onChange={e => setLanes(e.target.checked)} />Group by employee</label><span className="text-sm text-muted-foreground">Now: {new Date().toLocaleString()} · {entries.length} records on this page</span></div>
    <Button variant="outline" onClick={() => setRaw(v => !v)}>{raw ? "Hide raw Context Events" : "Raw Context Events"}</Button>
    {raw && <OrganizationPanel section="Timeline" companyId={companyId} />}
    <p className="text-sm text-muted-foreground">Categories: {operationsTimelineCategories.join(" · ")}</p>
    {!valid && <p role="alert">Choose a valid start and end time.</p>}{error && <p role="alert" className="text-destructive">{error.message}</p>}
    {page.isLoading && <p>Loading history…</p>}{!page.isLoading && !entries.length && valid && <p>No records match this range and these filters.</p>}
    {groups.map(group => <section key={group.name} className="space-y-3">{lanes && <h3 className="font-medium">{group.name}</h3>}{group.entries.map(e => <button type="button" key={`${e.source}:${e.id}`} onClick={() => setSelected(e)} className={`w-full rounded-lg border text-left hover:bg-accent focus-visible:ring-2 ${density === "compact" ? "p-3" : "p-4"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{e.title}</span><time className="font-mono text-sm">{new Date(e.at).toLocaleString()}</time></div>
      <p className="text-sm text-muted-foreground">{e.agentName} · {e.category}{e.status ? ` · ${e.status}` : ""}{e.missionName ? ` · ${e.missionName}` : ""}</p>
      {density !== "compact" && <p className="whitespace-pre-wrap text-sm">{e.summary}</p>}
      {Array.isArray(e.details.scopeProjections) && <p className="text-sm text-muted-foreground">One source activity · {e.details.scopeProjections.length} scope records preserved</p>}
      {e.usage && <p className="font-mono text-sm">{e.usage.totalTokens.toLocaleString()} tokens · {e.usage.cachedInputTokens.toLocaleString()} cached input{typeof e.details.costUsd === "number" ? ` · $${e.details.costUsd.toFixed(4)}` : " · cost not reported"}</p>}
    </button>)}</section>)}
    <div className="flex items-center justify-between"><Button variant="outline" disabled={!cursor} onClick={() => setCursor(null)}>Latest in range</Button><Button variant="outline" disabled={!page.data?.next} onClick={() => setCursor(page.data?.next ?? null)}>Older records</Button></div>
    <Sheet open={!!selected} onOpenChange={open => { if(!open) setSelected(null); }}><SheetContent className="overflow-y-auto sm:max-w-2xl"><SheetHeader><SheetTitle>{selected?.title}</SheetTitle><SheetDescription>Recorded evidence and proven relationships. Missing data is not inferred.</SheetDescription></SheetHeader>{selected && <div className="space-y-4 p-4">
      <p>{new Date(selected.at).toLocaleString()} · {selected.agentName} · {selected.category}</p><p className="whitespace-pre-wrap">{selected.summary}</p>
      {selected.missionName && <p>Mission: {selected.missionName}</p>}{selected.projectId && <Link className="underline" to={`/projects/${selected.projectId}`}>Open project</Link>}
      {selected.runId && selected.agentId && <p><Link className="underline" to={`/agents/${selected.agentId}/runs/${selected.runId}`}>Open Run and saved Context Pack</Link></p>}
      {selected.usage && <p className="font-mono text-sm">Input {selected.usage.inputTokens.toLocaleString()} · Cached input {selected.usage.cachedInputTokens.toLocaleString()} · Output {selected.usage.outputTokens.toLocaleString()} · Total {selected.usage.totalTokens.toLocaleString()}</p>}
      <dl className="space-y-2 text-sm">{Object.entries(selected.details).filter(([key,v]) => v != null && typeof v !== "object" && key !== "metadata").map(([key,value]) => <div key={key}><dt className="text-muted-foreground">{key.replace(/([A-Z])/g," $1")}</dt><dd className="break-all font-mono">{String(value)}</dd></div>)}</dl>
      <h3 className="font-medium">Related evidence on this page</h3>
      {entries.filter(e => e.id !== selected.id && ((e.runId && e.runId === selected.runId) || (e.details.correlationId && e.details.correlationId === selected.details.correlationId))).map(e => <Button key={`${e.source}:${e.id}`} variant="outline" onClick={() => setSelected(e)}>{e.title} · {e.category}</Button>)}
      <p className="text-sm text-muted-foreground">Links use the recorded Run or correlation ID. Temporal proximity alone does not establish cause.</p>
      <details><summary>Raw event / evidence</summary><pre className="whitespace-pre-wrap break-all text-sm">{JSON.stringify(selected,null,2)}</pre></details>
    </div>}</SheetContent></Sheet>
  </section>;
}

export function OperationsTimelinePage() {
  const { selectedCompanyId } = useCompany();
  return selectedCompanyId ? <OperationsTimeline key={selectedCompanyId} companyId={selectedCompanyId} /> : <p>Select a company to view its Timeline.</p>;
}
