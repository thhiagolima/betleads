// Web push billing per lead — PGlite test for
// supabase/migrations/20261217100000_webpush_lead_billing.sql: the
// `webpush_lead` billing item and the per-house batch
// `webpush_lead_bill_tenant` (charge new active subscriptions once, never
// before the cutoff, R$ 0 but marked for price 0 / exempt houses, pending on
// insufficient balance, idempotent re-run). Uses the full migrated database
// (every migration applied) so the real wallet RPCs and FKs are exercised.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migratedPglitePath = "../../../scripts/demo/test-support/migrated-pglite.mjs";
const { createMigratedDb } = (await import(/* @vite-ignore */ migratedPglitePath)) as {
  createMigratedDb: () => Promise<{ db: PGlite }>;
};

const PAGA = "7a3f4d5c-0000-4000-8000-000000000001"; // starter, saldo R$ 10
const ZERO = "7a3f4d5c-0000-4000-8000-000000000002"; // override webpush_lead = 0
const INTERNO = "7a3f4d5c-0000-4000-8000-000000000003"; // plano interno (isenta)
const SEM_SALDO = "7a3f4d5c-0000-4000-8000-000000000004"; // saldo R$ 0,02

const APP = {
  [PAGA]: "7a3f4d5c-0000-4000-8000-0000000000a1",
  [ZERO]: "7a3f4d5c-0000-4000-8000-0000000000a2",
  [INTERNO]: "7a3f4d5c-0000-4000-8000-0000000000a3",
  [SEM_SALDO]: "7a3f4d5c-0000-4000-8000-0000000000a4",
} as const;

const AFTER = "2026-11-07T12:00:00-03:00";
const BEFORE = "2026-11-06T23:59:59-03:00";

let db: PGlite;
let subSeq = 0;

async function asService<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("set request.jwt.claim.role = 'service_role'");
  try {
    return await fn();
  } finally {
    await db.exec("set request.jwt.claim.role = ''");
  }
}

async function addSub(
  tenant: keyof typeof APP,
  opts: { status?: "ativa" | "inativa"; firstSeen?: string | null; billed?: boolean } = {},
): Promise<string> {
  subSeq += 1;
  const { rows } = await db.query<{ id: string }>(
    `insert into public.push_subscriptions
       (tenant_id, app_id, subscription_id, status, first_seen_at, lead_billed_at)
     values ($1, $2, $3, $4, $5, $6)
     returning id`,
    [
      tenant,
      APP[tenant],
      `sub-${subSeq}`,
      opts.status ?? "ativa",
      opts.firstSeen === undefined ? AFTER : opts.firstSeen,
      opts.billed ? AFTER : null,
    ],
  );
  return rows[0].id;
}

type BillResult = {
  ok: boolean;
  status: string;
  units: number;
  amount?: number;
  ledger_id?: string;
  exempt?: boolean;
  idempotent?: boolean;
};

async function bill(tenant: string, limit = 1000): Promise<BillResult> {
  return asService(async () => {
    const { rows } = await db.query<{ v: BillResult }>(
      "select public.webpush_lead_bill_tenant($1, $2) v",
      [tenant, limit],
    );
    return rows[0].v;
  });
}

async function balance(tenant: string): Promise<number> {
  const { rows } = await db.query<{ balance: string }>(
    "select balance from public.tenant_wallets where tenant_id = $1",
    [tenant],
  );
  return Number(rows[0]?.balance ?? 0);
}

async function billedAt(id: string) {
  const { rows } = await db.query<{ lead_billed_at: string | null; lead_billing_ledger_id: string | null }>(
    "select lead_billed_at, lead_billing_ledger_id from public.push_subscriptions where id = $1",
    [id],
  );
  return rows[0];
}

async function leadLedgerRows(tenant: string) {
  const { rows } = await db.query<{ amount: string; units: number; idempotency_key: string }>(
    `select amount, units, idempotency_key from public.wallet_ledger
     where tenant_id = $1 and item = 'webpush_lead' order by created_at`,
    [tenant],
  );
  return rows;
}

