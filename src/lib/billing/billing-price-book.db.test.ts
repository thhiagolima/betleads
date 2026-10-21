// PG1 Task 2 — SQL test for
// supabase/migrations/20261022100000_billing_price_book.sql:
// billing_plans/billing_price_book/tenant_price_overrides, the price
// lookup functions, the admin_* RPCs and the tenants.plano guard.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../..");
const MIGRATION = readFileSync(
  resolve(root, "supabase/migrations/20261022100000_billing_price_book.sql"),
  "utf8",
);

// Minimal schema with the production stub pattern (see aquisicao-ltv.db.test.ts):
// auth.role() from test.role, has_tenant_access from test.access,
// is_super_admin from test.super. auth.uid() from test.uid (empty -> null),
// needed for the provider-cost redaction.
const SCHEMA = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema auth;
create function auth.role() returns text language sql as $$
  select coalesce(nullif(current_setting('test.role', true), ''), 'authenticated') $$;
create function auth.uid() returns uuid language sql as $$
  select nullif(current_setting('test.uid', true), '')::uuid $$;
create table public.tenants (
  id uuid primary key,
  slug text unique,
  plano text not null default 'starter'
    constraint tenants_plano_check check (plano in ('starter', 'pro', 'enterprise', 'interno')),
  is_demo boolean not null default false
);
create function public.has_tenant_access(_tenant uuid) returns boolean language sql as $$
  select coalesce(nullif(current_setting('test.access', true), ''), 'on') = 'on' $$;
create function public.is_super_admin() returns boolean language sql as $$
  select coalesce(nullif(current_setting('test.super', true), ''), 'off') = 'on' $$;
create function public.accessible_tenant_ids() returns uuid[] language sql as $$
  select array[]::uuid[] $$;
`;

const NORMAL = "00000000-0000-4000-8000-000000000001";
const INTERNO = "00000000-0000-4000-8000-0000000000d1";
const LEGACY_INTERNO = "00000000-0000-4000-8000-0000000000e1";

const SEED = `
insert into public.tenants (id, slug, plano, is_demo) values
  ('${NORMAL}', 'casa-normal', 'starter', false),
  ('${INTERNO}', 'minha-demo', 'starter', true),
  ('00000000-0000-4000-8000-0000000000f1', 'pixpgf', 'starter', false),
  ('00000000-0000-4000-8000-0000000000f2', 'pixreals', 'starter', false),
  ('00000000-0000-4000-8000-0000000000f3', 'forrandobet', 'starter', false),
  ('${LEGACY_INTERNO}', 'ja-era-interno', 'interno', false);
