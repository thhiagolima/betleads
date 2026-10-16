// F0-12 / F0-14 — e-mail and SMS opt-out on the REAL migrations in PGlite:
//   20260622202326 (suppressed_emails + email_unsubscribe_tokens, original),
//   20261003123000 (sms_suppressions), 20261007020000 (channel_consents +
//   audit) and 20261017110000 (per-tenant normalized e-mail keys).
// The service code (email-deliverability, consent, channel-eligibility) runs
// unchanged against a thin supabase-js shim that turns the query builder into
// SQL, so an onConflict target that matches no constraint fails here exactly
// as it does in PostgREST (QA-01).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => ({ db: null as unknown as import("@electric-sql/pglite").PGlite }));

vi.mock("@/integrations/supabase/client.server", () => {
  type Filter = { sql: string; values: unknown[] };
  const ident = (name: string) => `"${name.replace(/"/g, "")}"`;

  function builder(table: string) {
    let op: "select" | "insert" | "upsert" | "delete" | "update" = "select";
    let columns = "*";
    let returning: string | null = null;
    let payload: Record<string, unknown>[] = [];
    let onConflict: string | null = null;
    const filters: Filter[] = [];
    let order: string | null = null;
    let limit: number | null = null;

    const addFilter = (column: string, sqlOp: string, value: unknown) => {
      if (sqlOp === "is") filters.push({ sql: `${ident(column)} is null`, values: [] });
      else filters.push({ sql: `${ident(column)} ${sqlOp} $?`, values: [value] });
    };

    function build(): { text: string; values: unknown[] } {
      const values: unknown[] = [];
      const bind = (sql: string, vals: unknown[]) =>
        sql.replace(/\$\?/g, () => {
          values.push(vals.shift());
          return `$${values.length}`;
        });
      const whereSql = () =>
        filters.length
          ? ` where ${filters.map((f) => bind(f.sql, [...f.values])).join(" and ")}`
          : "";
      const t = `public.${ident(table)}`;
      if (op === "select") {
        const where = whereSql();
        return {
          text: `select ${columns} from ${t}${where}${order ? ` order by ${order}` : ""}${
            limit != null ? ` limit ${limit}` : ""
          }`,
          values,
        };
      }
      if (op === "delete") return { text: `delete from ${t}${whereSql()} returning *`, values };
      if (op === "update") {
        const row = payload[0];
        const sets = Object.keys(row).map((k) => {
          values.push(row[k]);
          return `${ident(k)} = $${values.length}`;
        });
        const set = `update ${t} set ${sets.join(", ")}`;
        return { text: `${set}${whereSql()} returning *`, values };
      }
      const keys = Object.keys(payload[0]);
      const rows = payload.map(
        (row) =>
          `(${keys
            .map((k) => {
              values.push(row[k] ?? null);
              return `$${values.length}`;
            })
            .join(", ")})`,
      );
      let text = `insert into ${t} (${keys.map(ident).join(", ")}) values ${rows.join(", ")}`;
      if (op === "upsert") {
        const target = (onConflict ?? "id").split(",").map((c) => ident(c.trim()));
        const updates = keys.map((k) => `${ident(k)} = excluded.${ident(k)}`);
        text += ` on conflict (${target.join(", ")}) do update set ${updates.join(", ")}`;
      }
      return { text: `${text} returning ${returning ?? "*"}`, values };
    }

    async function run(mode: "many" | "maybe" | "single") {
      const { text, values } = build();
      try {
        const r = await pg.db.query<Record<string, unknown>>(text, values);
        if (mode === "many") return { data: r.rows, error: null };
        if (mode === "single" && r.rows.length !== 1)
          return { data: null, error: { message: `expected 1 row, got ${r.rows.length}` } };
        if (mode === "maybe" && r.rows.length > 1)
          return { data: null, error: { message: "multiple rows" } };
        return { data: r.rows[0] ?? null, error: null };
      } catch (error) {
        return { data: null, error: { message: (error as Error).message } };
      }
    }

    const b: any = {
      select(cols = "*") {
        if (op === "select") columns = cols;
        else returning = cols;
        return b;
      },
      insert(rows: Record<string, unknown> | Record<string, unknown>[]) {
        op = "insert";
        payload = Array.isArray(rows) ? rows : [rows];
        return b;
      },
      upsert(rows: Record<string, unknown> | Record<string, unknown>[], opts?: { onConflict?: string }) {
        op = "upsert";
        payload = Array.isArray(rows) ? rows : [rows];
        onConflict = opts?.onConflict ?? null;
        return b;
      },
      update(row: Record<string, unknown>) {
        op = "update";
        payload = [row];
        return b;
      },
      delete() {
        op = "delete";
        return b;
      },
      eq(column: string, value: unknown) {
        addFilter(column, "=", value);
        return b;
      },
      is(column: string) {
        addFilter(column, "is", null);
        return b;
      },
      ilike(column: string, value: unknown) {
        addFilter(column, "ilike", value);
        return b;
      },
      or(expr: string) {
        const parts = expr.split(",").map((p) => {
          const [column, o, ...rest] = p.split(".");
          const value = rest.join(".");
          if (o === "is") return `${ident(column)} is null`;
          return `${ident(column)} = '${value.replace(/'/g, "''")}'`;
        });
        filters.push({ sql: `(${parts.join(" or ")})`, values: [] });
        return b;
      },
      order(column: string, opts?: { ascending?: boolean }) {
        order = `${ident(column)} ${opts?.ascending === false ? "desc" : "asc"}`;
        return b;
      },
      limit(n: number) {
        limit = n;
        return b;
      },
      maybeSingle: () => run("maybe"),
      single: () => run("single"),
      then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
        return run("many").then(resolve, reject);
      },
    };
    return b;
  }

  return { supabaseAdmin: { from: (table: string) => builder(table) } };
});

