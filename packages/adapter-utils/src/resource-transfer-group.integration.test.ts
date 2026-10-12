import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { withExecutionResourceContext } from "./execution-resource-context.js";
import { resolveExecutionResourcePolicy, ExecutionResourceAdmission } from "./execution-resource-policy.js";
import { ensureSystemdExecutionSlice } from "./systemd-execution-slice.js";
import { withResourceTransferGroup } from "./resource-transfer-group.js";
import { syncDirectoryToSsh, syncDirectoryFromSsh } from "./ssh.js";
import type { ExecutionResourceEvidence } from "./systemd-execution.js";
const ctl=promisify(execFile);
const enabled=process.platform==='linux'&&process.env.PAPERCLIP_TEST_SYSTEMD==='1';
async function setup(){
  const scratchDir=process.env.PAPERCLIP_SCRATCH_DIR!;
  const policy=resolveExecutionResourcePolicy({PAPERCLIP_EXECUTION_MEMORY_MAX_MIB:'128',PAPERCLIP_EXECUTION_MEMORY_HIGH_MIB:'128'},'linux',8*1024**3);
  const slice=await ensureSystemdExecutionSlice({...policy,capacityBytes:policy.memoryMaxBytes},`paperclip-transfer${randomUUID().replaceAll('-','')}.slice`);
  const evidence:ExecutionResourceEvidence[]=[];
  const root=await fs.mkdtemp(path.join(scratchDir,'transfer-'));
  return {root,resources:{runId:randomUUID(),scratchDir,policy,slice,admission:new ExecutionResourceAdmission(policy.memoryMaxBytes,1),nativeLoaderCommand:()=>process.env.PAPERCLIP_TEST_RESOURCE_LOADER!,onEvidence:async(event:ExecutionResourceEvidence)=>{evidence.push(event);}},evidence,
    async close(){await fs.writeFile(path.join(scratchDir,path.basename(root)+'-evidence.json'),JSON.stringify({memoryMaxBytes:policy.memoryMaxBytes,evidence},null,2));await ctl('systemctl',['--user','stop',slice]);await ctl('systemctl',['--user','revert',slice]);await fs.rm(root,{recursive:true,force:true});}};
}
(enabled?describe:describe.skip)('resource transfer groups',()=>{
  it('includes queued admission in the deadline without launching a root', async () => {
    const test = await setup();
    const release = await test.resources.admission.acquire(test.resources.policy.memoryMaxBytes);
    try {
      await expect(withExecutionResourceContext(test.resources, () => withResourceTransferGroup(async spawn => {
        await spawn('/bin/true', [], { stdio: ['ignore', 'ignore', 'ignore'] });
      }, 200))).rejects.toThrow();
      expect(test.evidence).toEqual([]);
      expect(test.resources.admission.snapshot.active).toBe(1);
    } finally { release(); await test.close(); }
  });
  it('cleans the first root when its partner cannot launch', async () => {
    const test = await setup();
    let pid: number | undefined;
    try {
      await expect(withExecutionResourceContext(test.resources, () => withResourceTransferGroup(async spawn => {
        const first = await spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
          { stdio: ['ignore', 'ignore', 'ignore'] });
        pid = first.pid;
        const second = await spawn('/paperclip-missing-transfer-partner', [], { stdio: ['ignore', 'ignore', 'ignore'] });
        await new Promise<void>((resolve, reject) => {
          second.on('error', reject).on('close', code => {
            if (code === 0) resolve(); else reject(new Error(`partner exit ${code}`));
          });
        });
      }))).rejects.toThrow();
      expect(pid).toBeDefined();
      const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null);
      expect(stat === null || stat.split(') ')[1]?.startsWith('Z')).toBe(true);
      expect(test.resources.admission.snapshot.active).toBe(0);
    } finally { await test.close(); }
  }, 20_000);
  it('reports a shared memory limit and admits a later immediate command', async () => {
    const test = await setup();
    try {
      await expect(withExecutionResourceContext(test.resources, () => withResourceTransferGroup(async spawn => {
        const child = await spawn(process.execPath, ['-e',
          "const held=[];setInterval(()=>held.push(Buffer.alloc(16*1024*1024,1)),10)"],
          { stdio: ['ignore', 'ignore', 'ignore'] });
        await new Promise<void>((resolve, reject) => {
          child.on('error', reject).on('close', () => resolve());
        });
      }, 10_000))).rejects.toMatchObject({ code: 'execution_resource_limit' });
      expect(test.resources.admission.snapshot.active).toBe(0);
      await withExecutionResourceContext(test.resources, () => withResourceTransferGroup(async spawn => {
        const child = await spawn('/bin/true', [], { stdio: ['ignore', 'ignore', 'ignore'] });
        // Completion must remain observable after the short command has exited.
        await new Promise(resolve => setTimeout(resolve, 50));
        await new Promise<void>((resolve, reject) => {
          child.on('error', reject).on('close', code => {
            if (code === 0) resolve(); else reject(new Error(`exit ${code}`));
          });
        });
      }));
      expect(test.resources.admission.snapshot.active).toBe(0);
    } finally { await test.close(); }
  }, 20_000);
  it('streams partners under one slot and settles short exits after drain and cleanup',async()=>{
    const test=await setup();
    try{await withExecutionResourceContext(test.resources,()=>withResourceTransferGroup(async spawn=>{
      const producer=await spawn(process.execPath,['-e',"process.stdout.write('x'.repeat(256*1024))"],{stdio:['ignore','pipe','pipe']});
      const consumer=await spawn(process.execPath,['-e',"let bytes=0;process.stdin.on('data',x=>bytes+=x.length);process.stdin.on('end',()=>console.log(bytes))"],{stdio:['pipe','pipe','pipe']});
      expect(test.resources.admission.snapshot.active).toBe(1);
      let output='';producer.stderr!.resume();consumer.stderr!.resume();consumer.stdout!.on('data',chunk=>output+=chunk.toString());
      await new Promise<void>((resolve,reject)=>{let exits=0;const done=(code:number|null)=>{if(code!==0)reject(new Error('partner failed'));else if(++exits===2)resolve();};producer.on('error',reject);consumer.on('error',reject);producer.on('close',done);consumer.on('close',done);consumer.stdin!.on('error',reject);producer.stdout!.pipe(consumer.stdin!);});
      expect(output).toBe('262144\n');
    }));expect(test.evidence).toHaveLength(2);expect(test.resources.admission.snapshot.active).toBe(0);
      const groups=await Promise.all(test.evidence.map(e=>ctl('systemctl',['--user','show',e.unit,'--property=ActiveState','--value'])));expect(groups.every(g=>['inactive','failed'].includes(g.stdout.trim()))).toBe(true);
    }finally{await test.close();}
  },20000);
  it('cancels resistant partners and detached descendants at the group deadline',async()=>{
    const test=await setup();const ids=path.join(test.root,'pids.json');
    try{await expect(withExecutionResourceContext(test.resources,()=>withResourceTransferGroup(async spawn=>{
      const child=await spawn(process.execPath,['-e',`const fs=require('fs');const desc=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(ids)},JSON.stringify([process.pid,desc.pid]));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`],{stdio:['ignore','pipe','pipe']});child.stdout!.resume();child.stderr!.resume();await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
    },1200))).rejects.toThrow();const pids=JSON.parse(await fs.readFile(ids,'utf8'));for(const pid of pids){const stat=await fs.readFile(`/proc/${pid}/stat`,'utf8').catch(()=>null);expect(stat===null||stat.split(') ')[1]?.startsWith('Z')).toBe(true);}expect(test.resources.admission.snapshot.active).toBe(0);
    }finally{await test.close();}
  },20000);
  it('round trips real tar streams through SSH call sites under one reservation',async()=>{
    const test=await setup();const original=process.env.PATH;
    try{
      const bin=path.join(test.root,'bin');const source=path.join(test.root,'source');const remote=path.join(test.root,'remote');const restored=path.join(test.root,'restored');await fs.mkdir(bin);await fs.mkdir(source);await fs.mkdir(restored);await fs.writeFile(path.join(source,'payload.txt'),'round trip\n');
      const identity=path.join(test.root,'identity.jsonl');
      await fs.writeFile(path.join(bin,'ssh'),`#!${process.execPath}\nconst fs=require('fs');fs.appendFileSync(${JSON.stringify(identity)},JSON.stringify({pid:process.pid,cgroup:fs.readFileSync('/proc/self/cgroup','utf8')})+'\\n');const child=require('child_process').spawn('/bin/sh',['-c',process.argv.at(-1)],{stdio:'inherit'});child.on('exit',(code)=>process.exit(code??1));`,{mode:0o700});process.env.PATH=bin+':'+original;
      const spec={host:'fixture.invalid',port:2222,username:'test',remoteWorkspacePath:remote,remoteCwd:remote,privateKey:null,knownHosts:null,strictHostKeyChecking:true};
      await withExecutionResourceContext(test.resources,async()=>{await syncDirectoryToSsh({spec,localDir:source,remoteDir:remote});await syncDirectoryFromSsh({spec,remoteDir:remote,localDir:restored});});
      expect(await fs.readFile(path.join(restored,'payload.txt'),'utf8')).toBe('round trip\n');const observed=(await fs.readFile(identity,'utf8')).trim().split('\n').map(line=>JSON.parse(line));expect(observed).toHaveLength(2);expect(observed.every(x=>x.cgroup.includes('.scope')&&!x.cgroup.includes('paperclipai.service'))).toBe(true);expect(test.resources.admission.snapshot.active).toBe(0);
    }finally{process.env.PATH=original;await test.close();}
  },30000);
});