`;

let db: PGlite;

async function resetSession() {
  await db.exec(`
    set test.role = '';
    set test.access = 'on';
    set test.super = 'off';
    set test.uid = '';
  `);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(SEED);
  await db.exec(MIGRATION);
  await resetSession();
}, 60_000);

afterAll(async () => {
  await db?.close();
});

async function effectivePrice(tenant: string, item: string, at?: string) {
  const { rows } = await db.query<{ v: Record<string, unknown> }>(
    at
      ? "select public.billing_effective_price($1, $2, $3::timestamptz) v"
      : "select public.billing_effective_price($1, $2) v",
    at ? [tenant, item, at] : [tenant, item],
  );
  return rows[0].v;
}

async function reportPrice(tenant: string, item: string) {
  const { rows } = await db.query<{ v: string }>(
    "select public.billing_report_unit_price($1, $2) v",
    [tenant, item],
  );
  return Number(rows[0].v);
}

describe("billing_price_book: data migration", () => {
  it("marks the 3 slugs and the demo tenant as interno", async () => {
    const { rows } = await db.query<{ slug: string; plano: string }>(
      `select slug, plano from public.tenants where slug in ('pixpgf', 'pixreals', 'forrandobet', 'minha-demo') order by slug`,
    );
    expect(rows.every((row) => row.plano === "interno")).toBe(true);
  });

  it("leaves a normal tenant untouched", async () => {
    const { rows } = await db.query<{ plano: string }>(
      `select plano from public.tenants where id = '${NORMAL}'`,
    );
    expect(rows[0].plano).toBe("starter");
  });
});

describe("billing_effective_price", () => {
  it("returns the default sms price for a normal tenant", async () => {
    const v = (await effectivePrice(NORMAL, "sms")) as Record<string, unknown>;
    expect(v).toMatchObject({ item: "sms", exempt: false, source: "default" });
    expect(Number(v.unit_price)).toBeCloseTo(0.08, 4);
    expect(Number(v.provider_unit_cost)).toBeCloseTo(0.059, 4);
  });

  it("free_monthly_units for email is 100000", async () => {
    const v = await effectivePrice(NORMAL, "email");
    expect(Number((v as Record<string, unknown>).free_monthly_units)).toBe(100000);
  });

  it("a tenant override wins over the default while valid", async () => {
    const before = await db.query<{ t: string }>("select (now() - interval '1 minute')::text t");
    const beforeAt = before.rows[0].t;

    await db.exec("set test.super = 'on'");
    await db.query("select public.admin_set_tenant_price($1, $2, $3)", [NORMAL, "sms", 0.07]);

    const after = (await effectivePrice(NORMAL, "sms")) as Record<string, unknown>;
    expect(after).toMatchObject({ source: "override" });
    expect(Number(after.unit_price)).toBeCloseTo(0.07, 4);

    const previously = (await effectivePrice(NORMAL, "sms", beforeAt)) as Record<string, unknown>;
    expect(previously).toMatchObject({ source: "default" });
    expect(Number(previously.unit_price)).toBeCloseTo(0.08, 4);

    // Clean up: this tenant override must not leak into later tests.
    await db.query("select public.admin_clear_tenant_price($1, $2)", [NORMAL, "sms"]);
    await db.exec("set test.super = 'off'");
  });

  it("admin_set_price does not change a price already in the past", async () => {
    const before = await db.query<{ t: string }>("select (now() - interval '1 minute')::text t");
    const beforeAt = before.rows[0].t;

    await db.exec("set test.super = 'on'");
    await db.query("select public.admin_set_price($1, $2, $3, $4)", ["sms", 0.09, 0.059, 0]);
    await db.exec("set test.super = 'off'");

    const previously = (await effectivePrice(NORMAL, "sms", beforeAt)) as Record<string, unknown>;
    expect(Number(previously.unit_price)).toBeCloseTo(0.08, 4);

    const now = (await effectivePrice(NORMAL, "sms")) as Record<string, unknown>;
    expect(Number(now.unit_price)).toBeCloseTo(0.09, 4);
  });

  it("the interno tenant is exempt", async () => {
    const { rows } = await db.query<{ v: boolean }>(
      "select public.billing_tenant_exempt($1) v",
      [INTERNO],
    );
    expect(rows[0].v).toBe(true);
  });

  it("rejects without access, superadmin or service_role", async () => {
    await db.exec("set test.access = 'off'");
    try {
      await expect(effectivePrice(NORMAL, "sms")).rejects.toThrow(/forbidden/);
    } finally {
      await db.exec("set test.access = 'on'");
    }
  });

  it("rejects an item outside the allowed set", async () => {
    await db.exec("set test.super = 'on'");
    try {
      await expect(
        db.query("select public.admin_set_price($1, $2)", ["whatsapp", 0.5]),
      ).rejects.toThrow();
    } finally {
      await db.exec("set test.super = 'off'");
    }
  });
});

describe("provider_unit_cost redaction", () => {
  it("is hidden for a signed-in tenant user who is not superadmin", async () => {
    await db.exec(`set test.uid = '${NORMAL}'; set test.super = 'off';`);
    try {
      const v = (await effectivePrice(NORMAL, "sms")) as Record<string, unknown>;
      expect(Object.keys(v)).not.toContain("provider_unit_cost");
    } finally {
      await resetSession();
    }
  });

  it("is present for service_role / no uid (e.g. migration, server)", async () => {
    const v = (await effectivePrice(NORMAL, "sms")) as Record<string, unknown>;
    expect(Object.keys(v)).toContain("provider_unit_cost");
  });
});

describe("EXECUTE privileges", () => {
  it("anon cannot execute billing_effective_price (no EXECUTE for PUBLIC/anon)", async () => {
    await db.exec("set role anon");
    try {
      await expect(
        db.query("select public.billing_effective_price($1, $2)", [NORMAL, "sms"]),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("reset role");
    }
  });
});

describe("billing_report_unit_price", () => {
  it("interno sms reports the provider cost (0.059)", async () => {
    expect(await reportPrice(INTERNO, "sms")).toBeCloseTo(0.059, 4);
  });

  it("interno email reports the sale price (no provider cost)", async () => {
    expect(await reportPrice(INTERNO, "email")).toBeCloseTo(0.002, 4);
  });

  it("interno sms still reports 0.059 for a signed-in non-superadmin caller", async () => {
    // billing_report_unit_price is a plain numeric, used internally for
    // reports (margin math); unlike billing_effective_price it never redacts
    // provider_unit_cost, regardless of who is asking.
    await db.exec(`set test.uid = '${NORMAL}'; set test.super = 'off';`);
    try {
      expect(await reportPrice(INTERNO, "sms")).toBeCloseTo(0.059, 4);
    } finally {
      await resetSession();
    }
  });
});

describe("admin_* RPCs require superadmin", () => {
  it("admin_set_price without superadmin throws forbidden", async () => {
    await expect(
      db.query("select public.admin_set_price($1, $2)", ["sms", 0.1]),
    ).rejects.toThrow(/forbidden/);
  });

  it("admin_set_tenant_price without superadmin throws forbidden", async () => {
    await expect(
      db.query("select public.admin_set_tenant_price($1, $2, $3)", [NORMAL, "sms", 0.1]),
    ).rejects.toThrow(/forbidden/);
  });

  it("admin_clear_tenant_price without superadmin throws forbidden", async () => {
    await expect(
      db.query("select public.admin_clear_tenant_price($1, $2)", [NORMAL, "sms"]),
    ).rejects.toThrow(/forbidden/);
  });

  it("admin_clear_tenant_price makes the price fall back to default", async () => {
    await db.exec("set test.super = 'on'");
    try {
      await db.query("select public.admin_clear_tenant_price($1, $2)", [NORMAL, "sms"]);
      const v = await effectivePrice(NORMAL, "sms");
      expect(v).toMatchObject({ source: "default" });
    } finally {
      await db.exec("set test.super = 'off'");
    }
  });
});

describe("tenants_plan_guard", () => {
  it("blocks a plano change without superadmin or service_role", async () => {
    await expect(
      db.query(`update public.tenants set plano = 'interno' where id = '${NORMAL}'`),
    ).rejects.toThrow(/forbidden/);
  });

  it("allows the change when test.super is on", async () => {
    await db.exec("set test.super = 'on'");
    try {
      await expect(
        db.query(`update public.tenants set plano = 'interno' where id = '${NORMAL}'`),
      ).resolves.toBeDefined();
      await db.query(`update public.tenants set plano = 'starter' where id = '${NORMAL}'`);
    } finally {
      await db.exec("set test.super = 'off'");
    }
  });

  it("allows the change when test.role is service_role (not super admin)", async () => {
    await db.exec("set test.role = 'service_role'");
    try {
      await expect(
        db.query(`update public.tenants set plano = 'interno' where id = '${NORMAL}'`),
      ).resolves.toBeDefined();
      await db.query(`update public.tenants set plano = 'starter' where id = '${NORMAL}'`);
    } finally {
      await db.exec("set test.role = ''");
    }
  });
});