import { channelEligibility } from "./channel-eligibility.server";
import { syncLegacySuppression } from "./consent.server";
import {
  __resetSuppressionCacheForTests,
  getOrCreateUnsubscribeToken,
  isSuppressed,
  suppressEmail,
} from "./email-deliverability.server";

const root = resolve(__dirname, "../..");
const migration = (name: string) =>
  readFileSync(resolve(root, "supabase/migrations", name), "utf8");

const TENANT_A = "00000000-0000-4000-8000-00000000000a";
const TENANT_B = "00000000-0000-4000-8000-00000000000b";

const PREREQS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create table public.tenants (id uuid primary key);
insert into public.tenants values ('${TENANT_A}'), ('${TENANT_B}');
create function public.is_super_admin() returns boolean language sql as $$ select false $$;
create function public.has_tenant_access(_tenant uuid) returns boolean language sql as $$ select false $$;
create function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
`;

async function count(sql: string, values: unknown[] = []) {
  const r = await pg.db.query<{ n: number }>(`select count(*)::int as n from ${sql}`, values);
  return r.rows[0].n;
}

describe("e-mail / SMS opt-out on the real migrations (F0-12, F0-14)", () => {
  beforeAll(async () => {
    pg.db = new PGlite();
    await pg.db.exec(PREREQS);
    await pg.db.exec(migration("20260622202326_1cdfe818-9da9-458f-b0c3-9f802f3ed36e.sql"));
    await pg.db.exec(migration("20261003123000_create_sms_suppressions.sql"));
    await pg.db.exec(migration("20261007020000_create_channel_consents.sql"));
    // Legacy rows the old global lower(email) index allowed but that collapse
    // once the address is trimmed: the migration must keep one and back up the
    // other, never lose the suppression.
    await pg.db.exec(`
      insert into public.suppressed_emails (email, reason, tenant_id, created_at) values
        ('Legacy@Example.com', 'unsubscribe', '${TENANT_A}', '2026-01-01'),
        (' legacy@example.com ', 'manual', '${TENANT_A}', '2026-02-01'),
        (' Other@Example.com', 'complaint', '${TENANT_B}', '2026-01-01');
      insert into public.email_unsubscribe_tokens (token, email, tenant_id) values
        ('legacytoken000001', ' Shared@Example.com ', '${TENANT_A}');
    `);
    await pg.db.exec(migration("20261017110000_suppressed_emails_per_tenant.sql"));
  });

  afterAll(async () => {
    await pg.db?.close();
  });

  it("migration dedupes legacy rows into the backup and normalizes e-mails", async () => {
    const rows = await pg.db.query<{ email: string; reason: string; tenant_id: string }>(
      "select email, reason, tenant_id from public.suppressed_emails order by email",
    );
    expect(rows.rows).toEqual([
      { email: "legacy@example.com", reason: "unsubscribe", tenant_id: TENANT_A },
      { email: "other@example.com", reason: "complaint", tenant_id: TENANT_B },
    ]);
    const backup = await pg.db.query<{ email: string }>(
      "select email from public.suppressed_emails_dedupe_backup",
    );
    expect(backup.rows).toEqual([{ email: " legacy@example.com " }]);
    const token = await pg.db.query<{ email: string }>(
      "select email from public.email_unsubscribe_tokens where token = 'legacytoken000001'",
    );
    expect(token.rows[0].email).toBe("shared@example.com");
  });

  it("unsubscribe persists, is audited without error and blocks the next send", async () => {
    __resetSuppressionCacheForTests();
    await suppressEmail("  Jo_ao@Example.com ", "unsubscribe", TENANT_A, "link");

    expect(
      await count("public.suppressed_emails where tenant_id = $1 and email = $2", [
        TENANT_A,
        "jo_ao@example.com",
      ]),
    ).toBe(1);
    const consent = await pg.db.query<{ status: string }>(
      "select status from public.channel_consents where tenant_id = $1 and channel = 'email' and subject = $2",
      [TENANT_A, "jo_ao@example.com"],
    );
    expect(consent.rows).toEqual([{ status: "revoked" }]);
    const audit = await pg.db.query<{ new_status: string; consent_id: string | null }>(
      "select new_status, consent_id from public.channel_consent_audit where tenant_id = $1 and subject = $2",
      [TENANT_A, "jo_ao@example.com"],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].new_status).toBe("revoked");
    expect(audit.rows[0].consent_id).not.toBeNull();

    // Fresh process (no cache): the database answer alone blocks the send.
    __resetSuppressionCacheForTests();
    expect(await isSuppressed("JO_AO@example.com", TENANT_A)).toBe(true);
    const eligibility = await channelEligibility(
      "email",
      { telefone: null, email: "jo_ao@example.com" },
      TENANT_A,
    );
    expect(eligibility).toMatchObject({ eligible: false, reason: "email_opt_out" });
  });

  it("an unsubscribe in tenant A does not affect tenant B, and B can opt out too", async () => {
    __resetSuppressionCacheForTests();
    expect(await isSuppressed("jo_ao@example.com", TENANT_B)).toBe(false);
    expect(
      await channelEligibility("email", { telefone: null, email: "jo_ao@example.com" }, TENANT_B),
    ).toMatchObject({ eligible: true });

    await suppressEmail("jo_ao@example.com", "unsubscribe", TENANT_B);
    // Repeating it is an idempotent upsert, not an error.
    await suppressEmail("JO_AO@example.com", "complaint", TENANT_A);
    expect(await count("public.suppressed_emails where email = 'jo_ao@example.com'")).toBe(2);
  });

  it("compares exactly: '_' and '%' are not wildcards", async () => {
    __resetSuppressionCacheForTests();
    expect(await isSuppressed("joXao@example.com", TENANT_A)).toBe(false);
    expect(await isSuppressed("jo%@example.com", TENANT_A)).toBe(false);
  });

  it("global (tenant-less) suppression upserts once and applies to every tenant", async () => {
    __resetSuppressionCacheForTests();
    await suppressEmail("global@example.com", "bounce_hard", null);
    await suppressEmail("Global@example.com", "bounce_hard", null);
    expect(await count("public.suppressed_emails where email = 'global@example.com'")).toBe(1);
    expect(await isSuppressed("global@example.com", TENANT_B)).toBe(true);
  });

  it("operator revocation/grant via syncLegacySuppression writes and clears only its tenant", async () => {
    __resetSuppressionCacheForTests();
    await syncLegacySuppression(TENANT_A, "email", "Ops@Example.com", "revoked", "pedido", "operator");
    await syncLegacySuppression(TENANT_B, "email", "ops@example.com", "revoked", "pedido", "operator");
    await syncLegacySuppression(TENANT_A, "email", "ops@example.com", "revoked", "de novo", "operator");
    expect(await count("public.suppressed_emails where email = 'ops@example.com'")).toBe(2);

    await syncLegacySuppression(TENANT_A, "email", "ops@example.com", "granted", "voltou", "operator");
    __resetSuppressionCacheForTests();
    expect(await isSuppressed("ops@example.com", TENANT_A)).toBe(false);
    expect(await isSuppressed("ops@example.com", TENANT_B)).toBe(true);
  });

  it("unsubscribe tokens are per (tenant, e-mail) and stable", async () => {
    const a1 = await getOrCreateUnsubscribeToken("Shared@Example.com", TENANT_A);
    const a2 = await getOrCreateUnsubscribeToken("shared@example.com", TENANT_A);
    const b1 = await getOrCreateUnsubscribeToken("shared@example.com", TENANT_B);
    expect(a1).toBe("legacytoken000001");
    expect(a2).toBe(a1);
    expect(b1).toBeTruthy();
    expect(b1).not.toBe(a1);
    const owner = await pg.db.query<{ tenant_id: string }>(
      "select tenant_id from public.email_unsubscribe_tokens where token = $1",
      [b1],
    );
    expect(owner.rows[0].tenant_id).toBe(TENANT_B);
  });

  it("SMS suppression (digits-only table) blocks a '+55' number (F0-14)", async () => {
    await syncLegacySuppression(TENANT_A, "sms", "(21) 98019-4445", "revoked", "SAIR", "operator");
    const stored = await pg.db.query<{ phone: string }>(
      "select phone from public.sms_suppressions where tenant_id = $1",
      [TENANT_A],
    );
    expect(stored.rows).toEqual([{ phone: "5521980194445" }]);

    expect(
      await channelEligibility("sms", { telefone: "+55 21 98019-4445", email: null }, TENANT_A),
    ).toMatchObject({ eligible: false, reason: "sms_opt_out" });
    expect(
      await channelEligibility("sms", { telefone: "21980194445", email: null }, TENANT_B),
    ).toMatchObject({ eligible: true });
  });
});
