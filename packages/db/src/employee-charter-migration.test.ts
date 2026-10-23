import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

// All surrounding tables use the real migrations. Only the two changed pieces
// are restored to their shipped 0301 shape before applying the forward SQL.
describe("0301 to 0302 employee charter cleanup", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let sql: ReturnType<typeof postgres>;
  let migration: string;
  let companyId: string, agentId: string;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("charter-migration-");
    sql = postgres(temporary.connectionString, { max: 1 });
    migration = await readFile(new URL("./migrations/0302_employee_charter_cleanup.sql", import.meta.url), "utf8");
  }, 90000);
  afterAll(async () => { await sql?.end(); await temporary?.cleanup(); }, 30000);
  beforeEach(async () => {
    await sql`drop table if exists employee_organization_settings`;
    await sql`drop table if exists employee_contracts`;
    await sql`create table employee_contracts (
      id uuid primary key default gen_random_uuid(), company_id uuid not null references companies(id) on delete cascade,
      agent_id uuid not null, version integer not null, contract jsonb not null, actor_id text not null,
      run_id uuid, created_at timestamptz not null default now(),
      foreign key(company_id,agent_id) references agents(company_id,id) on delete cascade)`;
    await sql`create unique index employee_contract_version_uq on employee_contracts(company_id,agent_id,version)`;
    await sql`alter table organization_context_packs add column if not exists contract_version integer`;
    companyId = randomUUID(); agentId = randomUUID();
    await sql`insert into companies(id,name,issue_prefix) values(${companyId},'Migration fixture',${companyId.slice(0,6)})`;
    await sql`insert into agents(id,company_id,name) values(${agentId},${companyId},'Employee')`;
  });
  const migrate = () => sql.begin(async tx => { for (const statement of migration.split('--> statement-breakpoint')) if (statement.trim()) await tx.unsafe(statement); });
  it("copies latest machine configuration exactly and removes only obsolete schema", async () => {
    const config = { policy: { defaultMode: "allowed", permissions: { "knowledge.write": "denied" } },
      capabilities: ["research"], servicesProvided: ["research"], servicesConsumed: ["review"],
      serviceExposures: [{ capability: "research", scope: "company" }],
      eventSubscriptions: ["receipt.received", "review.scheduled", "custom.signal"], scheduledReviewMinutes: 73 };
    // Historical prose already moved to AGENTS.md; the current old row contains
    // empty semantic fields. It must not prevent preserving the machine config.
    await sql`insert into employee_contracts(company_id,agent_id,version,contract,actor_id) values
      (${companyId},${agentId},1,${sql.json({ ...config, purpose: "Old prose" })},'board'),
      (${companyId},${agentId},2,${sql.json({ ...config, purpose: "", responsibilities: [] })},'board')`;
    const legacyPack = { version: 2, contract: { version: 1, purpose: "Historical role" }, goals: [{ title: "Historical goal" }] };
    const packId = randomUUID();
    await sql`insert into organization_context_packs(id,company_id,agent_id,run_id,pack,event_ids,contract_version)
      values(${packId},${companyId},${agentId},${randomUUID()},${sql.json(legacyPack)},'[]'::jsonb,1)`;
    await migrate();
    expect((await sql`select pack from organization_context_packs where id=${packId}`)[0].pack).toEqual(legacyPack);
    const [saved] = await sql`select * from employee_organization_settings where company_id=${companyId} and agent_id=${agentId}`;
    expect(saved.config).toEqual(config); expect(saved.version).toBe(2);
    expect((await sql`select to_regclass('employee_contracts') as old`)[0].old).toBeNull();
    expect(await sql`select 1 from information_schema.columns where table_name='organization_context_packs' and column_name='contract_version'`).toHaveLength(0);
    for (const table of ['agents','goals','missions','mission_workstreams','organization_receipts','context_events','organization_context_packs','knowledge_entities','agent_instruction_revisions'])
      expect((await sql`select to_regclass(${table}) as existing`)[0].existing).not.toBeNull();
  });
  it("fails atomically instead of discarding an unmigrated live role charter", async () => {
    await sql`insert into employee_contracts(company_id,agent_id,version,contract,actor_id) values (${companyId},${agentId},1,${sql.json({ purpose: "Preserve this role", capabilities: ["research"] })},'board')`;
    await expect(migrate()).rejects.toThrow("Move employee Contract prose to AGENTS.md");
    expect((await sql`select contract->>'purpose' as purpose from employee_contracts where agent_id=${agentId}`)[0].purpose).toBe("Preserve this role");
    expect((await sql`select to_regclass('employee_organization_settings') as settings`)[0].settings).toBeNull();
  });
});
