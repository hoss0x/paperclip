import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withExecutionResourceContext } from "./execution-resource-context.js";
import { ExecutionResourceAdmission, resolveExecutionResourcePolicy } from "./execution-resource-policy.js";
import { execFileWithResources } from "./resource-buffered-command.js";
import type { ExecutionResourceEvidence } from "./systemd-execution.js";
import { runLocalGit } from "./git-workspace-sync.js";
import { createTarballFromDirectory } from "./sandbox-managed-runtime.js";

import { runSshCommand } from "./ssh.js";

const enabled = process.platform === "linux" && process.env.PAPERCLIP_TEST_SYSTEMD === "1";
function context() {
  const policy = resolveExecutionResourcePolicy({ PAPERCLIP_EXECUTION_MEMORY_MAX_MIB:"96", PAPERCLIP_EXECUTION_MEMORY_HIGH_MIB:"96" },"linux",8*1024**3);
  const evidence: ExecutionResourceEvidence[]=[];
  return {runId:randomUUID(),policy,evidence,scratchDir:process.env.PAPERCLIP_SCRATCH_DIR!,admission:new ExecutionResourceAdmission(policy.memoryMaxBytes,1),
    nativeLoaderCommand:()=>process.env.PAPERCLIP_TEST_RESOURCE_LOADER!,onEvidence:async(event:ExecutionResourceEvidence)=>{evidence.push(event);} };
}
const node=(source:string,options:Parameters<typeof execFileWithResources>[2]={})=>execFileWithResources(process.execPath,["-e",source],options);
(enabled?describe:describe.skip)("buffered resource commands",()=>{
  it("preserves stdin, UTF-8 output, exact environment/arguments and worker identity",async()=>{
    const resources=context();
    const result=await withExecutionResourceContext(resources,()=>execFileWithResources(process.execPath,["-e",`let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>console.log(JSON.stringify({input,secret:process.env.BUFFERED_SECRET,args:process.argv.slice(1),cgroup:require('fs').readFileSync('/proc/self/cgroup','utf8')})))`,"--","$literal ; $(inert)","two words"],{stdin:"雪\nexact input",env:{PATH:process.env.PATH,BUFFERED_SECRET:"private fixture"}}));
    const identity=JSON.parse(result.stdout);
    expect(identity.input).toBe("雪\nexact input");expect(identity.secret).toBe("private fixture");expect(identity.args).toEqual(["$literal ; $(inert)","two words"]);
    expect(identity.cgroup).toContain(".scope");expect(identity.cgroup).not.toContain("paperclipai.service");
    expect(resources.evidence[0].unit).toContain(resources.runId);
    expect(resources.admission.snapshot.active).toBe(0);
  },15000);
  it("preserves missing-executable and nonzero exit diagnostics",async()=>{
    const resources=context();await withExecutionResourceContext(resources,async()=>{
      await expect(execFileWithResources("/missing/resource-command",[])).rejects.toMatchObject({code:"ENOENT"});
      await expect(node("process.stdout.write('partial');process.stderr.write('failure');process.exit(7)")).rejects.toMatchObject({code:7,stdout:"partial",stderr:"failure"});
    });expect(resources.admission.snapshot.active).toBe(0);
  },15000);
  it("bounds output and recovers after an intentional memory kill",async()=>{
    const resources=context();await withExecutionResourceContext(resources,async()=>{
      await expect(node("process.stdout.write('x'.repeat(65536));setInterval(()=>{},1000)",{maxBuffer:1024})).rejects.toMatchObject({code:"ERR_CHILD_PROCESS_STDIO_MAXBUFFER"});
      await expect(node("const chunks=[];setInterval(()=>chunks.push(Buffer.alloc(8*1024*1024,1)),5)")).rejects.toMatchObject({code:"execution_resource_limit"});
      expect((await node("console.log('after failure')")).stdout).toBe("after failure\n");
    });expect(resources.evidence.some(event=>event.resourceLimitReached)).toBe(true);expect(resources.admission.snapshot.active).toBe(0);
  },15000);
  it("times out queued work without launching a unit",async()=>{
    const resources=context();const release=await resources.admission.acquire(resources.policy.memoryMaxBytes);
    try{await withExecutionResourceContext(resources,()=>expect(node("process.exit(0)",{timeout:50})).rejects.toMatchObject({killed:true}));expect(resources.evidence).toEqual([]);expect(resources.admission.snapshot.queued).toBe(0);}finally{release();}
  });
  it("observes controller cancellation without a separate command signal",async()=>{
    const resources=context();const abort=new AbortController();
    const timer=setTimeout(()=>abort.abort(),300);
    try{await withExecutionResourceContext({...resources,signal:abort.signal},()=>expect(node("setInterval(()=>{},1000)")).rejects.toMatchObject({code:"ABORT_ERR",killed:true}));expect(resources.admission.snapshot.active).toBe(0);}finally{clearTimeout(timer);}
  },15000);
  it("cleans a timed-out command and detached descendant before returning",async()=>{
    const resources=context();const identity=path.join(resources.scratchDir,`buffered-pids-${randomUUID()}.json`);
    try{
      await withExecutionResourceContext(resources,()=>expect(node(`const fs=require('fs');const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(identity)},JSON.stringify({pid:process.pid,descendant:child.pid}));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`,{timeout:1000})).rejects.toMatchObject({killed:true}));
      const ids=JSON.parse(await fs.readFile(identity,"utf8"));
      for(const pid of [ids.pid,ids.descendant]){const stat=await fs.readFile(`/proc/${pid}/stat`,"utf8").catch(()=>null);expect(stat===null || stat.split(") ")[1]?.startsWith("Z")).toBe(true);}
      expect(resources.admission.snapshot.active).toBe(0);
    }finally{await fs.rm(identity,{force:true});}
  },15000);
  it("contains Git metadata and tar seed creation through their real call sites",async()=>{
    const resources=context();const root=await fs.mkdtemp(path.join(resources.scratchDir,"buffered-call-sites-"));
    try{await withExecutionResourceContext(resources,async()=>{
      const source=path.join(root,"source");const restored=path.join(root,"restored");await fs.mkdir(source);await fs.mkdir(restored);await fs.writeFile(path.join(source,"payload.txt"),"archive fixture");
      await runLocalGit(source,["init"]);
      expect((await runLocalGit(source,["rev-parse","--is-inside-work-tree"])).stdout).toBe("true\n");
      const archive=path.join(root,"seed.tar");await createTarballFromDirectory({localDir:source,archivePath:archive,exclude:[".git"]});
      await execFileWithResources("tar",["-xf",archive,"-C",restored]);
      expect(await fs.readFile(path.join(restored,"payload.txt"),"utf8")).toBe("archive fixture");
      expect(resources.evidence).toHaveLength(4);expect(resources.evidence.every(event=>event.unit.endsWith(".scope"))).toBe(true);
    });expect(resources.admission.snapshot.active).toBe(0);}finally{await fs.rm(root,{recursive:true,force:true});}
  },20000);
  it("governs SSH command roots and preserves remote command/stdin handoff",async()=>{
    const resources=context();const root=await fs.mkdtemp(path.join(resources.scratchDir,"buffered-ssh-"));const originalPath=process.env.PATH;
    try{
      await fs.writeFile(path.join(root,"ssh"),`#!${process.execPath}\nlet input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>console.log(JSON.stringify({input,args:process.argv.slice(2),cgroup:require('fs').readFileSync('/proc/self/cgroup','utf8')})));`,{mode:0o700});
      process.env.PATH=root+":"+originalPath;
      const result=await withExecutionResourceContext(resources,()=>runSshCommand({host:"fixture.invalid",port:2222,username:"test",remoteWorkspacePath:"/fixture",privateKey:null,knownHosts:null,strictHostKeyChecking:true},"printf 'exact remote command'",{stdin:"exact ssh stdin",env:{FIXTURE_REMOTE:"two words"}}));
      const identity=JSON.parse(result.stdout);expect(identity.input).toBe("exact ssh stdin");expect(identity.args).toContain("test@fixture.invalid");expect(identity.args.at(-1)).toContain("FIXTURE_REMOTE");expect(identity.cgroup).toContain(".scope");expect(identity.cgroup).not.toContain("paperclipai.service");expect(resources.admission.snapshot.active).toBe(0);
    }finally{process.env.PATH=originalPath;await fs.rm(root,{recursive:true,force:true});}
  },15000);

});
