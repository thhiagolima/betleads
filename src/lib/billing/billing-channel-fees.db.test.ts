// Task 3 (conta própria de provedor por casa) — SQL test for
// supabase/migrations/20261231100200_billing_channel_fees.sql:
// billing_channel_fees(_tenant), the channel_fees_cents/channel_fees columns
// on billing_invoices and the billing_issue_invoice / billing_reprice_open_invoice
// bodies that add the frozen fee on top of the discounted base.
//
// Applies the PG1 price book + wallet and PG2 Pix charges migrations, then
// the PG2 invoices migration (20261023100000), a minimal provider_accounts +
// tenant_channel_providers stub (same shape as the real 20261108100000
// migration, trimmed), the Task 1 own-provider-accounts migration
// (20261231100000, adds owner_tenant_id/tenant_own_provider_grants) and this
// task's migration, over the shared billing stub schema.

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readMigration, resetSession as resetDbSession, SCHEMA, SEED } from "./billing-db-test-support";

const PRICE_BOOK_MIGRATION = readMigration(
  "supabase/migrations/20261022100000_billing_price_book.sql",
);
const WALLET_MIGRATION = readMigration("supabase/migrations/20261022100100_billing_wallet.sql");
const PIX_CHARGES_MIGRATION = readMigration(
  "supabase/migrations/20261022110000_billing_pix_charges.sql",
);
const INVOICES_MIGRATION = readMigration("supabase/migrations/20261023100000_billing_invoices.sql");
const OWN_PROVIDER_MIGRATION = readMigration(
  "supabase/migrations/20261231100000_own_provider_accounts.sql",
);
const CHANNEL_FEES_MIGRATION = readMigration(
  "supabase/migrations/20261231100200_billing_channel_fees.sql",
);

// Minimal provider_accounts / tenant_channel_providers stub (same shape as
// 20261108100000_provider_accounts.sql, trimmed to what the own-provider
// migration's recreated trigger functions and billing_channel_fees read:
// channels/status on provider_accounts, the (tenant_id, channel) link).
const PROVIDER_STUBS = `
create table public.provider_accounts (
  id uuid primary key default gen_random_uuid(),
  provider text,
  label text,
  channels text[] not null default array[]::text[],
  credentials_source text,
  credentials_encrypted text,
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.tenant_channel_providers (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  channel text not null,
  provider_account_id uuid not null references public.provider_accounts(id),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, channel)
);
`;

let db: PGlite;

async function setToday(day: string) {
  await db.exec(`set app.allow_test_clock = 'on'; set test.now = '${day} 12:00:00-03';`);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(SEED);
  await db.exec(PRICE_BOOK_MIGRATION);
  await db.exec(WALLET_MIGRATION);
  await db.exec(PIX_CHARGES_MIGRATION);
  await db.exec(`
    create or replace function public.accessible_tenant_ids() returns uuid[] language sql as $$
      select array[nullif(current_setting('test.tenant', true), '')::uuid]
    $$;
  `);
  await setToday("2026-10-23");
  await db.exec(INVOICES_MIGRATION);
  await db.exec(PROVIDER_STUBS);
  await db.exec(OWN_PROVIDER_MIGRATION);
  await db.exec(CHANNEL_FEES_MIGRATION);
  await resetDbSession(db);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

async function asSuperAdmin<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("set test.super = 'on'");
  try {
    return await fn();
  } finally {
    await db.exec("set test.super = 'off'");
  }
}

async function asServiceRole<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("set test.role = 'service_role'");
  try {
    return await fn();
  } finally {
    await db.exec("set test.role = ''");
  }
}

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await db.query<T>(sql, params);
  return rows[0];
}

async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
  const row = await one<{ v: T }>(sql, params);
  return row.v;
}

async function admin(sql: string, params: unknown[] = []) {
  return asSuperAdmin(() => db.query(sql, params));
}

let tenantCounter = 0;
function freshTenant(): string {
  tenantCounter += 1;
  return `00000000-0000-4000-9500-${String(tenantCounter).padStart(12, "0")}`;
}

