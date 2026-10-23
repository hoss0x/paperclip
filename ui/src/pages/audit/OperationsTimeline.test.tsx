// @vitest-environment jsdom
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OperationsTimeline, timelineRange, timelineQueryRange, groupTimelineEvidence } from "./OperationsTimeline";
const calls = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../OrganizationPanels", () => ({ OrganizationPanel: () => <div>Raw context records</div> }));
vi.mock("../../lib/router", async () => ({ Link: (await import("react-router-dom")).Link }));
vi.mock("../../api/agents", () => ({agentsApi:{list:async () => [{id:"a",name:"Researcher"}]}}));
vi.mock("../../api/projects", () => ({projectsApi:{list:async () => []}}));
vi.mock("../../api/company-os", () => ({companyOsApi:{missions:async () => [], operationsTimeline:calls.read}}));
let root:Root, container:HTMLDivElement;
const flush=async () => {await new Promise(r => setTimeout(r,20));};
async function until(test:()=>void) {let error;for(let i=0;i<30;i++){await flush();try{test();return;}catch(e){error=e;}}throw error;}
beforeEach(() => {container=document.createElement("div");document.body.append(container);root=createRoot(container);calls.read.mockReset().mockResolvedValue({entries:[{id:"run-a",source:"run",at:"2026-10-01T12:00:00Z",title:"Investigate request",category:"Runs",agentId:"a",agentName:"Researcher",status:"succeeded",summary:"receipt.received",missionId:null,missionName:null,projectId:null,runId:"run-a",usage:{inputTokens:120,cachedInputTokens:100,outputTokens:10,totalTokens:130},details:{sourceId:"canonical-a",receiptId:"request-a"}}],next:{beforeAt:"2026-10-01T12:00:00Z",beforeId:"run-a"}});});
afterEach(()=>{flushSync(()=>root.unmount());container.remove();});
function render(){flushSync(()=>root.render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter><OperationsTimeline companyId="c" /></MemoryRouter></QueryClientProvider>));}
it("keeps filters and raw audit visible and opens canonical Run evidence",async()=>{render();await until(()=>expect(container.textContent).toContain("130 tokens"));expect(container.querySelector('a')?.textContent).toBe("Raw Events / Technical Audit");for(const label of ["Range","Agent","Project","Mission","Category","Run outcome","Search","Density"])expect(container.textContent).toContain(label);const card=Array.from(container.querySelectorAll('button')).find(b=>b.textContent?.includes('Investigate request'))!;flushSync(()=>card.click());expect(document.body.textContent).toContain("canonical-a");expect(document.body.querySelector('[role="dialog"] a')?.getAttribute('href')).toBe('/agents/a/runs/run-a');});
it("passes search and cursor to the server and resets the cursor on filter changes",async()=>{render();await until(()=>expect(calls.read).toHaveBeenCalled());flushSync(()=>Array.from(container.querySelectorAll('button')).find(b=>b.textContent==='Older records')!.click());await until(()=>expect(calls.read.mock.lastCall?.[1]).toHaveProperty('beforeId','run-a'));const search=container.querySelector('input[placeholder]')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(search,'result');flushSync(()=>search.dispatchEvent(new Event('input',{bubbles:true})));await until(()=>expect(calls.read.mock.lastCall?.[1]).toMatchObject({search:'result'}));expect(calls.read.mock.lastCall?.[1]).not.toHaveProperty('beforeId');});
it("starts Today at local midnight",()=>{const now=new Date(2026,9,23,13,15);expect(timelineRange(1,now).from).toBe('2026-10-23T00:00');});

it("groups scope copies only when their canonical activity ID matches", () => {
 const base = { id:"one",source:"event" as const,details:{metadata:{activityId:"same"},sourceId:"activity:same"} };
 const grouped = groupTimelineEvidence([base,{...base,id:"two",details:{...base.details,sourceId:"activity:same:mission:x"}},{...base,id:"three",details:{metadata:{activityId:"different"}}}] as any);
 expect(grouped).toHaveLength(2);expect(grouped[0].details.scopeProjections).toHaveLength(2);
});

it("includes newly created records through the selected end minute", () => {
 const now = new Date(2026,9,23,13,15,45);
 const query = timelineQueryRange(timelineRange(7,now));
 expect(Date.parse(query.to)).toBeGreaterThan(now.getTime());
 expect(new Date(query.to).getSeconds()).toBe(59);
});

it("groups repeated work-product evidence for a recorded Run while preserving separate activity IDs", () => {
 const base = { id:"one",source:"event" as const,runId:"run",details:{workProductId:"product",metadata:{activityId:"first"},sourceId:"activity:first"} };
 const grouped = groupTimelineEvidence([base,{...base,id:"two",details:{...base.details,metadata:{activityId:"second"},sourceId:"activity:second"}}] as any);
 expect(grouped).toHaveLength(1);expect(grouped[0].details.scopeProjections).toMatchObject([{id:"one",sourceId:"activity:first"},{id:"two",sourceId:"activity:second"}]);
});
