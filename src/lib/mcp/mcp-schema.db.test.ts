// SQL test for supabase/migrations/20261121100000_mcp_financeiro.sql: the base
// tables for the finance MCP server (access level, OAuth, previews, call log).
// RLS is enabled on every mcp_* table and only service_role gets privileges —
// later tasks read/write these only through supabaseAdmin.

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readMigration, SCHEMA } from "../billing/billing-db-test-support";

const MIGRATION = readMigration("supabase/migrations/20261121100000_mcp_financeiro.sql");

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  // As in Supabase, service_role bypasses RLS.
  await db.exec(`ALTER ROLE service_role BYPASSRLS`);
  await db.exec(MIGRATION);
  // Idempotent: a second run changes nothing and does not fail.
  await db.exec(MIGRATION);
  await db.exec(
    `insert into public.mcp_oauth_clients (id, client_name, redirect_uris)
     values ('client-1', 'Claude', array['https://claude.ai/callback'])`,
  );
});

afterAll(async () => {
  await db.close();
});

describe("mcp_* tables", () => {
  it("every mcp table has RLS enabled", async () => {
    const { rows } = await db.query(
      `select relname from pg_class
       where relname like 'mcp_%' and relkind = 'r' and not relrowsecurity`,
    );
    expect(rows).toEqual([]);
  });

  it("anon and authenticated have no privileges on mcp tables", async () => {
    const { rows } = await db.query<{ role: string; table_name: string; has_priv: boolean }>(
      `select r as role, t as table_name, has_table_privilege(r, t, 'select') as has_priv
       from unnest(array['anon', 'authenticated']) r
       cross join unnest(array['public.mcp_tokens', 'public.mcp_access', 'public.mcp_previews']) t`,
    );
    expect(rows.every((row) => row.has_priv === false)).toBe(true);
  });

  it("mcp_access.level only accepts read or write", async () => {
    await expect(
      db.query(
        `insert into public.mcp_access (user_id, level, granted_by)
         values (gen_random_uuid(), 'admin', gen_random_uuid())`,
      ),
    ).rejects.toThrow();
  });

  it("mcp_connections.id defaults to a generated uuid", async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into public.mcp_connections (user_id, client_id)
       values (gen_random_uuid(), 'client-1') returning id`,
    );
    expect(rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("mcp_tokens.connection_id cascades on delete", async () => {
    await db.query("BEGIN");
    try {
      const { rows } = await db.query<{ id: string }>(
        `insert into public.mcp_connections (user_id, client_id)
         values (gen_random_uuid(), 'client-1') returning id`,
      );
      await db.query(
        `insert into public.mcp_tokens (token_hash, connection_id, kind, expires_at)
         values ('hash-1', $1, 'access', now() + interval '1 hour')`,
        [rows[0].id],
      );
      await db.query(`delete from public.mcp_connections where id = $1`, [rows[0].id]);
      const { rows: tokenRows } = await db.query(
        `select 1 from public.mcp_tokens where token_hash = 'hash-1'`,
      );
      expect(tokenRows).toEqual([]);
    } finally {
      await db.query("ROLLBACK");
    }
  });

  it("mcp_call_log.connection_id is nullable (admin actions log without a connection)", async () => {
    await db.query("BEGIN");
    try {
      const { rows } = await db.query<{ id: string }>(
        `insert into public.mcp_call_log (user_id, connection_id, tool, ok, duration_ms)
         values (gen_random_uuid(), null, 'mes_da_casa', true, 42) returning id`,
      );
      expect(rows[0].id).toBeTruthy();
    } finally {
      await db.query("ROLLBACK");
    }
  });

  it("has the call_log indexes on (connection_id, created_at) and (user_id, tool, created_at)", async () => {
    const { rows } = await db.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where tablename = 'mcp_call_log'`,
    );
    const defs = rows.map((row) => row.indexdef);
    expect(defs.some((def) => /\(connection_id,\s*created_at\)/.test(def))).toBe(true);
    expect(defs.some((def) => /\(user_id,\s*tool,\s*created_at\)/.test(def))).toBe(true);
  });
});
