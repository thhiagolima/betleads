// Web push (OneSignal) — Task 3: ids de jogadores no público resolvido. SQL
// tests for supabase/migrations/20261210100200_audience_player_ids.sql.
//
// Reaplica o mesmo stub de 20261126100000_expert_campaigns.sql (igual a
// expert-campaigns.db.test.ts) e aplica por cima a migração desta task.
// Cobre: com `includePlayerIds=true` o jsonb devolve os ids dos jogadores
// casados pelo critério; sem a chave, `playerIds` nem existe no resultado
// (o payload do SMS, que nunca manda a flag, não cresce).

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readMigration, resetSession as resetDbSession, SCHEMA, SEED } from "../billing/billing-db-test-support";

const MIGRATIONS = [
  "supabase/migrations/20261022100000_billing_price_book.sql",
  "supabase/migrations/20261022100100_billing_wallet.sql",
  "supabase/migrations/20261024100000_billing_wallet_settle.sql",
];
const EXPERT_MIGRATION = readMigration("supabase/migrations/20261126100000_expert_campaigns.sql");
const AUDIENCE_MIGRATION = readMigration("supabase/migrations/20261210100200_audience_player_ids.sql");

const STUBS = `
create function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create table public.call_history (id uuid primary key default gen_random_uuid());
create table public.email_send_logs (id uuid primary key default gen_random_uuid());
create table public.experts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  nome text not null default 'Expert',
  tipo text not null default 'restrito',
  ativo boolean not null default true,
  envio_modo text not null default 'livre',
  teto_mensal numeric(12,2)
);
create table public.sms_audiences (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  name text not null,
  description text,
  criteria jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);
create table public.sms_campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id),
  status text not null default 'agendada',
  audience_criteria jsonb,
  created_at timestamptz not null default now(),
  constraint sms_campaigns_status_chk
    check (status in ('agendada', 'enviando', 'enviado', 'falhou', 'cancelada'))
);
create table public.email_campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id),
  status text not null default 'rascunho',
  audience_filter jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create table public.call_queue (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id),
  status text not null default 'audio_ready'
);
create table public.campaign_drafts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  audience_id text,
  audience_criteria jsonb,
  status text not null default 'draft',
  updated_at timestamptz not null default now()
);
create table public.players (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  email text,
  telefone text,
  affiliate_id text,
  total_depositado numeric,
  total_sacado numeric,
  ftd_em timestamptz,
  ultimo_deposito timestamptz,
  ultimo_login timestamptz,
  last_cashback_paid_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.gamification_settings (
  tenant_id uuid primary key,
  level_thresholds jsonb,
  cooling_after_days int,
  sleeping_after_days int
);
create table public.deposits (tenant_id uuid, player_id uuid, status text, metodo text);
create table public.withdrawals (tenant_id uuid, player_id uuid, status text);
create table public.journey_dead_leads (tenant_id uuid, player_id uuid, revived_at timestamptz);
grant select, insert, update, delete on public.sms_audiences, public.sms_campaigns,
  public.email_campaigns to authenticated;
`;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(SEED);
  await db.exec(STUBS);
  for (const m of MIGRATIONS) await db.exec(readMigration(m));
  await db.exec(EXPERT_MIGRATION);
  await db.exec(AUDIENCE_MIGRATION);
  await resetDbSession(db);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

type Json = Record<string, unknown>;

async function asService<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("set test.role = 'service_role'");
  try {
    return await fn();
  } finally {
    await db.exec("set test.role = ''");
  }
}

async function resolve(tenant: string, criteria: Json): Promise<Json> {
  return asService(async () => {
    const { rows } = await db.query<{ v: Json }>(
      "select public.resolve_sms_audience_v2($1, $2::jsonb) v",
      [tenant, JSON.stringify(criteria)],
    );
    return rows[0].v;
  });
}

let counter = 0;
async function freshTenant(): Promise<string> {
  counter += 1;
  const id = `00000000-0000-4000-c000-${String(counter).padStart(12, "0")}`;
  await db.query(`insert into public.tenants (id, slug, plano) values ($1, $2, 'starter')`, [
    id,
    `push-audience-${counter}`,
  ]);
  return id;
}

async function addPlayer(tenant: string, overrides: Partial<Json> = {}): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.players (tenant_id, email, telefone, total_depositado, ftd_em)
     values ($1, $2, $3, $4, $5) returning id`,
    [
      tenant,
      "email" in overrides ? overrides.email : null,
      "telefone" in overrides ? overrides.telefone : "+5511999990000",
      "total_depositado" in overrides ? overrides.total_depositado : 100,
      "ftd_em" in overrides ? overrides.ftd_em : new Date().toISOString(),
    ],
  );
  return rows[0].id;
}

describe("resolve_sms_audience_v2: playerIds opcional", () => {
  it("com includePlayerIds=true devolve os ids dos jogadores casados pelo critério", async () => {
    const tenant = await freshTenant();
    const p1 = await addPlayer(tenant, { telefone: "+5511999990001" });
    const p2 = await addPlayer(tenant, { telefone: "+5511999990002" });
    // Jogador fora do critério (sem depósito): não deve entrar em `matched`.
    await addPlayer(tenant, { telefone: "+5511999990003", total_depositado: 0, ftd_em: null });

    const result = await resolve(tenant, {
      activity: { deposit: "yes" },
      includePlayerIds: true,
    });

    expect(result.playerIds).toBeDefined();
    expect((result.playerIds as string[]).sort()).toEqual([p1, p2].sort());
    expect(result.total).toBe(2);
  });

  it("sem a flag, a chave 'playerIds' não existe no resultado (payload do SMS não cresce)", async () => {
    const tenant = await freshTenant();
    await addPlayer(tenant);

    const result = await resolve(tenant, { activity: { deposit: "yes" } });

    expect("playerIds" in result).toBe(false);
  });

  it("includePlayerIds=true com zero jogadores casados devolve playerIds como array vazio (não omite a chave)", async () => {
    const tenant = await freshTenant();
    await addPlayer(tenant, { total_depositado: 0, ftd_em: null }); // não bate o critério abaixo

    const result = await resolve(tenant, {
      activity: { deposit: "yes" },
      includePlayerIds: true,
    });

    expect(result.playerIds).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("includePlayerIds=false explícito também não inclui a chave", async () => {
    const tenant = await freshTenant();
    await addPlayer(tenant);

    const result = await resolve(tenant, { activity: { deposit: "yes" }, includePlayerIds: false });

    expect("playerIds" in result).toBe(false);
  });
});
