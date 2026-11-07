// Início do expert — SQL tests for
// supabase/migrations/20261216100000_expert_home_summary.sql
//
// Runs the migration inside an in-memory Postgres (PGlite) over a minimal
// schema with only the columns expert_home_summary reads (players,
// deposits, withdrawals, events, conversion_attributions,
// journey_enrollments and a crm_dispatch_was_active stub). Asserts that a
// restrito expert (affiliate ids array) never counts players of other
// affiliates, other houses or without affiliate, in any number, series or
// live feed; that null affiliate ids = the whole house; that an empty array
// is all zeros; and that only service_role can execute the function.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const MIGRATION = readFileSync(
  resolve(root, "supabase/migrations/20261216100000_expert_home_summary.sql"),
  "utf8",
);

const SCHEMA = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;

create table public.players (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  nome text,
  affiliate_id text,
  created_at timestamptz not null default now(),
  ftd_em timestamptz
);
create table public.deposits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  player_id uuid,
  valor numeric not null default 0,
  status text not null default 'pendente',
  created_at timestamptz not null default now()
);
create table public.withdrawals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  player_id uuid,
  valor numeric not null default 0,
  status text not null default 'pendente',
  created_at timestamptz not null default now()
);
create table public.events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  player_id uuid,
  tipo text,
  valor numeric,
  created_at timestamptz not null default now()
);
create table public.conversion_attributions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  player_id uuid,
  event_type text not null default 'deposit_approved',
  classification text not null default 'direct',
  source_type text not null default 'campaign',
  link_dispatch_id uuid,
  monetary_value numeric not null default 0,
  occurred_at timestamptz not null default now()
);
create table public.journey_enrollments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  player_id uuid not null,
  status text not null default 'active'
);
-- Stub: the dispatch '...dead' stands for "player was already active at the click".
create function public.crm_dispatch_was_active(_tenant uuid, _dispatch uuid) returns boolean
language sql stable as $$
  select coalesce(_dispatch = '00000000-0000-4000-8000-00000000dead'::uuid, false)
$$;
`;

const T = "00000000-0000-4000-8000-00000000000a";
const OTHER_T = "00000000-0000-4000-8000-00000000000b";
const ACTIVE_DISPATCH = "00000000-0000-4000-8000-00000000dead";

// Current period: 2026-11-01..2026-11-07 (BRT); previous: 2026-10-25..2026-10-31.
const FROM = "2026-11-01T03:00:00.000Z";
const TO = "2026-11-08T02:59:59.999Z";
const PREV_FROM = "2026-10-25T03:00:00.000Z";
const PREV_TO = "2026-11-01T02:59:59.999Z";
const CUR = "2026-11-03T15:00:00Z";
const PREV = "2026-10-28T15:00:00Z";

let db: PGlite;

async function player(
  tenant: string,
  nome: string,
  affiliate: string | null,
  createdAt: string,
  ftdEm: string | null = null,
) {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.players (tenant_id, nome, affiliate_id, created_at, ftd_em)
     values ($1, $2, $3, $4, $5) returning id`,
    [tenant, nome, affiliate, createdAt, ftdEm],
  );
  return rows[0].id;
}

async function deposit(
  tenant: string,
  playerId: string | null,
  valor: number,
  at: string,
  status = "aprovado",
) {
  await db.query(
    `insert into public.deposits (tenant_id, player_id, valor, status, created_at) values ($1,$2,$3,$4,$5)`,
    [tenant, playerId, valor, status, at],
  );
}

async function withdrawal(tenant: string, playerId: string, valor: number, at: string) {
  await db.query(
    `insert into public.withdrawals (tenant_id, player_id, valor, status, created_at) values ($1,$2,$3,'aprovado',$4)`,
    [tenant, playerId, valor, at],
  );
}

