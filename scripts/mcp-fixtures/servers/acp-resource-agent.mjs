#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
const pending = new Map();
let nextId = 1000;
const write = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
function call(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); write({ id, method, params }); });
}
async function request(message) {
  if (message.method === 'initialize') return { protocolVersion: 1, agentCapabilities: { loadSession: false, sessionCapabilities: { close: {} } } };
  if (message.method === 'session/new') return { sessionId: 'resource-session' };
  if (message.method === 'session/close') return {};
  if (message.method === 'session/cancel') return null;
  if (message.method !== 'session/prompt') throw new Error('Unsupported fixture request');
  const sessionId = message.params.sessionId;
  let terminalOutput;
  if (process.env.RESOURCE_FIXTURE_TERMINAL) {
    const command = process.env.RESOURCE_FIXTURE_TERMINAL === 'true' ? {command:'/bin/true',args:[]}
      : process.env.RESOURCE_FIXTURE_TERMINAL === 'shell' ? {command:'printf shell-fallback-proof'}
      : {command:process.execPath,args:['-e', `
      const fs=require('node:fs');const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',1,2]});
      console.log(JSON.stringify({pid:process.pid,descendant:child.pid,cgroup:fs.readFileSync('/proc/self/cgroup','utf8'),secret:process.env.RESOURCE_TERMINAL_SECRET}));setTimeout(()=>process.exit(0),500);
    `]};
    const { terminalId } = await call('terminal/create', { sessionId, ...command, env: [{ name: 'RESOURCE_TERMINAL_SECRET', value: 'terminal-private-value' }] });
    await call('terminal/wait_for_exit', { sessionId, terminalId });
    terminalOutput = (await call('terminal/output', { sessionId, terminalId })).output;
    await call('terminal/release', { sessionId, terminalId });
  }
  const descendant = process.env.RESOURCE_FIXTURE_HANG === '1' ? spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}).pid : undefined;
  const identity = { descendant, pid: process.pid, cgroup: readFileSync('/proc/self/cgroup','utf8'), secret: process.env.RESOURCE_PROVIDER_SECRET, terminalOutput };
  if (process.env.RESOURCE_IDENTITY_FILE) writeFileSync(process.env.RESOURCE_IDENTITY_FILE, JSON.stringify(identity));
  write({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(identity) } } } });
  if (process.env.RESOURCE_FIXTURE_HANG === '1') await new Promise(()=>{});
  if (process.env.RESOURCE_FIXTURE_OOM === '1') { const buffers=[]; for(let i=0;i<128;i++) buffers.push(Buffer.alloc(4*1024*1024,1)); }
  return { stopReason: 'end_turn' };
}
const lines = createInterface({ input: process.stdin });
lines.on('line', async line => {
  const message=JSON.parse(line);
  if (!message.method) {
    const waiter=pending.get(message.id); pending.delete(message.id);
    if(message.error) waiter?.reject(new Error(message.error.message)); else waiter?.resolve(message.result);
    return;
  }
  try { const result=await request(message); if(message.id !== undefined && result !== null) write({id:message.id,result}); }
  catch(error) { if(message.id !== undefined) write({id:message.id,error:{code:-32603,message:String(error.message)}}); }
});
