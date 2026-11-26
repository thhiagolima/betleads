// "Fez o 2º/3º depósito" — SQL regression tests for
// supabase/migrations/20261231102300_segundo_terceiro_deposito.sql
//
// Runs the migration inside an in-memory Postgres (PGlite) on a minimal schema
// with only the columns record_financial_webhook_event touches.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const MIGRATION = readFileSync(
  resolve(root, "supabase/migrations/20261231102300_segundo_terceiro_deposito.sql"),
  "utf8",
);

const SCHEMA = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create table public.players (
  id uuid primary key, tenant_id uuid not null,
  total_depositado numeric not null default 0, total_sacado numeric not null default 0,
  ultimo_deposito timestamptz, ultimo_saque timestamptz, ftd_em timestamptz,
  updated_at timestamptz);
create table public.deposits (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, player_id uuid,
  valor numeric not null, status text not null, metodo text, external_id text,
  provider_status text, event_id text, raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), completed_at timestamptz,
  updated_at timestamptz not null default now());
create table public.withdrawals (like public.deposits including defaults);
`;

const T = "00000000-0000-4000-8000-000000000001";
const P = "00000000-0000-4000-8000-0000000000f1";

let db: PGlite;

async function player() {
  const { rows } = await db.query<{
    ftd_em: Date | null;
    segundo_deposito_em: Date | null;
    terceiro_deposito_em: Date | null;
  }>(`select ftd_em, segundo_deposito_em, terceiro_deposito_em from players where id = $1`, [P]);
  return rows[0];
}

/** PIX generated at `at`, approved `paidAfterMin` minutes later. */
async function deposit(id: string, at: string, paidAfterMin = 5) {
  await db.query(
    `select * from record_financial_webhook_event($1,$2,'deposit',$3,null,10,'pendente',null,'pix',$4::timestamptz,'{}')`,
    [T, P, id, at],
  );
  await db.query(
    `select * from record_financial_webhook_event($1,$2,'deposit',$3,null,10,'aprovado',null,'pix',$4::timestamptz + make_interval(mins => $5),'{}')`,
    [T, P, id, at, paidAfterMin],
  );
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  // Applied twice: the migration must be idempotent.
  await db.exec(`begin; ${MIGRATION}; commit;`);
  await db.exec(`begin; ${MIGRATION}; commit;`);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec(`truncate deposits, withdrawals, players;`);
  await db.query(`insert into players (id, tenant_id) values ($1, $2)`, [P, T]);
});

describe("record_financial_webhook_event", () => {
  it("stamps the 2nd and 3rd approved deposits", async () => {
    await deposit("d1", "2026-11-20T10:00:00Z");
    expect((await player()).segundo_deposito_em).toBeNull();
    await deposit("d2", "2026-11-21T10:00:00Z");
    expect((await player()).segundo_deposito_em?.toISOString()).toBe("2026-11-21T10:05:00.000Z");
    await deposit("d3", "2026-11-22T10:00:00Z");
    const p = await player();
    expect(p.segundo_deposito_em?.toISOString()).toBe("2026-11-21T10:05:00.000Z");
    expect(p.terceiro_deposito_em?.toISOString()).toBe("2026-11-22T10:05:00.000Z");
    await deposit("d4", "2026-11-23T10:00:00Z");
    expect((await player()).terceiro_deposito_em?.toISOString()).toBe("2026-11-22T10:05:00.000Z");
  });

  it("a repeated approval of the same deposit does not count twice", async () => {
    await deposit("d1", "2026-11-20T10:00:00Z");
    await deposit("d1", "2026-11-20T10:00:00Z");
    expect((await player()).segundo_deposito_em).toBeNull();
  });

  it("an FTD paid up to an hour after the PIX still counts the ledger as complete", async () => {
    await deposit("d1", "2026-11-20T10:00:00Z", 55);
    await deposit("d2", "2026-11-21T10:00:00Z");
    expect((await player()).segundo_deposito_em).not.toBeNull();
  });

  it("does not stamp players whose first deposit predates the ledger", async () => {
    await db.query(`update players set ftd_em = '2026-05-01T00:00:00Z' where id = $1`, [P]);
    await deposit("d1", "2026-11-20T10:00:00Z");
    await deposit("d2", "2026-11-21T10:00:00Z");
    expect((await player()).segundo_deposito_em).toBeNull();
  });
});

describe("history backfill", () => {
  it("fills from the ledger with the same rule", async () => {
    await db.exec(`
      insert into deposits (tenant_id, player_id, valor, status, created_at, completed_at) values
        ('${T}', '${P}', 10, 'aprovado', '2026-11-20T10:00:00Z', '2026-11-20T10:05:00Z'),
        ('${T}', '${P}', 10, 'aprovado', '2026-11-21T10:00:00Z', '2026-11-21T10:05:00Z'),
        ('${T}', '${P}', 10, 'falhou', '2026-11-21T11:00:00Z', null),
        ('${T}', '${P}', 10, 'aprovado', '2026-11-22T10:00:00Z', '2026-11-22T10:05:00Z');
      update players set ftd_em = '2026-11-20T10:05:00Z';
    `);
    await db.exec(`begin; ${MIGRATION}; commit;`);
    const p = await player();
    expect(p.segundo_deposito_em?.toISOString()).toBe("2026-11-21T10:05:00.000Z");
    expect(p.terceiro_deposito_em?.toISOString()).toBe("2026-11-22T10:05:00.000Z");
  });

  it("skips players with history from before the integration", async () => {
    await db.exec(`
      insert into deposits (tenant_id, player_id, valor, status, created_at, completed_at) values
        ('${T}', '${P}', 10, 'aprovado', '2026-11-20T10:00:00Z', '2026-11-20T10:05:00Z'),
        ('${T}', '${P}', 10, 'aprovado', '2026-11-21T10:00:00Z', '2026-11-21T10:05:00Z');
      update players set ftd_em = '2026-05-01T00:00:00Z';
    `);
    await db.exec(`begin; ${MIGRATION}; commit;`);
    expect((await player()).segundo_deposito_em).toBeNull();
  });
});