async function createHouse(plano = "enterprise"): Promise<string> {
  const id = freshTenant();
  await asSuperAdmin(() =>
    db.query(`insert into public.tenants (id, slug, plano) values ($1, $2, $3)`, [
      id,
      `casa-${id.slice(-6)}`,
      plano,
    ]),
  );
  return id;
}

// Cria a casa já com a fatura inicial emitida de novo depois da concessão e
// da conta própria estarem no lugar: a casa nasce pagante e o trigger
// (billing_on_tenant_plano) emite a fatura `upfront` na hora do insert, antes
// que o teste tenha chance de configurar grant/conta. Cancela essa primeira
// fatura e reemite (mesma regra de billing_admin_cancel_invoice para fatura
// de ativação) para que a taxa já configurada entre no cálculo.
async function reissueUpfront(tenant: string) {
  await db.query(
    `update public.billing_invoices set status = 'canceled' where tenant_id = $1 and status = 'open'`,
    [tenant],
  );
  await db.query("select public.billing_issue_invoice($1, true)", [tenant]);
}

type InvoiceRow = {
  id: string;
  status: string;
  base_amount_cents: string;
  discount_cents: string;
  one_off_discount_cents: string;
  amount_cents: string;
  channel_fees_cents: string;
  channel_fees: Record<string, number>;
  paid_via: string | null;
};

async function openInvoiceOf(tenant: string): Promise<InvoiceRow | undefined> {
  const { rows } = await db.query<InvoiceRow>(
    `select id, status, base_amount_cents::text, discount_cents::text,
            one_off_discount_cents::text, amount_cents::text,
            channel_fees_cents::text, channel_fees, paid_via
     from public.billing_invoices where tenant_id = $1 and status in ('open', 'paid')
     order by created_at desc limit 1`,
    [tenant],
  );
  return rows[0];
}

async function grant(tenant: string, channel: string, allowed: boolean, feeCents: number) {
  await asServiceRole(() =>
    db.query(
      `insert into public.tenant_own_provider_grants (tenant_id, channel, allowed, monthly_fee_cents)
       values ($1, $2, $3, $4)
       on conflict (tenant_id, channel) do update set allowed = excluded.allowed, monthly_fee_cents = excluded.monthly_fee_cents`,
      [tenant, channel, allowed, feeCents],
    ),
  );
}

