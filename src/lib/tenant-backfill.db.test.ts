// F0-04 — SQL test for
// supabase/migrations/20261017100000_backfill_service_role_tenant_ids.sql:
// rows misfiled under the main tenant are re-homed to their parent's tenant.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  resolve(
    __dirname,
    "../..",
    "supabase/migrations/20261017100000_backfill_service_role_tenant_ids.sql",
  ),
  "utf8",
);

const MAIN = "00000000-0000-0000-0000-000000000001";
const B = "00000000-0000-4000-8000-00000000000b";

const SCHEMA = `
create table public.players (id text primary key, tenant_id uuid);
create table public.flows (id text primary key, tenant_id uuid);
create table public.email_flows (id text primary key, tenant_id uuid);
create table public.call_flows (id text primary key, tenant_id uuid);
create table public.whatsapp_sessions (id text primary key, tenant_id uuid);
create table public.flow_leads (id text primary key, tenant_id uuid, flow_id text);
create table public.flow_logs (id text primary key, tenant_id uuid, flow_id text, player_id text);
create table public.lead_alerts (id text primary key, tenant_id uuid, player_id text);
create table public.email_flow_logs (id text primary key, tenant_id uuid, flow_id text);
create table public.call_flow_progress (id text primary key, tenant_id uuid, flow_id text);
create table public.call_flow_history (id text primary key, tenant_id uuid, flow_id text);
create table public.lead_whatsapp_assignments (id text primary key, tenant_id uuid, session_id text);
`;

let db: PGlite;

async function tenantOf(table: string, id: string) {
  const { rows } = await db.query<{ tenant_id: string }>(
    `select tenant_id from public.${table} where id = $1`,
    [id],
  );
  return rows[0]?.tenant_id;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(`
    insert into players values ('p-b', '${B}'), ('p-main', '${MAIN}');
    insert into flows values ('f-b', '${B}');
    insert into email_flows values ('ef-b', '${B}');
    insert into call_flows values ('cf-b', '${B}');
    insert into whatsapp_sessions values ('s-b', '${B}');
    insert into flow_leads values ('fl', '${MAIN}', 'f-b');
    insert into flow_logs values ('lg1', '${MAIN}', 'f-b', 'p-b'), ('lg2', '${MAIN}', null, 'p-b'),
      ('lg3', '${MAIN}', null, 'p-main');
    insert into lead_alerts values ('la', '${MAIN}', 'p-b');
    insert into email_flow_logs values ('el', '${MAIN}', 'ef-b');
    insert into call_flow_progress values ('cp', '${MAIN}', 'cf-b');
    insert into call_flow_history values ('ch', '${MAIN}', 'cf-b');
    insert into lead_whatsapp_assignments values ('wa', '${MAIN}', 's-b');
  `);
  await db.exec(MIGRATION);
  // Idempotent: a second run changes nothing and does not fail.
  await db.exec(MIGRATION);
});

afterAll(async () => {
  await db.close();
});

describe("backfill_service_role_tenant_ids", () => {
  it.each([
    ["flow_leads", "fl"],
    ["flow_logs", "lg1"],
    ["flow_logs", "lg2"],
    ["lead_alerts", "la"],
    ["email_flow_logs", "el"],
    ["call_flow_progress", "cp"],
    ["call_flow_history", "ch"],
    ["lead_whatsapp_assignments", "wa"],
  ])("re-homes %s %s to the owner tenant", async (table, id) => {
    expect(await tenantOf(table, id)).toBe(B);
  });

  it("leaves rows that already belong to the main tenant alone", async () => {
    expect(await tenantOf("flow_logs", "lg3")).toBe(MAIN);
  });
});
