import { createAcpRuntime } from 'acpx/runtime';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { withExecutionResourceContext } from '../execution-resource-context.js';
import { ExecutionResourceAdmission, resolveExecutionResourcePolicy } from '../execution-resource-policy.js';
import { ensureSystemdExecutionSlice } from '../systemd-execution-slice.js';
import type { ExecutionResourceEvidence } from '../systemd-execution.js';
import { prepareAcpxRuntimeResources } from './resource-runtime.js';
import { createAcpxEngineExecutor } from './execute.js';
const ctl = promisify(execFile);
const enabled = process.platform === 'linux' && process.env.PAPERCLIP_TEST_SYSTEMD === '1';
async function setup() {
  const scratchDir = process.env.PAPERCLIP_SCRATCH_DIR!;
  if (!scratchDir) throw new Error('Tests require run-owned scratch');
  const policy = resolveExecutionResourcePolicy({ PAPERCLIP_EXECUTION_MEMORY_MAX_MIB: '128', PAPERCLIP_EXECUTION_MEMORY_HIGH_MIB: '128' }, 'linux', 8 * 1024 ** 3);
  const slice = await ensureSystemdExecutionSlice({ ...policy, capacityBytes: policy.memoryMaxBytes }, `paperclip-legacy${randomUUID().replaceAll('-', '')}.slice`);
  const evidence: ExecutionResourceEvidence[] = [];
  const root = await fs.mkdtemp(path.join(scratchDir, 'legacy-acpx-'));
  return { root, resources: { policy, scratchDir, slice, admission: new ExecutionResourceAdmission(policy.memoryMaxBytes, 1),
    nativeLoaderCommand: () => process.env.PAPERCLIP_TEST_RESOURCE_LOADER!, onEvidence: async (event: ExecutionResourceEvidence) => { evidence.push(event); } }, evidence,
    async close() { await ctl('systemctl', ['--user','stop',slice]); await ctl('systemctl', ['--user','revert',slice]); await fs.rm(root,{recursive:true,force:true}); } };
}
async function run(root: string, configEnv: Record<string,string> = {}, onSpawn = async (_meta: {pid:number}) => {}, rejectTerminalCleanup = false) {
  const fixture = path.resolve('scripts/mcp-fixtures/servers/acp-resource-agent.mjs');
  const logs: string[] = [];
  const result = await createAcpxEngineExecutor(rejectTerminalCleanup ? { createRuntime: options => createAcpRuntime({...options,spawnProcess:async(command,args,spawnOptions)=>{
    const worker=await options.spawnProcess!(command,args,spawnOptions);
    if(Array.isArray(spawnOptions.stdio) && spawnOptions.stdio[0] === 'ignore') {
      const completion=worker.completion.then(()=>{throw new Error('forced cleanup rejection');});
      void completion.catch(()=>{}); return {...worker,completion};
    }
    return worker;
  }}) } : {}) ({ runId: randomUUID(), agent: {id:'resource-agent',companyId:'resource-company'}, runtime: {}, context:{},
    config: {agent:'custom',agentCommand:`${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)}`,mode:'oneshot',stateDir:root,cwd:process.cwd(),permissionMode:'approve-all',env:{RESOURCE_PROVIDER_SECRET:'exact-private-value',...configEnv}},
    onLog: async (_stream: string, text: string) => { logs.push(text); }, onMeta: async () => {}, onSpawn } as never);
  return {result,logs};
}
(enabled ? describe : describe.skip)('older ACPX runtime resource ownership', () => {
  it('contains real provider and terminal roots in one slot and cleans detached descendants', async () => {
    const test = await setup(); let providerPid=0;
    try {
      const {result,logs} = await withExecutionResourceContext(test.resources, () => run(test.root,{RESOURCE_FIXTURE_TERMINAL:'1',RESOURCE_IDENTITY_FILE:path.join(test.root,'identity.json')},async meta => { providerPid=meta.pid; expect(test.resources.admission.snapshot.active).toBe(1); }));
      expect(result.exitCode,JSON.stringify({result,logs})).toBe(0);
      const identity = JSON.parse(await fs.readFile(path.join(test.root,'identity.json'),'utf8'));
      expect(identity.pid).toBe(providerPid);
      expect(identity.secret).toBe('exact-private-value');
      const terminal = JSON.parse(identity.terminalOutput.trim());
      expect(terminal.secret).toBe('terminal-private-value');
      for (const group of [identity.cgroup,terminal.cgroup]) { expect(group).toContain('.scope'); expect(group).not.toContain('paperclipai.service'); }
      expect(identity.cgroup.split('/').slice(0,-1)).toEqual(terminal.cgroup.split('/').slice(0,-1));
      const descendant = await fs.readFile(`/proc/${terminal.descendant}/stat`,'utf8').catch(()=>null);
      expect(descendant === null || descendant.split(') ')[1]?.startsWith('Z')).toBe(true);
      // ACPX 0.12 creates an initial provider during ensureSession and another
      // during startTurn. Prove each observed identity, rather than root count.
      expect(test.evidence.map(event=>event.unit)).toEqual(expect.arrayContaining([
        identity.cgroup.trim().split('/').at(-1),terminal.cgroup.trim().split('/').at(-1),
      ]));
      for(const event of test.evidence) {
        const {stdout}=await ctl('systemctl',['--user','show',event.unit,'--property=ActiveState','--value']);
        expect(['inactive','failed']).toContain(stdout.trim());
      }
      await fs.writeFile(path.join(test.resources.scratchDir,'legacy-acpx-measurements.json'),JSON.stringify({provider:{pid:identity.pid,cgroup:identity.cgroup},terminal:{pid:terminal.pid,cgroup:terminal.cgroup,descendant:terminal.descendant},evidence:test.evidence},null,2));
      expect(test.resources.admission.snapshot).toEqual({active:0,usedBytes:0,queued:0});
    } finally { await test.close(); }
  }, 30_000);
  it('completes immediate terminal commands and actual shell-string fallback', async()=>{
    const test=await setup();
    try {
      for(const kind of ['true','true','true','shell']) {
        const identityFile=path.join(test.root,'short-identity.json');
        const outcome=await withExecutionResourceContext(test.resources,()=>run(test.root,{RESOURCE_FIXTURE_TERMINAL:kind,RESOURCE_IDENTITY_FILE:identityFile}));
        expect(outcome.result.exitCode,JSON.stringify(outcome)).toBe(0);
        const identity=JSON.parse(await fs.readFile(identityFile,'utf8'));
        expect(identity.terminalOutput).toBe(kind === 'shell' ? 'shell-fallback-proof' : '');
        expect(test.resources.admission.snapshot.active).toBe(0);
      }
    } finally { await test.close(); }
  },30_000);
  it('settles terminal waiters when verified cleanup rejects',async()=>{
    const test=await setup();
    try {
      const outcome=await withExecutionResourceContext(test.resources,()=>run(test.root,{RESOURCE_FIXTURE_TERMINAL:'true'},undefined,true));
      expect(outcome.result.exitCode).not.toBe(0);
      expect(test.resources.admission.snapshot.active).toBe(0);
    } finally { await test.close(); }
  },20_000);
  it('contains provider OOM and permits a later real session', async () => {
    const test = await setup();
    try {
      const failed = await withExecutionResourceContext(test.resources, () => run(test.root,{RESOURCE_FIXTURE_OOM:'1'}));
      expect(failed.result.exitCode).not.toBe(0);
      expect(test.evidence.some(event => event.resourceLimitReached)).toBe(true);
      const recovered = await withExecutionResourceContext(test.resources, () => run(test.root));
      expect(recovered.result.exitCode,JSON.stringify(recovered)).toBe(0);
      expect(test.resources.admission.snapshot.active).toBe(0);
    } finally { await test.close(); }
  }, 30_000);
  it('cancels the whole provider cgroup and its detached descendant', async () => {
    const test=await setup(); const abort=new AbortController();
    const identityFile=path.join(test.root,'cancel-identity.json');
    let execution: ReturnType<typeof run> | undefined;
    try {
      execution=withExecutionResourceContext({...test.resources,signal:abort.signal},()=>run(test.root,{RESOURCE_FIXTURE_HANG:'1',RESOURCE_IDENTITY_FILE:identityFile}));
      await expect.poll(()=>fs.access(identityFile).then(()=>true,()=>false),{timeout:5000}).toBe(true);
      const identity=JSON.parse(await fs.readFile(identityFile,'utf8'));
      abort.abort();
      expect((await execution).result.exitCode).not.toBe(0);
      for(const pid of [identity.pid,identity.descendant]) {
        const stat=await fs.readFile(`/proc/${pid}/stat`,'utf8').catch(()=>null);
        expect(stat === null || stat.split(') ')[1]?.startsWith('Z')).toBe(true);
      }
      expect(test.resources.admission.snapshot.active).toBe(0);
      expect(test.evidence.some(event=>event.cancelled)).toBe(true);
    } finally { abort.abort(); await execution?.catch(()=>{}); await test.close(); }
  }, 20_000);
  it('keeps shell fallback error identity and releases an unused envelope', async () => {
    const test=await setup();
    try { await withExecutionResourceContext(test.resources,async()=>{
      const owner=(await prepareAcpxRuntimeResources({runId:randomUUID(),cwd:process.cwd()}))!;
      try { await expect(owner.spawnProcess('echo hello',[],{cwd:process.cwd(),env:process.env,stdio:['pipe','pipe','pipe']})).rejects.toMatchObject({code:'ENOENT'}); }
      finally { await owner.close(); }
    }); expect(test.resources.admission.snapshot.active).toBe(0); } finally { await test.close(); }
  });
});