beforeAll(async () => {
  ({ db } = await createMigratedDb());

  await db.query(
    `insert into public.tenants (id, nome, slug, status, plano, is_demo) values
       ($1, 'Casa Paga', 'lead-paga', 'active', 'starter', false),
       ($2, 'Casa Zero', 'lead-zero', 'active', 'starter', false),
       ($3, 'Casa Interna', 'lead-interna', 'active', 'interno', false),
       ($4, 'Casa Sem Saldo', 'lead-sem-saldo', 'active', 'starter', false)`,
    [PAGA, ZERO, INTERNO, SEM_SALDO],
  );
  for (const [tenant, app] of Object.entries(APP)) {
    await db.query(
      `insert into public.tenant_webpush_apps
         (id, tenant_id, origin, onesignal_app_id, api_key_encrypted, created_via, status)
       values ($1, $2, $3, $4, 'enc', 'manual', 'ativo')`,
      [app, tenant, `https://${app}.example`, `os-${app}`],
    );
  }
  await db.query(
    `insert into public.tenant_wallets (tenant_id, balance) values
       ($1, 10), ($2, 0), ($3, 0), ($4, 0.02)`,
    [PAGA, ZERO, INTERNO, SEM_SALDO],
  );
  await db.query(
    `insert into public.tenant_price_overrides (tenant_id, item, valid_from, unit_price)
     values ($1, 'webpush_lead', '2026-11-01', 0)`,
    [ZERO],
  );
}, 180_000);

afterAll(async () => {
  await db?.close();
});

describe("webpush_lead billing item", () => {
  it("is in the price book at R$ 0,01 with no provider cost and no free units", async () => {
    const { rows } = await db.query<{
      unit_price: string;
      provider_unit_cost: string;
      free_monthly_units: number;
    }>("select unit_price, provider_unit_cost, free_monthly_units from public.billing_price_book where item = 'webpush_lead'");
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].unit_price)).toBeCloseTo(0.01, 4);
    expect(Number(rows[0].provider_unit_cost)).toBe(0);
    expect(rows[0].free_monthly_units).toBe(0);
  });

  it("wallet_summary lists a webpush_lead price", async () => {
    const summary = await asService(async () => {
      const { rows } = await db.query<{ v: { prices: Record<string, unknown> } }>(
        "select public.wallet_summary($1) v",
        [PAGA],
      );
      return rows[0].v;
    });
    expect(summary.prices).toHaveProperty("webpush_lead");
    expect(summary.prices).toHaveProperty("webpush");
  });
});