/** Seeds the same activity for one player: FTD + redeposit + pending PIX + withdrawal + recovered + journey. */
async function activity(tenant: string, playerId: string, base: number) {
  await deposit(tenant, playerId, base, "2026-11-02T12:00:00Z"); // FTD (ftd_em below)
  await deposit(tenant, playerId, base * 2, CUR); // redeposit
  await deposit(tenant, playerId, 999, CUR, "pendente"); // PIX gerado, não pago
  await deposit(tenant, playerId, base / 2, PREV); // previous period
  await withdrawal(tenant, playerId, base / 4, CUR);
  await db.query(
    `insert into public.conversion_attributions (tenant_id, player_id, monetary_value, occurred_at, source_type)
     values ($1, $2, $3, $4, 'journey')`,
    [tenant, playerId, base * 2, CUR],
  );
  await db.query(
    `insert into public.conversion_attributions (tenant_id, player_id, monetary_value, occurred_at, link_dispatch_id)
     values ($1, $2, 5000, $3, $4)`,
    [tenant, playerId, CUR, ACTIVE_DISPATCH],
  );
  await db.query(
    `insert into public.journey_enrollments (tenant_id, player_id, status) values ($1, $2, 'waiting')`,
    [tenant, playerId],
  );
  await db.query(
    `insert into public.events (tenant_id, player_id, tipo, valor, created_at) values ($1, $2, 'pix_generated', 999, $3)`,
    [tenant, playerId, CUR],
  );
}

type Summary = Record<string, unknown> & {
  cashflowChart: Array<{ key: string; deposits: number; withdrawals: number }>;
  liveEvents: Array<{ player: string; tone: string }>;
};

