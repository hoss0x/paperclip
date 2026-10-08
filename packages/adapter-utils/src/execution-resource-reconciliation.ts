import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExecutionResourceAdmission } from "./execution-resource-policy.js";

const execFileAsync = promisify(execFile);
export interface ExistingExecutionUnit { unit: string; memoryMaxBytes: number; admissionKind?: "agent" | "helper" }

/** User-manager state is authoritative; PID reuse and local process maps are not. */
export async function listActiveExecutionUnits(slice: string): Promise<ExistingExecutionUnit[]> {
  const { stdout } = await execFileAsync("systemctl", ["--user", "list-units", "--all", "--type=service,scope",
    "--plain", "--no-legend", "--no-pager", "paperclip-execution-*.service", "paperclip-execution-*.scope"], { timeout: 5_000, maxBuffer: 1024 * 1024 });
  const units = stdout.trim().split("\n").map(line => line.trim().split(/\s+/)[0]!)
    .filter(unit => /^paperclip-execution-[a-zA-Z0-9-]+\.(?:service|scope)$/.test(unit));
  if (!units.length) return [];
  const { stdout: properties } = await execFileAsync("systemctl", ["--user", "show", ...units,
    "--property=Id,Slice,ActiveState,MemoryMax"], { timeout: 5_000, maxBuffer: 1024 * 1024 });
  const groups = new Map<string, ExistingExecutionUnit>();
  const envelopes = new Set<string>();
  for (const block of properties.trim().split(/\n\n/)) {
    const values = Object.fromEntries(block.split("\n").map(line => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    if (["inactive", "failed"].includes(values.ActiveState ?? "")) continue;
    const nestedPrefix = `${slice.slice(0, -6)}-run`;
    const nested = values.Slice?.startsWith(nestedPrefix)
      && /^[a-f0-9]{32}(?:helper)?\.slice$/.test(values.Slice.slice(nestedPrefix.length));
    if (values.Slice !== slice && !nested) continue;
    if (!values.Id || !units.includes(values.Id) || !values.ActiveState) throw new Error("Incomplete execution unit state");
    if (nested) { envelopes.add(values.Slice!); continue; }
    const memoryMaxBytes = Number(values.MemoryMax);
    if (!Number.isSafeInteger(memoryMaxBytes) || memoryMaxBytes < 1) throw new Error("Surviving execution unit has no bounded memory budget");
    groups.set(values.Id, { unit: values.Id, memoryMaxBytes,
      ...(/-helper\.(?:service|scope)$/.test(values.Id) ? { admissionKind: "helper" as const } : {}) });
  }
  if (envelopes.size) {
    const { stdout: budgets } = await execFileAsync("systemctl", ["--user", "show", ...envelopes,
      "--property=Id,MemoryMax"], { timeout: 5_000, maxBuffer: 1024 * 1024 });
    for (const block of budgets.trim().split(/\n\n/)) {
      const values = Object.fromEntries(block.split("\n").map(line => line.split("=")));
      const memoryMaxBytes = Number(values.MemoryMax);
      if (!values.Id || !envelopes.has(values.Id) || !Number.isSafeInteger(memoryMaxBytes) || memoryMaxBytes < 1) {
        throw new Error("Surviving execution run envelope has no bounded memory budget");
      }
      groups.set(values.Id, { unit: values.Id, memoryMaxBytes,
        ...(values.Id.endsWith("helper.slice") ? { admissionKind: "helper" as const } : {}) });
    }
    if ([...envelopes].some(unit => !groups.has(unit))) throw new Error("Incomplete execution run envelope accounting");
  }
  return [...groups.values()];
}

/** Reserve survivors once, then release only when the OS confirms they stopped.
 * New launches use their ordinary reservations and are not counted twice.
 * A failed refresh keeps all reservations; it never admits extra work.
 */
export async function reconcileExecutionAdmission(input: {
  admission: ExecutionResourceAdmission;
  list: () => Promise<ExistingExecutionUnit[]>;
  intervalMs?: number;
}): Promise<void> {
  const releases = new Map<string, () => void>();
  const existing = await input.list();
  for (const unit of existing) {
    if (releases.has(unit.unit)) throw new Error("Duplicate surviving execution unit");
    releases.set(unit.unit, input.admission.adopt(unit.memoryMaxBytes, unit.admissionKind));
  }
  if (!releases.size) return;
  let refreshing = false;
  const timer = setInterval(() => {
    if (refreshing) return;
    refreshing = true;
    void input.list().then(active => {
      const names = new Set(active.map(unit => unit.unit));
      for (const [unit, release] of releases) {
        if (names.has(unit)) continue;
        releases.delete(unit);
        release();
      }
      if (!releases.size) clearInterval(timer);
    }).catch(() => { /* Retain capacity on an unavailable user manager. */ })
      .finally(() => { refreshing = false; });
  }, input.intervalMs ?? 1_000);
  timer.unref();
}
