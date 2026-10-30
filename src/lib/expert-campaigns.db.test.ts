// Área do Expert — campanhas: SQL tests for
// supabase/migrations/20261126100000_expert_campaigns.sql.
//
// Applies the PG1/PG3 wallet migrations (price book, wallet, settle) and the
// new migration on PGlite over a minimal stub of the tables it touches.
// Covers expert_wallet_reserve (cap null/0/limit, cross-channel sum,
// back-to-back reserves at the limit, idempotent replay, refund to the
// reservation's month across a month boundary, voice settlement), the
// approval gate CHECKs, the "expert rows are service_role only" trigger, the
// partial unique names of sms_audiences and the affiliate scope of
// resolve_sms_audience_v2.

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  readMigration,
  resetSession as resetDbSession,
  SCHEMA,
  SEED,
} from "./billing/billing-db-test-support";

const MIGRATIONS = [
  "supabase/migrations/20261022100000_billing_price_book.sql",
  "supabase/migrations/20261022100100_billing_wallet.sql",
  "supabase/migrations/20261024100000_billing_wallet_settle.sql",
];
const EXPERT_MIGRATION = readMigration("supabase/migrations/20261126100000_expert_campaigns.sql");

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

let counter = 0;
async function freshTenant(balance = 100): Promise<string> {
  counter += 1;
  const id = `00000000-0000-4000-b000-${String(counter).padStart(12, "0")}`;
  await db.query(`insert into public.tenants (id, slug, plano) values ($1, $2, 'starter')`, [
    id,
    `expert-${counter}`,
  ]);
  if (balance > 0)
    await as("super", () =>
      call("select public.admin_adjust_wallet($1, $2, $3, $4) v", [id, balance, "saldo", `a:${id}`]),
    );
  return id;
}

