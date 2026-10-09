import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { recoverExecutionUnit } from "./recovered-execution-unit.js";
const exec = promisify(execFile);
const enabled = process.platform === "linux" && process.env.PAPERCLIP_TEST_SYSTEMD === "1";
(enabled ? it : it.skip)("recovers a real owned cgroup and removes detached descendants after controller/leader loss", async () => {
  const runId = randomUUID();
  const unit = `paperclip-execution-${runId}-recovery.service`;
  const file = path.join(process.env.PAPERCLIP_SCRATCH_DIR!, `${runId}.json`);
  const systemctl = async (args: string[]) => (await exec("systemctl", ["--user", ...args], { timeout: 15_000 })).stdout;
  const wait = async (test: () => Promise<boolean>) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await test()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("fixture deadline exceeded");
  };
  const alive = async (pid: number) => {
    try { return !(await fs.readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1]?.startsWith("Z"); }
    catch { return false; }
  };
  try {
    await exec("systemd-run", ["--user", `--unit=${unit}`, "--collect", "--property=Type=exec",
      "--property=ExitType=cgroup", "--property=MemoryMax=96M", "--property=MemorySwapMax=0",
      "--property=TasksMax=16", "--property=RuntimeMaxSec=30", "--property=KillMode=control-group",
      process.execPath, "-e", `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});c.unref();require('fs').writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,child:c.pid}));setInterval(()=>{},1000)`, file], { timeout: 5000 });
    await wait(async () => { try { await fs.stat(file); return true; } catch { return false; } });
    const ids = JSON.parse(await fs.readFile(file, "utf8")) as { pid: number; child: number };
    const startTime = (stat: string) => stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19];
    const fingerprint = startTime(await fs.readFile(`/proc/${ids.pid}/stat`, "utf8"));
    const group = await fs.readFile(`/proc/${ids.pid}/cgroup`, "utf8");
    const recovered = await recoverExecutionUnit(runId, [{ unit, memoryMaxBytes: 96 * 1024 * 1024 }], {
      isAlive: async () => { try { return startTime(await fs.readFile(`/proc/${ids.pid}/stat`, "utf8")) === fingerprint; } catch { return false; } },
      readCgroup: () => fs.readFile(`/proc/${ids.pid}/cgroup`, "utf8"), systemctl,
    });
    expect(group).toContain(unit);
    expect(group).not.toContain("paperclipai.service");
    process.kill(ids.pid, "SIGKILL");
    await wait(async () => !await alive(ids.pid));
    expect(await alive(ids.child)).toBe(true);
    await recovered!.cleanup();
    await wait(async () => !await alive(ids.child));
    await fs.writeFile(path.join(process.env.PAPERCLIP_SCRATCH_DIR!, "recovered-unit-evidence.json"), JSON.stringify({ ...ids, unit, group, detachedDescendantStopped: true }));
  } finally {
    await systemctl(["stop", unit]).catch(() => {});
    await fs.rm(file, { force: true });
  }
}, 20_000);
