import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { and, desc, eq } from "drizzle-orm";
import { agentInstructionRevisions, type Db } from "@paperclipai/db";

/** Capture the exact staged entry used by the adapter. The snapshot is audit
 * evidence only; renderOrganizationContext deliberately excludes its bytes. */
export async function captureEmployeeCharter(db: Db, companyId: string, agentId: string, filename: string | null) {
  if (!filename) return { source: "unconfigured", contentHash: null, revisionId: null };
  let bytes: Buffer;
  try { bytes = await readFile(filename); }
  catch (error) {
    // Local adapters already report unavailable external instruction files.
    // Audit capture must not introduce another execution gate or pretend that
    // unavailable bytes governed a run.
    return { source: "instruction_file_unavailable", entryFile: filename.split(/[\\/]/).at(-1), contentHash: null, revisionId: null,
      errorCode: (error as NodeJS.ErrnoException).code ?? "READ_FAILED" };
  }
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const [revision] = await db.select({ id: agentInstructionRevisions.id, entryFile: agentInstructionRevisions.entryFile })
    .from(agentInstructionRevisions).where(and(eq(agentInstructionRevisions.companyId, companyId),
      eq(agentInstructionRevisions.agentId, agentId), eq(agentInstructionRevisions.contentHash, contentHash)))
    .orderBy(desc(agentInstructionRevisions.createdAt)).limit(1);
  return { source: "instruction_file", entryFile: revision?.entryFile ?? filename.split(/[\\/]/).at(-1),
    contentHash, revisionId: revision?.id ?? null, byteLength: bytes.length,
    contentBase64: bytes.toString("base64") };
}
