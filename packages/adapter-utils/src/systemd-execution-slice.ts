import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExecutionResourcePolicy } from "./execution-resource-policy.js";

const execFileAsync = promisify(execFile);
export const EXECUTION_SLICE = "paperclip-executions.slice";

/** A persistent OS aggregate cap includes surviving units after a restart. */
export async function ensureSystemdExecutionSlice(policy: ExecutionResourcePolicy, slice = EXECUTION_SLICE): Promise<string> {
  if (!/^paperclip-[a-zA-Z0-9-]+\.slice$/.test(slice)) throw new Error("Invalid execution slice name");
  async function properties() {
    const { stdout } = await execFileAsync("systemctl", ["--user", "show", slice,
      "--property=MemoryMax,MemorySwapMax"], { timeout: 5_000 });
    return Object.fromEntries(stdout.trim().split("\n").map(line => line.split("=")));
  }
  const before = await properties();
  if (before.MemoryMax && before.MemoryMax !== "infinity" && Number(before.MemoryMax) !== policy.capacityBytes) {
    throw new Error("Existing execution slice has a different capacity; reconcile surviving workloads before changing policy");
  }
  // Creating/configuring an empty slice does not move or restart the server.
  await execFileAsync("systemctl", ["--user", "start", slice], { timeout: 5_000 });
  await execFileAsync("systemctl", ["--user", "set-property", "--runtime", slice,
    `MemoryMax=${policy.capacityBytes}`, `MemorySwapMax=${policy.memorySwapMaxBytes}`, "MemoryAccounting=yes"], { timeout: 5_000 });
  const after = await properties();
  if (Number(after.MemoryMax) !== policy.capacityBytes || Number(after.MemorySwapMax) !== policy.memorySwapMaxBytes) {
    throw new Error("Execution slice did not apply its aggregate memory limits");
  }
  return slice;
}