describe("webpush_lead_bill_tenant", () => {
  it("refuses callers that are not service_role", async () => {
    await expect(db.query("select public.webpush_lead_bill_tenant($1)", [PAGA])).rejects.toThrow(
      /forbidden/,
    );
    await expect(db.query("select * from public.webpush_lead_billing_tenants()")).rejects.toThrow(
      /forbidden/,
    );
  });

  it("charges new active subscriptions once and skips pre-cutoff, inactive, null first_seen and already billed", async () => {
    const fresh1 = await addSub(PAGA);
    const fresh2 = await addSub(PAGA);
    const fresh3 = await addSub(PAGA, { firstSeen: "2026-11-07T00:00:00-03:00" }); // exactly at the cutoff
    const old = await addSub(PAGA, { firstSeen: BEFORE });
    const inactive = await addSub(PAGA, { status: "inativa" });
    const noFirstSeen = await addSub(PAGA, { firstSeen: null });
    const alreadyBilled = await addSub(PAGA, { billed: true });

    const tenants = await asService(async () => {
      const { rows } = await db.query<{ t: string }>(
        "select t from public.webpush_lead_billing_tenants() t",
      );
      return rows.map((r) => r.t);
    });
    expect(tenants).toContain(PAGA);

    const before = await balance(PAGA);
    const result = await bill(PAGA);
    expect(result).toMatchObject({ ok: true, status: "cobrado", units: 3, idempotent: false, exempt: false });
    expect(Number(result.amount)).toBeCloseTo(0.03, 4);
    expect(await balance(PAGA)).toBeCloseTo(before - 0.03, 4);

    for (const id of [fresh1, fresh2, fresh3]) {
      const row = await billedAt(id);
      expect(row.lead_billed_at).not.toBeNull();
      expect(row.lead_billing_ledger_id).toBe(result.ledger_id);
    }
    for (const id of [old, inactive, noFirstSeen]) {
      expect((await billedAt(id)).lead_billed_at).toBeNull();
    }
    expect((await billedAt(alreadyBilled)).lead_billing_ledger_id).toBeNull();

    const ledger = await leadLedgerRows(PAGA);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].units).toBe(3);
    expect(ledger[0].idempotency_key).toMatch(/^webpush_lead:[0-9a-f]{32}$/);

    const { rows: usage } = await db.query<{ units: string; billed_amount: string }>(
      "select units, billed_amount from public.tenant_monthly_usage where tenant_id = $1 and item = 'webpush_lead'",
      [PAGA],
    );
    expect(Number(usage[0].units)).toBe(3);
    expect(Number(usage[0].billed_amount)).toBeCloseTo(0.03, 4);
  });

  it("re-running is a no-op: nothing pending, no second charge", async () => {
    const before = await balance(PAGA);
    const again = await bill(PAGA);
    expect(again).toMatchObject({ ok: true, status: "nada", units: 0 });
    expect(await balance(PAGA)).toBeCloseTo(before, 4);
    expect(await leadLedgerRows(PAGA)).toHaveLength(1);

    const tenants = await asService(async () => {
      const { rows } = await db.query<{ t: string }>(
        "select t from public.webpush_lead_billing_tenants() t",
      );
      return rows.map((r) => r.t);
    });
    expect(tenants).not.toContain(PAGA);
  });

  it("a subscription that turns active later is charged in a later batch with a new key", async () => {
    const late = await addSub(PAGA, { status: "inativa" });
    await db.query("update public.push_subscriptions set status = 'ativa' where id = $1", [late]);
    const before = await balance(PAGA);
    const result = await bill(PAGA);
    expect(result).toMatchObject({ status: "cobrado", units: 1, idempotent: false });
    expect(await balance(PAGA)).toBeCloseTo(before - 0.01, 4);
    const ledger = await leadLedgerRows(PAGA);
    expect(ledger).toHaveLength(2);
    expect(ledger[0].idempotency_key).not.toBe(ledger[1].idempotency_key);
  });

  it("honours the batch limit and leaves the rest pending for the next call", async () => {
    await addSub(PAGA);
    await addSub(PAGA);
    await addSub(PAGA);
    expect(await bill(PAGA, 2)).toMatchObject({ status: "cobrado", units: 2 });
    expect(await bill(PAGA, 2)).toMatchObject({ status: "cobrado", units: 1 });
    expect(await bill(PAGA, 2)).toMatchObject({ status: "nada" });
  });

  it("marks billed at R$ 0 when the house's webpush_lead override is 0", async () => {
    const id = await addSub(ZERO);
    const result = await bill(ZERO);
    expect(result).toMatchObject({ ok: true, status: "cobrado", units: 1, exempt: false });
    expect(Number(result.amount)).toBe(0);
    expect(await balance(ZERO)).toBe(0);
    expect((await billedAt(id)).lead_billed_at).not.toBeNull();
  });

  it("marks billed at R$ 0 for an exempt (plano interno) house", async () => {
    const id = await addSub(INTERNO);
    const result = await bill(INTERNO);
    expect(result).toMatchObject({ ok: true, status: "cobrado", units: 1, exempt: true });
    expect(Number(result.amount)).toBe(0);
    expect(await balance(INTERNO)).toBe(0);
    expect((await billedAt(id)).lead_billed_at).not.toBeNull();
  });

  it("insufficient balance leaves every row pending and charges nothing", async () => {
    const ids = [await addSub(SEM_SALDO), await addSub(SEM_SALDO), await addSub(SEM_SALDO)];
    const result = await bill(SEM_SALDO);
    expect(result).toMatchObject({ ok: false, status: "saldo_insuficiente", units: 3 });
    expect(await balance(SEM_SALDO)).toBeCloseTo(0.02, 4);
    expect(await leadLedgerRows(SEM_SALDO)).toHaveLength(0);
    for (const id of ids) expect((await billedAt(id)).lead_billed_at).toBeNull();

    // Top-up: the same rows are charged on the next run.
    await db.query("update public.tenant_wallets set balance = 1 where tenant_id = $1", [SEM_SALDO]);
    const retry = await bill(SEM_SALDO);
    expect(retry).toMatchObject({ ok: true, status: "cobrado", units: 3, idempotent: false });
    expect(await balance(SEM_SALDO)).toBeCloseTo(0.97, 4);
    for (const id of ids) expect((await billedAt(id)).lead_billed_at).not.toBeNull();
  });

  it("an existing reservation for the exact same set marks the rows without charging again", async () => {
    // Simulates a crash recovery edge: the reservation for this exact set of
    // rows already exists (same deterministic key) but the rows are unmarked.
    const ids = [await addSub(PAGA), await addSub(PAGA)].sort();
    const first = await bill(PAGA);
    expect(first).toMatchObject({ status: "cobrado", units: 2, idempotent: false });
    await db.query(
      "update public.push_subscriptions set lead_billed_at = null, lead_billing_ledger_id = null where id = any($1)",
      [ids],
    );
    const before = await balance(PAGA);
    const second = await bill(PAGA);
    expect(second).toMatchObject({ status: "cobrado", units: 2, idempotent: true, ledger_id: first.ledger_id });
    expect(await balance(PAGA)).toBeCloseTo(before, 4);
    for (const id of ids) expect((await billedAt(id)).lead_billing_ledger_id).toBe(first.ledger_id);
  });
});