async function summary(affiliates: string[] | null, tenant = T, resetAt?: string) {
  const { rows } = await db.query<{ v: Summary }>(
    `select public.expert_home_summary($1, $2, $3, $4, $5, $6${resetAt ? ", $7" : ""}) v`,
    [tenant, affiliates, FROM, TO, PREV_FROM, PREV_TO, ...(resetAt ? [resetAt] : [])],
  );
  return rows[0].v;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(MIGRATION);

  // Mine (affiliate A): 2 players, one registered + FTD in the period.
  const ana = await player(T, "Ana", "A", "2026-11-02T10:00:00Z", "2026-11-02T12:00:00Z");
  const bia = await player(T, "Bia", "A", "2026-10-20T10:00:00Z");
  await activity(T, ana, 100);
  await deposit(T, bia, 40, "2026-10-26T12:00:00Z"); // previous period only
  // Not mine: other affiliate, no affiliate, deposit with no player, other house.
  const caio = await player(T, "Caio", "B", "2026-11-04T10:00:00Z", "2026-11-02T12:00:00Z");
  await activity(T, caio, 1000);
  const davi = await player(T, "Davi", null, "2026-11-05T10:00:00Z");
  await deposit(T, davi, 7, CUR);
  await deposit(T, null, 3, CUR);
  const eva = await player(OTHER_T, "Eva", "A", "2026-11-02T10:00:00Z", "2026-11-02T12:00:00Z");
  await activity(OTHER_T, eva, 10_000);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe("expert_home_summary — restrito", () => {
  it("counts only the players of the expert's affiliate ids in this house", async () => {
    const s = await summary(["A"]);
    expect(s.newPlayers).toBe(1);
    expect(s.ftd).toBe(1);
    expect(s.previousNewPlayers).toBe(0);
    expect(Number(s.depositAmount)).toBe(300); // 100 FTD + 200 redeposit
    expect(s.depositCount).toBe(2);
    expect(s.pixGenerated).toBe(3); // + the pending PIX
    expect(s.depositors).toBe(1);
    expect(Number(s.previousDepositAmount)).toBe(90); // Ana 50 + Bia 40
    expect(s.previousDepositors).toBe(2);
    expect(Number(s.redepositAmount)).toBe(200);
    expect(s.redepositPlayers).toBe(1);
    expect(Number(s.withdrawalAmount)).toBe(25);
    // Recovered excludes the "already active at the click" attribution.
    expect(Number(s.recoveredAmount)).toBe(200);
    expect(Number(s.recoveredReactivated)).toBe(200);
    expect(s.recoveredPlayers).toBe(1);
    expect(s.reactivationQueue).toBe(1);
  });

  it("daily series and live feed only show the expert's leads", async () => {
    const s = await summary(["A"]);
    expect(s.cashflowChart).toHaveLength(7);
    const total = s.cashflowChart.reduce((acc, r) => acc + Number(r.deposits), 0);
    expect(total).toBe(300);
    expect(s.cashflowChart.find((r) => r.key === "2026-11-03")).toMatchObject({
      deposits: 200,
      withdrawals: 25,
    });
    expect(s.liveEvents.length).toBeGreaterThan(0);
    expect(s.liveEvents.length).toBeLessThanOrEqual(8);
    for (const e of s.liveEvents) expect(["Ana", "Bia"]).toContain(e.player);
    expect(new Set(s.liveEvents.map((e) => e.tone))).toEqual(
      new Set(["blue", "green", "purple", "orange"]),
    );
  });

  it("an empty affiliate list is all zeros", async () => {
    const s = await summary([]);
    expect(s.newPlayers).toBe(0);
    expect(s.depositCount).toBe(0);
    expect(Number(s.depositAmount)).toBe(0);
    expect(s.pixGenerated).toBe(0);
    expect(Number(s.recoveredAmount)).toBe(0);
    expect(s.reactivationQueue).toBe(0);
    expect(s.liveEvents).toEqual([]);
    expect(s.cashflowChart.every((r) => Number(r.deposits) === 0)).toBe(true);
  });

  it("an affiliate id of another house's player doesn't leak across houses", async () => {
    const s = await summary(["A"], OTHER_T);
    expect(Number(s.depositAmount)).toBe(30_000);
    for (const e of s.liveEvents) expect(e.player).toBe("Eva");
  });
});

describe("expert_home_summary — total (null affiliate ids)", () => {
  it("is the whole house, including players without affiliate and deposits without player", async () => {
    const s = await summary(null);
    expect(s.newPlayers).toBe(3); // Ana, Caio, Davi
    expect(s.ftd).toBe(2);
    expect(Number(s.depositAmount)).toBe(300 + 3000 + 7 + 3);
    expect(s.depositCount).toBe(6);
    expect(s.pixGenerated).toBe(8);
    expect(s.depositors).toBe(3);
    expect(Number(s.recoveredAmount)).toBe(2200);
    expect(s.reactivationQueue).toBe(2);
    expect(Number(s.withdrawalAmount)).toBe(275);
    for (const e of s.liveEvents)
      expect(["Ana", "Bia", "Caio", "Davi", "jogador"]).toContain(e.player);
  });

  it("reset_at cuts the period like the house (whole BRT day for daily metrics)", async () => {
    const s = await summary(null, T, "2026-11-03T18:00:00Z");
    // Daily metrics keep the whole 2026-11-03 day (as tenant_daily_metrics).
    expect(s.depositCount).toBe(4); // the 4 approved deposits on 11-03
    // Exact-instant metrics (depositors) drop what happened before reset_at.
    expect(s.depositors).toBe(0);
    expect(s.cashflowChart[0].key).toBe("2026-11-03");
  });
});

describe("expert_home_summary — grants", () => {
  it("is executable only by service_role", async () => {
    const sig =
      "public.expert_home_summary(uuid, text[], timestamptz, timestamptz, timestamptz, timestamptz, timestamptz)";
    const { rows } = await db.query<{ role: string; ok: boolean }>(
      `select r role, has_function_privilege(r, '${sig}', 'execute') ok
       from unnest(array['anon','authenticated','service_role']) r`,
    );
    expect(Object.fromEntries(rows.map((r) => [r.role, r.ok]))).toEqual({
      anon: false,
      authenticated: false,
      service_role: true,
    });
  });
});