async function ownAccount(tenant: string, channel: string, status = "active"): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.provider_accounts (provider, label, channels, credentials_source, owner_tenant_id, status)
     values ('short_brasil', 'Conta própria', array[$2::text], 'env', $1, $3)
     returning id`,
    [tenant, channel, status],
  );
  const id = rows[0].id;
  await db.query(
    `insert into public.tenant_channel_providers (tenant_id, channel, provider_account_id)
     values ($1, $2, $3)
     on conflict (tenant_id, channel) do update set provider_account_id = excluded.provider_account_id`,
    [tenant, channel, id],
  );
  return id;
}

/** Reserva gratuita de conta própria no razão (o que wallet_reserve grava). */
async function ownUsage(
  tenant: string,
  item: string,
  offset: string,
  ownAccountFlag: unknown = true,
) {
  await db.query(
    `insert into public.wallet_ledger
       (tenant_id, entry_type, item, units, unit_price, provider_unit_cost, amount, balance_after,
        metadata, created_at)
     values ($1, 'usage_reservation', $2, 1, 0, 0, 0, 0,
             jsonb_build_object('own_account', $3::jsonb), now() + $4::interval)`,
    [tenant, item, JSON.stringify(ownAccountFlag), offset],
  );
}

async function feesOf(tenant: string) {
  return scalar<Record<string, unknown>>("select public.billing_channel_fees($1) v", [tenant]);
}

describe("billing_channel_fees", () => {
  describe("uso de conta própria desde a fatura anterior (I1)", () => {
    it("desligar a conta própria antes da emissão depois de usar ainda cobra a taxa", async () => {
      const tenant = await createHouse();
      await grant(tenant, "sms", true, 50000);
      const account = await ownAccount(tenant, "sms", "active");
      // Fatura anterior: a upfront emitida na criação da casa.
      await ownUsage(tenant, "sms", "1 second");
      await db.query(`update public.provider_accounts set status = 'disabled' where id = $1`, [
        account,
      ]);
      await db.query(`delete from public.tenant_channel_providers where tenant_id = $1`, [tenant]);

      expect(await feesOf(tenant)).toEqual({ total_cents: 50000, channels: { sms: 50000 } });
      await reissueUpfront(tenant);
      expect(await openInvoiceOf(tenant)).toMatchObject({
        channel_fees_cents: "50000",
        channel_fees: { sms: 50000 },
      });
    });

    it("sem uso no período e sem conta ativa: sem taxa", async () => {
      const tenant = await createHouse();
      await grant(tenant, "sms", true, 50000);
      await ownAccount(tenant, "sms", "disabled");
      // Uso de antes da fatura anterior não conta.
      await ownUsage(tenant, "sms", "-1 day");
      expect(await feesOf(tenant)).toEqual({ total_cents: 0, channels: {} });
    });

    it("uso pela rota BetLeads, de outro canal ou sem concessão não cobra", async () => {
      const tenant = await createHouse();
      await grant(tenant, "sms", true, 50000);
      await grant(tenant, "email", false, 30000);
      await ownUsage(tenant, "sms", "1 second", false); // rota BetLeads
      await ownUsage(tenant, "voice_30s", "1 second"); // canal sem concessão
      await ownUsage(tenant, "email", "1 second"); // concessão revogada
      expect(await feesOf(tenant)).toEqual({ total_cents: 0, channels: {} });
    });

    it("voz: uso em voice_30s qualifica a concessão 'voice'; e-mail em 'email'", async () => {
      const tenant = await createHouse();
      await grant(tenant, "voice", true, 20000);
      await grant(tenant, "email", true, 10000);
      await ownUsage(tenant, "voice_30s", "1 second");
      await ownUsage(tenant, "email", "1 second");
      expect(await feesOf(tenant)).toEqual({
        total_cents: 30000,
        channels: { voice: 20000, email: 10000 },
      });
    });

    it("sem fatura anterior: conta o uso desde granted_at", async () => {
      const tenant = await createHouse();
      await db.query(`delete from public.billing_invoices where tenant_id = $1`, [tenant]);
      await grant(tenant, "sms", true, 50000);
      await asServiceRole(() =>
        db.query(
          `update public.tenant_own_provider_grants set granted_at = now() where tenant_id = $1`,
          [tenant],
        ),
      );
      await ownUsage(tenant, "sms", "-1 hour");
      expect(await feesOf(tenant)).toEqual({ total_cents: 0, channels: {} });
      await ownUsage(tenant, "sms", "1 second");
      expect(await feesOf(tenant)).toEqual({ total_cents: 50000, channels: { sms: 50000 } });
    });
  });


  it("taxa entra só com concessão e conta própria ativas", async () => {
    const tenant = await createHouse();
    await grant(tenant, "sms", true, 50000);
    await ownAccount(tenant, "sms", "active");
    await reissueUpfront(tenant);

    const fees = await scalar<Record<string, unknown>>(
      "select public.billing_channel_fees($1) v",
      [tenant],
    );
    expect(fees).toEqual({ total_cents: 50000, channels: { sms: 50000 } });

    const invoice = await openInvoiceOf(tenant);
    expect(invoice).toMatchObject({
      channel_fees_cents: "50000",
      channel_fees: { sms: 50000 },
    });
    expect(Number(invoice!.amount_cents)).toBe(Number(invoice!.base_amount_cents) + 50000);
  });

  it("concessão sem conta ativa não cobra", async () => {
    const tenant = await createHouse();
    await grant(tenant, "sms", true, 50000);
    await ownAccount(tenant, "sms", "disabled");
    await reissueUpfront(tenant);

    const fees = await scalar<Record<string, unknown>>(
      "select public.billing_channel_fees($1) v",
      [tenant],
    );
    expect(fees).toEqual({ total_cents: 0, channels: {} });

    const invoice = await openInvoiceOf(tenant);
    expect(invoice).toMatchObject({ channel_fees_cents: "0", channel_fees: {} });
  });

  it("concessão sem linha em tenant_channel_providers não cobra", async () => {
    const tenant = await createHouse();
    await grant(tenant, "sms", true, 50000);
    // Conta própria existe mas não está ligada ao canal da casa.
    await db.query(
      `insert into public.provider_accounts (provider, label, channels, credentials_source, owner_tenant_id, status)
       values ('short_brasil', 'Conta própria não ligada', array['sms'], 'env', $1, 'active')`,
      [tenant],
    );

    const fees = await scalar<Record<string, unknown>>(
      "select public.billing_channel_fees($1) v",
      [tenant],
    );
    expect(fees).toEqual({ total_cents: 0, channels: {} });
  });

  it("taxa zero não aparece", async () => {
    const tenant = await createHouse();
    await grant(tenant, "sms", true, 0);
    await ownAccount(tenant, "sms", "active");
    await reissueUpfront(tenant);

    const fees = await scalar<Record<string, unknown>>(
      "select public.billing_channel_fees($1) v",
      [tenant],
    );
    expect(fees).toEqual({ total_cents: 0, channels: {} });

    const invoice = await openInvoiceOf(tenant);
    expect(invoice).toMatchObject({ channel_fees_cents: "0", channel_fees: {} });
  });

  it("desconto não incide na taxa", async () => {
    const tenant = await createHouse();
    await grant(tenant, "sms", true, 50000);
    await ownAccount(tenant, "sms", "active");
    await reissueUpfront(tenant);
    // Desconto contínuo de 100% sobre o preço base: liquidaria em
    // full_discount se a taxa também fosse descontada, mas a taxa entra
    // depois do desconto, então a fatura continua aberta com amount_cents =
    // a própria taxa.
    await admin(
      "select public.billing_admin_set_continuous_discount($1, 'percent', 100, null, null)",
      [tenant],
    );

    const invoice = await openInvoiceOf(tenant);
    expect(invoice).toMatchObject({
      status: "open",
      discount_cents: invoice!.base_amount_cents,
      channel_fees_cents: "50000",
      amount_cents: "50000",
      paid_via: null,
    });
  });

  it("repreço mantém a taxa congelada", async () => {
    const tenant = await createHouse();
    await grant(tenant, "sms", true, 50000);
    await ownAccount(tenant, "sms", "active");
    await reissueUpfront(tenant);

    const before = await openInvoiceOf(tenant);
    expect(before).toMatchObject({ channel_fees_cents: "50000" });

    await grant(tenant, "sms", true, 99900);
    await admin("select public.billing_admin_set_custom_price($1, 200000)", [tenant]);

    const after = await openInvoiceOf(tenant);
    expect(after).toMatchObject({
      id: before!.id,
      channel_fees_cents: "50000",
      channel_fees: { sms: 50000 },
      base_amount_cents: "200000",
      amount_cents: "250000",
    });
  });

  it("desconto pontual do superadmin (billing_admin_one_off_discount) mantém a taxa", async () => {
    const tenant = await createHouse();
    await grant(tenant, "sms", true, 50000);
    await ownAccount(tenant, "sms", "active");
    await reissueUpfront(tenant);

    const before = await openInvoiceOf(tenant);
    expect(before).toMatchObject({ channel_fees_cents: "50000" });

    await admin("select public.billing_admin_one_off_discount($1, 'fixed', 10000)", [before!.id]);

    const after = await openInvoiceOf(tenant);
    expect(after).toMatchObject({
      id: before!.id,
      channel_fees_cents: "50000",
      channel_fees: { sms: 50000 },
      one_off_discount_cents: "10000",
    });
    expect(Number(after!.amount_cents)).toBe(
      Number(before!.base_amount_cents) - Number(before!.discount_cents) - 10000 + 50000,
    );
  });

  it("permissões: só service_role chama billing_channel_fees", async () => {
    const sig = "public.billing_channel_fees(uuid)";
    expect(await scalar<boolean>(`select has_function_privilege('anon', '${sig}', 'execute') v`)).toBe(
      false,
    );
    expect(
      await scalar<boolean>(`select has_function_privilege('authenticated', '${sig}', 'execute') v`),
    ).toBe(false);
    expect(
      await scalar<boolean>(`select has_function_privilege('service_role', '${sig}', 'execute') v`),
    ).toBe(true);
  });
});
