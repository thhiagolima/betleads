// Task 2 (conta própria de provedor por casa) — SQL test for
// supabase/migrations/20261219100100_wallet_reserve_own_account.sql:
// wallet_reserve/expert_wallet_reserve recognize an account "owned" by the
// calling house (provider_accounts.owner_tenant_id = _tenant, Task 1) and
// reserve it for free — no franchise spent, no provider cost, metadata with
// provider_account_id + own_account, and the expert's monthly cap untouched.
//
// Applies the same migration chain as expert-campaigns.db.test.ts (price
// book, wallet, wallet settle, expert campaigns) plus the webpush billing
// item migration (the "current" wallet_reserve body this task copies from),
// the Task 1 own-provider-accounts migration (adds owner_tenant_id) and this
// task's migration, over a minimal stub schema.

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  readMigration,
  resetSession as resetDbSession,
  SCHEMA,
  SEED,
} from "./billing-db-test-support";

const MIGRATIONS = [
  "supabase/migrations/20261022100000_billing_price_book.sql",
  "supabase/migrations/20261022100100_billing_wallet.sql",
  "supabase/migrations/20261024100000_billing_wallet_settle.sql",
  "supabase/migrations/20261126100000_expert_campaigns.sql",
  "supabase/migrations/20261210100100_webpush_billing_item.sql",
  "supabase/migrations/20261219100000_own_provider_accounts.sql",
  "supabase/migrations/20261219100100_wallet_reserve_own_account.sql",
].map(readMigration);

// Same stub tables as expert-campaigns.db.test.ts (20261126100000 touches
// all of these), plus a minimal provider_accounts stub that
// 20261219100000_own_provider_accounts.sql alters with owner_tenant_id.
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
create table public.provider_accounts (
  id uuid primary key default gen_random_uuid()
);
`;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(SEED);
  await db.exec(STUBS);
  for (const m of MIGRATIONS) await db.exec(m);
  await resetDbSession(db);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

type Json = Record<string, unknown>;

async function as<T>(role: "service_role" | "super", fn: () => Promise<T>): Promise<T> {
  await db.exec(role === "super" ? "set test.super = 'on'" : "set test.role = 'service_role'");
  try {
    return await fn();
  } finally {
    await db.exec(role === "super" ? "set test.super = 'off'" : "set test.role = ''");
  }
}

async function call(sql: string, params: unknown[]): Promise<Json> {
  const { rows } = await db.query<{ v: Json }>(sql, params);
  return rows[0].v;
}

async function errorOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

let tenantCounter = 0;
async function freshTenant(balance = 0): Promise<string> {
  tenantCounter += 1;
  const id = `00000000-0000-4000-c000-${String(tenantCounter).padStart(12, "0")}`;
  await db.query(`insert into public.tenants (id, slug, plano) values ($1, $2, 'starter')`, [
    id,
    `own-account-${tenantCounter}`,
  ]);
  if (balance > 0) {
    await as("super", () =>
      call("select public.admin_adjust_wallet($1, $2, $3, $4) v", [
        id,
        balance,
        "saldo inicial",
        `adj:own-account:${id}`,
      ]),
    );
  }
  return id;
}

async function ownAccountFor(tenant: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.provider_accounts (owner_tenant_id) values ($1) returning id`,
    [tenant],
  );
  return rows[0].id;
}

function reserve(
  tenant: string,
  item: string,
  units: number,
  ref: string,
  key: string,
  providerAccountId?: string,
) {
  return as("service_role", () =>
    providerAccountId === undefined
      ? call("select public.wallet_reserve($1, $2, $3, $4, $5, $6) v", [
          tenant,
          item,
          units,
          "sms_send",
          ref,
          key,
        ])
      : call("select public.wallet_reserve($1, $2, $3, $4, $5, $6, $7) v", [
          tenant,
          item,
          units,
          "sms_send",
          ref,
          key,
          providerAccountId,
        ]),
  );
}

async function ledgerRow(ref: string): Promise<Json> {
  const { rows } = await db.query<Json>(
    `select provider_unit_cost::text as provider_unit_cost, free_units, metadata, unit_price::text as unit_price
     from public.wallet_ledger where reference_id = $1 order by created_at desc limit 1`,
    [ref],
  );
  return rows[0];
}

async function monthlyUsage(tenant: string, item: string): Promise<Json | undefined> {
  const { rows } = await db.query<Json>(
    `select units::text as units, free_units_used::text as free_units_used,
            billed_amount::text as billed_amount
     from public.tenant_monthly_usage where tenant_id = $1 and item = $2`,
    [tenant, item],
  );
  return rows[0];
}