async function freshExpert(
  tenant: string,
  opts: { teto?: number | null; ativo?: boolean } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.experts (tenant_id, teto_mensal, ativo) values ($1, $2, $3) returning id`,
    [tenant, opts.teto === undefined ? null : opts.teto, opts.ativo ?? true],
  );
  return rows[0].id;
}

const expertReserve = (
  expert: string,
  tenant: string,
  item: string,
  units: number,
  ref: string,
  key = `reserve:${ref}`,
) =>
  as("service_role", () =>
    call("select public.expert_wallet_reserve($1, $2, $3, $4, $5, $6, $7) v", [
      expert,
      tenant,
      item,
      units,
      item === "voice_30s" ? "voice_call" : "send",
      ref,
      key,
    ]),
  );

async function errorOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function used(expert: string, month?: string): Promise<number> {
  const { rows } = await db.query<{ amount: string }>(
    `select coalesce(sum(amount), 0)::text amount from public.expert_monthly_usage
     where expert_id = $1 and ($2::date is null or month = $2::date)`,
    [expert, month ?? null],
  );
  return Number(rows[0].amount);
}

async function balanceOf(tenant: string): Promise<number> {
  const { rows } = await db.query<{ balance: string }>(
    "select balance::text balance from public.tenant_wallets where tenant_id = $1",
    [tenant],
  );
  return Number(rows[0]?.balance ?? 0);
}

describe("expert_wallet_reserve: teto mensal", () => {
  it("sem teto (null): reserva e registra o consumo pelo preço de venda", async () => {
    const tenant = await freshTenant();
    const expert = await freshExpert(tenant, { teto: null });
    const r = await expertReserve(expert, tenant, "sms", 3, "sms-null-1");
    expect(Number(r.expert_cost)).toBeCloseTo(0.24, 4);
    expect(await used(expert)).toBeCloseTo(0.24, 4);
    expect(await balanceOf(tenant)).toBeCloseTo(100 - 0.24, 4);
  });

  it("teto 0 bloqueia qualquer envio e não toca a carteira", async () => {
    const tenant = await freshTenant();
    const expert = await freshExpert(tenant, { teto: 0 });
    expect(await errorOf(expertReserve(expert, tenant, "sms", 1, "sms-zero"))).toContain(
      "expert_cap_reached",
    );
    expect(await balanceOf(tenant)).toBe(100);
    expect(await used(expert)).toBe(0);
  });

  it("acima do teto: recusa e desfaz a reserva da carteira", async () => {
    const tenant = await freshTenant();
    const expert = await freshExpert(tenant, { teto: 0.2 });
    await expertReserve(expert, tenant, "sms", 2, "lim-1"); // 0.16
    expect(await errorOf(expertReserve(expert, tenant, "sms", 1, "lim-2"))).toContain(
      "expert_cap_reached",
    );
    expect(await used(expert)).toBeCloseTo(0.16, 4);
    expect(await balanceOf(tenant)).toBeCloseTo(100 - 0.16, 4);
    const { rows } = await db.query(
      "select 1 from public.wallet_ledger where reference_id = 'lim-2'",
    );
    expect(rows).toHaveLength(0);
  });

  it("exatamente no teto passa; o próximo centavo não", async () => {
    const tenant = await freshTenant();
    const expert = await freshExpert(tenant, { teto: 0.16 });
    await expertReserve(expert, tenant, "sms", 2, "exact-1");
    expect(await used(expert)).toBeCloseTo(0.16, 4);
    expect(await errorOf(expertReserve(expert, tenant, "email", 1, "exact-2"))).toContain(
      "expert_cap_reached",
    );
  });

  it("soma todos os canais (SMS + voz + e-mail, inclusive dentro da franquia)", async () => {
    const tenant = await freshTenant();
    const expert = await freshExpert(tenant, { teto: 1 });
    await expertReserve(expert, tenant, "sms", 5, "x-sms"); // 0.40
    await expertReserve(expert, tenant, "voice_30s", 5, "x-voice"); // 0.45
    // E-mail dentro da franquia: a casa não paga, mas o teto conta 0.002.
    const email = await expertReserve(expert, tenant, "email", 1, "x-email");
    expect(Number(email.amount)).toBe(0);
    expect(await used(expert)).toBeCloseTo(0.852, 4);
    expect(await errorOf(expertReserve(expert, tenant, "sms", 2, "x-sms-2"))).toContain(
      "expert_cap_reached",
    );
  });

  it("reservas seguidas no limite: só as que cabem passam (travadas pelo expert)", async () => {
    const tenant = await freshTenant();
    const expert = await freshExpert(tenant, { teto: 0.4 });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        errorOf(expertReserve(expert, tenant, "sms", 1, `conc-${i}`)),
      ),
    );
    expect(results.filter((e) => e === "")).toHaveLength(5);
    expect(results.filter((e) => e.includes("expert_cap_reached"))).toHaveLength(3);
    expect(await used(expert)).toBeCloseTo(0.4, 4);
  });

  it("repetição idempotente não conta duas vezes", async () => {
    const tenant = await freshTenant();
    const expert = await freshExpert(tenant, { teto: 1 });
    await expertReserve(expert, tenant, "sms", 2, "idem-1");
    const again = await expertReserve(expert, tenant, "sms", 2, "idem-1");
    expect(again.idempotent).toBe(true);
    expect(await used(expert)).toBeCloseTo(0.16, 4);
  });

  it("expert desativado ou de outra casa: expert_inactive", async () => {
    const tenant = await freshTenant();
    const other = await freshTenant();
    const off = await freshExpert(tenant, { ativo: false });
    const elsewhere = await freshExpert(other);
    expect(await errorOf(expertReserve(off, tenant, "sms", 1, "off-1"))).toContain(
      "expert_inactive",
    );
    expect(await errorOf(expertReserve(elsewhere, tenant, "sms", 1, "else-1"))).toContain(
      "expert_inactive",
    );
  });

  it("saldo insuficiente da casa continua sendo insufficient_balance", async () => {
    const tenant = await freshTenant(0);
    const expert = await freshExpert(tenant, { teto: 10 });
    expect(await errorOf(expertReserve(expert, tenant, "sms", 1, "broke-1"))).toContain(
      "insufficient_balance",
    );
  });

  it("só service_role chama", async () => {
    const tenant = await freshTenant();
    const expert = await freshExpert(tenant);
    expect(
      await errorOf(
        call("select public.expert_wallet_reserve($1, $2, 'sms', 1, 's', 'auth-1', 'k') v", [
          expert,
          tenant,
        ]),
      ),
    ).toContain("forbidden");
  });
});

describe("estornos devolvem ao teto do mês da reserva", () => {
  it("wallet_refund: estorno no mês seguinte credita o mês da reserva", async () => {
    const tenant = await freshTenant();
    const expert = await freshExpert(tenant, { teto: 1 });
    await db.exec("set app.allow_test_clock = 'on'; set test.now = '2026-11-30 23:50:00-03'");
    try {
      await expertReserve(expert, tenant, "sms", 5, "month-1"); // 0.40 em novembro
      expect(await used(expert, "2026-11-01")).toBeCloseTo(0.4, 4);
      await db.exec("set test.now = '2026-12-01 00:10:00-03'");
      await expertReserve(expert, tenant, "sms", 1, "month-2"); // 0.08 em dezembro
      const refund = await as("service_role", () =>
        call("select public.wallet_refund($1, $2, $3, $4) v", [
          tenant,
          "month-1",
          "refund:month-1",
          "falha",
        ]),
      );
      expect(refund.ok).not.toBe(false);
      expect(await used(expert, "2026-11-01")).toBeCloseTo(0, 4);
      expect(await used(expert, "2026-12-01")).toBeCloseTo(0.08, 4);
      // Repetir o estorno não devolve de novo.
      await as("service_role", () =>
        call("select public.wallet_refund($1, $2, $3, $4) v", [
          tenant,
          "month-1",
          "refund:month-1",
          "falha",
        ]),
      );
      expect(await used(expert, "2026-11-01")).toBeCloseTo(0, 4);
    } finally {
      await db.exec("set app.allow_test_clock = ''; set test.now = ''");
    }
  });

  it("wallet_settle_voice devolve só os blocos não usados", async () => {
    const tenant = await freshTenant();
    const expert = await freshExpert(tenant, { teto: 1 });
    await expertReserve(expert, tenant, "voice_30s", 5, "voice-1"); // 0.45
    const settled = await as("service_role", () =>
      call("select public.wallet_settle_voice($1, $2, $3, $4, $5) v", [
        tenant,
        "voice-1",
        61,
        true,
        "voice-settle:voice-1",
      ]),
    );
    expect(settled.ok).toBe(true);
    // 61 s = 3 blocos: devolve 2 (0.18).
    expect(await used(expert)).toBeCloseTo(0.27, 4);
  });

  it("estorno de reserva da casa (sem expert) não mexe em nenhum teto", async () => {
    const tenant = await freshTenant();
    const expert = await freshExpert(tenant, { teto: 1 });
    await expertReserve(expert, tenant, "sms", 1, "mix-expert");
    await as("service_role", () =>
      call("select public.wallet_reserve($1, 'sms', 1, 's', 'mix-house', 'reserve:mix-house') v", [
        tenant,
      ]),
    );
    await as("service_role", () =>
      call("select public.wallet_refund($1, 'mix-house', 'refund:mix-house', 'x') v", [tenant]),
    );
    expect(await used(expert)).toBeCloseTo(0.08, 4);
  });
});

describe("aprovação e linhas de expert", () => {
  it("campanha pendente não pode ficar 'agendada' (nunca é pega pelo worker)", async () => {
    const tenant = await freshTenant(0);
    const expert = await freshExpert(tenant);
    expect(
      await errorOf(
        db.query(
          `insert into public.sms_campaigns (tenant_id, expert_id, status, approval_status)
           values ($1, $2, 'agendada', 'pendente')`,
          [tenant, expert],
        ),
      ),
    ).toContain("sms_campaigns_approval_gate_chk");
    await db.query(
      `insert into public.sms_campaigns (tenant_id, expert_id, status, approval_status)
       values ($1, $2, 'aguardando_aprovacao', 'pendente')`,
      [tenant, expert],
    );
    expect(
      await errorOf(
        db.query(
          `insert into public.email_campaigns (tenant_id, expert_id, status, approval_status)
           values ($1, $2, 'agendada', 'recusada')`,
          [tenant, expert],
        ),
      ),
    ).toContain("email_campaigns_approval_gate_chk");
  });

  it("approval_status só em campanha de expert", async () => {
    const tenant = await freshTenant(0);
    expect(
      await errorOf(
        db.query(
          `insert into public.sms_campaigns (tenant_id, status, approval_status)
           values ($1, 'agendada', 'aprovada')`,
          [tenant],
        ),
      ),
    ).toContain("sms_campaigns_approval_status_chk");
  });

  it("o REST da casa (authenticated) não grava linha de expert", async () => {
    const tenant = await freshTenant(0);
    const expert = await freshExpert(tenant);
    const { rows } = await db.query<{ id: string }>(
      `insert into public.sms_campaigns (tenant_id, expert_id, status, approval_status)
       values ($1, $2, 'aguardando_aprovacao', 'pendente') returning id`,
      [tenant, expert],
    );
    await db.exec("set role authenticated");
    try {
      expect(
        await errorOf(
          db.query(
            `update public.sms_campaigns set status = 'cancelada' where id = $1`,
            [rows[0].id],
          ),
        ),
      ).toContain("expert_row_service_only");
      expect(
        await errorOf(
          db.query(`insert into public.sms_audiences (tenant_id, name, expert_id) values ($1, 'x', $2)`, [
            tenant,
            expert,
          ]),
        ),
      ).toContain("expert_row_service_only");
      expect(
        await errorOf(db.query(`delete from public.sms_campaigns where id = $1`, [rows[0].id])),
      ).toContain("expert_row_service_only");
      // Linha da casa segue normal.
      await db.query(`insert into public.sms_audiences (tenant_id, name) values ($1, 'casa')`, [
        tenant,
      ]);
    } finally {
      await db.exec("reset role");
    }
  });

  it("nomes de público: casa e cada expert em espaços separados", async () => {
    const tenant = await freshTenant(0);
    const a = await freshExpert(tenant);
    const b = await freshExpert(tenant);
    await db.query(`insert into public.sms_audiences (tenant_id, name) values ($1, 'VIP')`, [tenant]);
    await db.query(
      `insert into public.sms_audiences (tenant_id, name, expert_id) values ($1, 'VIP', $2), ($1, 'VIP', $3)`,
      [tenant, a, b],
    );
    expect(
      await errorOf(
        db.query(`insert into public.sms_audiences (tenant_id, name, expert_id) values ($1, 'VIP', $2)`, [
          tenant,
          a,
        ]),
      ),
    ).toContain("sms_audiences_expert_name_uniq");
    expect(
      await errorOf(
        db.query(`insert into public.sms_audiences (tenant_id, name) values ($1, 'VIP')`, [tenant]),
      ),
    ).toContain("sms_audiences_house_name_uniq");
  });
});

describe("resolve_sms_audience_v2: escopo de afiliados", () => {
  async function resolve(tenant: string, criteria: Json): Promise<Json> {
    return as("service_role", () =>
      call("select public.resolve_sms_audience_v2($1, $2::jsonb) v", [tenant, JSON.stringify(criteria)]),
    );
  }

  it("sem a chave: a casa toda; com a chave: só os afiliados (btrim); vazia: ninguém", async () => {
    const tenant = await freshTenant(0);
    await db.query(
      `insert into public.players (tenant_id, telefone, email, affiliate_id) values
        ($1, '11999990001', 'a@x.com', 'AFF1'),
        ($1, '11999990002', 'b@x.com', ' AFF1 '),
        ($1, '11999990003', 'c@x.com', 'AFF2'),
        ($1, '11999990004', 'd@x.com', null)`,
      [tenant],
    );
    const house = await resolve(tenant, {});
    expect(house.total).toBe(4);
    expect(house.affiliateScoped).toBe(false);
    const scoped = await resolve(tenant, { affiliateIds: ["AFF1"] });
    expect(scoped.total).toBe(2);
    expect(scoped.phones).toEqual(["11999990001", "11999990002"]);
    expect(scoped.affiliateScoped).toBe(true);
    const nobody = await resolve(tenant, { affiliateIds: [] });
    expect(nobody.total).toBe(0);
    const junk = await resolve(tenant, { affiliateIds: "AFF1" });
    expect(junk.total).toBe(0);
  });
});