describe("wallet_reserve: conta com dono", () => {
  it("conta da própria casa: valor 0, sem franquia, custo 0, metadata", async () => {
    const tenant = await freshTenant(0);
    const conta = await ownAccountFor(tenant);

    const result = await reserve(tenant, "sms", 3, "own-ok", "key:own-ok", conta);
    expect(result.ok).toBe(true);
    expect(Number(result.amount)).toBe(0);
    expect(result.own_account).toBe(true);

    const ledger = await ledgerRow("own-ok");
    expect(ledger.provider_unit_cost).toBe("0.0000");
    expect(ledger.free_units).toBe(0);
    expect((ledger.metadata as Json).provider_account_id).toBe(conta);
    expect((ledger.metadata as Json).own_account).toBe(true);
  });

  it("conta com dono de outra casa: cobra normal", async () => {
    const tenant = await freshTenant(0);
    const other = await freshTenant(0);
    const contaDeOutra = await ownAccountFor(other);

    await expect(reserve(tenant, "sms", 3, "other-house", "key:other-house", contaDeOutra)).rejects.toThrow(
      "insufficient_balance",
    );
  });

  it("sem conta: comportamento de hoje", async () => {
    const tenantSemSaldo = await freshTenant(0);
    await expect(reserve(tenantSemSaldo, "sms", 3, "no-account-fail", "key:no-account-fail")).rejects.toThrow(
      "insufficient_balance",
    );

    const tenantComSaldo = await freshTenant(1);
    const result = await reserve(tenantComSaldo, "sms", 3, "no-account-ok", "key:no-account-ok");
    expect(Number(result.amount)).toBeCloseTo(-(3 * 0.08), 4);
    expect(result.own_account).toBe(false);
  });

  it("e-mail por conta própria não gasta a franquia", async () => {
    const tenant = await freshTenant(0);
    const conta = await ownAccountFor(tenant);

    const result = await reserve(tenant, "email", 5, "own-email", "key:own-email", conta);
    expect(Number(result.amount)).toBe(0);
    expect(result.own_account).toBe(true);

    const usage = await monthlyUsage(tenant, "email");
    expect(usage?.units).toBe("5");
    expect(usage?.free_units_used).toBe("0");
    expect(usage?.billed_amount).toBe("0.0000");
  });

  it("sem dono (conta da BetLeads): cobra normal mesmo passando o id", async () => {
    const tenant = await freshTenant(1);
    const { rows } = await db.query<{ id: string }>(
      `insert into public.provider_accounts (owner_tenant_id) values (null) returning id`,
    );
    const contaBetleads = rows[0].id;

    const result = await reserve(tenant, "sms", 2, "betleads-account", "key:betleads-account", contaBetleads);
    expect(result.own_account).toBe(false);
    expect(Number(result.amount)).toBeCloseTo(-(2 * 0.08), 4);
  });
});

describe("expert_wallet_reserve: conta própria não consome o teto", () => {
  async function freshExpert(tenant: string, teto: number | null): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `insert into public.experts (tenant_id, teto_mensal, ativo) values ($1, $2, true) returning id`,
      [tenant, teto],
    );
    return rows[0].id;
  }

  async function expertReserve(
    expert: string,
    tenant: string,
    item: string,
    units: number,
    ref: string,
    providerAccountId?: string,
  ) {
    return as("service_role", () =>
      providerAccountId === undefined
        ? call("select public.expert_wallet_reserve($1, $2, $3, $4, $5, $6, $7) v", [
            expert,
            tenant,
            item,
            units,
            "send",
            ref,
            `key:${ref}`,
          ])
        : call("select public.expert_wallet_reserve($1, $2, $3, $4, $5, $6, $7, $8) v", [
            expert,
            tenant,
            item,
            units,
            "send",
            ref,
            `key:${ref}`,
            providerAccountId,
          ]),
    );
  }

  async function used(expert: string): Promise<number> {
    const { rows } = await db.query<{ amount: string }>(
      `select coalesce(sum(amount), 0)::text amount from public.expert_monthly_usage where expert_id = $1`,
      [expert],
    );
    return Number(rows[0].amount);
  }

  it("expert pela conta própria não consome o teto, mesmo com o teto já esgotado", async () => {
    const tenant = await freshTenant(100);
    const expert = await freshExpert(tenant, 1);
    const conta = await ownAccountFor(tenant);

    // Esgota o teto de R$ 1 pela conta padrão (sms a 0,08 x 13 = 1,04 > 1,
    // então usa 12 = 0,96 e fecha a última unidade exatamente no teto).
    await expertReserve(expert, tenant, "sms", 12, "expert-fill-cap");
    expect(await used(expert)).toBeCloseTo(0.96, 4);

    // Uma próxima reserva pela conta padrão já recusaria (0.96 + 0.08 > 1).
    await expect(expertReserve(expert, tenant, "sms", 1, "expert-would-cap")).rejects.toThrow(
      "expert_cap_reached",
    );

    // A mesma reserva, agora pela conta própria da casa, passa com custo 0
    // e não soma nada ao teto já quase esgotado.
    const result = await expertReserve(expert, tenant, "sms", 1, "expert-own-account", conta);
    expect(Number(result.amount)).toBe(0);
    expect(Number(result.expert_cost)).toBe(0);
    expect(await used(expert)).toBeCloseTo(0.96, 4);
  });
});
