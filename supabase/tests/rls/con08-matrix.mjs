// CON-08 — access matrix BEFORE (production policies) × AFTER (migration) × ROLLBACK.
//
//   node supabase/tests/rls/con08-matrix.mjs          (from the repo root)
//
// Reproduces the policy-relevant schema of the 120 affected tables in an
// in-memory Postgres (PGlite): auth.uid()/auth.role() stubs identical to
// Supabase (they read request.jwt.claims), the production helper functions
// verbatim (from prod_snapshot_2026-10-14.json), the production table grants
// for anon/authenticated and the production RLS/FORCE flags.
//
// For every table × persona × x-active-tenant header it runs SELECT, INSERT
// (per target tenant), UPDATE (per row, plus "move row to tenant B") and
// DELETE (per row), each in its own rolled-back transaction, as role
// authenticated/anon exactly like PostgREST does. Then it diffs the matrices.
//
// Outputs (next to this file):
//   con08-access-matrix.tsv   one line per table × persona × header, before/after
//   con08-matrix-result.json  summary + every difference
//   con08-explain.txt         EXPLAIN ANALYZE of count(*) on players, before/after
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const snap = JSON.parse(readFileSync(resolve(here, "prod_snapshot_2026-10-14.json"), "utf8"));
const BEFORE = readFileSync(resolve(here, "before_policies.sql"), "utf8");
const MIGRATION = readFileSync(resolve(root, "supabase/migrations/20261015090000_consolidate_tenant_rls.sql"), "utf8");
const ROLLBACK = readFileSync(resolve(here, "rollback_20261015090000.sql"), "utf8");

const ONLY = process.env.CON08_TABLES ? new Set(process.env.CON08_TABLES.split(",")) : null;

// ---------- identities ----------
// Tenant ids are ordered A < B < C so current_tenant_id()'s fallback (ORDER BY tenant_id) is A for "multi".
const T = {
  A: "00000000-0000-4000-8000-00000000000a",
  B: "00000000-0000-4000-8000-00000000000b",
  C: "00000000-0000-4000-8000-00000000000c",
};
const U = {
  super_admin: "10000000-0000-4000-8000-000000000001",
  admin_A: "10000000-0000-4000-8000-000000000002",
  gestor_A: "10000000-0000-4000-8000-000000000003",
  member_A: "10000000-0000-4000-8000-000000000004",
  gestor_B: "10000000-0000-4000-8000-000000000005",
  admin_B: "10000000-0000-4000-8000-000000000006",
  multi_mA_aC: "10000000-0000-4000-8000-000000000007", // member of A + admin of C
  no_role: "10000000-0000-4000-8000-000000000008",
};
const NEW_USER = "10000000-0000-4000-8000-0000000000ff";
const MEMBERSHIPS = [
  ["super_admin", "super_admin", null],
  ["admin_A", "admin", "A"],
  ["gestor_A", "gestor", "A"],
  ["member_A", "member", "A"],
  ["gestor_B", "gestor", "B"],
  ["admin_B", "admin", "B"],
  ["multi_mA_aC", "member", "A"],
  ["multi_mA_aC", "admin", "C"],
];
const PERSONAS = [...Object.keys(U), "anon"];
const HEADERS = { none: null, hdr_A: T.A, hdr_B: T.B, hdr_C: T.C, hdr_garbage: "not-a-uuid" };

// generic rows (tables with tenant_id)
const ROWS = {
  A: { tenant: "A", status: "draft", active: true },
  A_sent: { tenant: "A", status: "sent", active: false },
  B: { tenant: "B", status: "draft", active: true },
  C: { tenant: "C", status: "draft", active: true },
  NULL: { tenant: null, status: "draft", active: true },
};
const rowId = (table, label) => {
  // deterministic uuid per table/label
  let h = 0;
  for (const ch of `${table}:${label}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `20000000-0000-4000-8000-${h.toString(16).padStart(12, "0")}`;
};

// ---------- schema ----------
const affected = [...new Set([...BEFORE.matchAll(/ON public\.(\w+)/g)].map((m) => m[1]))].sort();
const tables = ONLY ? affected.filter((t) => ONLY.has(t)) : affected;
const rls = Object.fromEntries(snap.rls.map((r) => [r.relname, r]));
const grants = {};
for (const g of snap.grants) (grants[g.table_name] ??= {})[g.grantee] = g.privs.split(",").filter((p) => ["SELECT", "INSERT", "UPDATE", "DELETE"].includes(p));

function aclGrants(fn) {
  const sig = fn.sig;
  const out = [`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC;`];
  for (const item of fn.acl.replace(/[{}]/g, "").split(",")) {
    const [who] = item.split("=");
    if (who === "postgres") continue;
    out.push(`GRANT EXECUTE ON FUNCTION public.${sig} TO ${who === "" ? "PUBLIC" : who};`);
  }
  return out.join("\n");
}

async function buildDb() {
  const db = new PGlite();
  const ddl = [];
  ddl.push(`
    DO $$ BEGIN
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
      select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $f$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$
      select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text $f$;
    GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO anon, authenticated, service_role;
    CREATE TYPE public.app_role AS ENUM (${snap.app_role.map((r) => `'${r}'`).join(", ")});
    -- Supabase default privileges: new functions in public are executable by anon/authenticated.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
    CREATE TABLE public.tenants (id uuid PRIMARY KEY, nome text);
    CREATE TABLE public.user_roles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
      role public.app_role NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), tenant_id uuid);
    CREATE UNIQUE INDEX user_roles_user_tenant_role_uniq ON public.user_roles (user_id, COALESCE(tenant_id::text, 'GLOBAL'), role);
    CREATE UNIQUE INDEX user_roles_one_membership_per_tenant ON public.user_roles (user_id, tenant_id) WHERE tenant_id IS NOT NULL;
    CREATE UNIQUE INDEX user_roles_one_admin_per_tenant ON public.user_roles (tenant_id) WHERE role = 'admin';
  `);
  for (const t of affected) {
    if (t === "tenants" || t === "user_roles") continue;
    ddl.push(`CREATE TABLE public.${t} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, status text, is_active boolean, created_by uuid);
      CREATE INDEX ${t}_tenant_id_idx ON public.${t} (tenant_id);`);
  }
  for (const t of affected) {
    ddl.push(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`);
    if (rls[t]?.relforcerowsecurity) ddl.push(`ALTER TABLE public.${t} FORCE ROW LEVEL SECURITY;`);
    for (const role of ["anon", "authenticated"]) {
      const p = grants[t]?.[role] ?? [];
      if (p.length) ddl.push(`GRANT ${p.join(", ")} ON public.${t} TO ${role};`);
    }
    ddl.push(`GRANT ALL ON public.${t} TO service_role;`);
  }
  // production helper functions, verbatim; is_super_admin first (others depend on it).
  const order = ["is_super_admin(uuid)", "has_tenant_access(uuid,uuid)", "current_tenant_id()", "is_tenant_owner(uuid)", "is_tenant_admin(uuid)", "has_role(uuid,app_role)"];
  for (const sig of order) {
    const fn = snap.functions.find((f) => f.sig === sig);
    ddl.push(fn.def.trim().replace(/;?\s*$/, ";"));
    ddl.push(aclGrants(fn));
  }
  await db.exec(ddl.join("\n"));

  // seed
  const seed = [`INSERT INTO public.tenants (id, nome) VALUES ('${T.A}','A'),('${T.B}','B'),('${T.C}','C');`];
  for (const [p, role, ten] of MEMBERSHIPS)
    seed.push(`INSERT INTO public.user_roles (id, user_id, role, tenant_id) VALUES ('${rowId("user_roles", `${p}:${role}`)}','${U[p]}','${role}',${ten ? `'${T[ten]}'` : "NULL"});`);
  for (const t of affected) {
    if (t === "tenants" || t === "user_roles") continue;
    for (const [label, r] of Object.entries(ROWS))
      seed.push(
        `INSERT INTO public.${t} (id, tenant_id, status, is_active, created_by) VALUES ('${rowId(t, label)}', ${r.tenant ? `'${T[r.tenant]}'` : "NULL"}, '${r.status}', ${r.active}, '${U.admin_A}');`,
      );
  }
  await db.exec(seed.join("\n"));
  return db;
}

// ---------- operations ----------
function opsFor(t, uid) {
  const ops = [];
  if (t === "tenants") {
    const lbl = { [T.A]: "A", [T.B]: "B", [T.C]: "C" };
    ops.push({ k: "SELECT", sql: `select id::text from public.tenants order by 1`, map: (rows) => rows.map((r) => lbl[r.id]).join(",") || "∅" });
    ops.push({ k: "INSERT:new", sql: `insert into public.tenants (id, nome) values (gen_random_uuid(), 'X')` });
    for (const l of ["A", "B", "C"]) {
      ops.push({ k: `UPDATE:${l}`, sql: `update public.tenants set nome = nome where id = '${T[l]}'` });
      ops.push({ k: `DELETE:${l}`, sql: `delete from public.tenants where id = '${T[l]}'` });
    }
    return ops;
  }
  if (t === "user_roles") {
    const lbl = Object.fromEntries(MEMBERSHIPS.map(([p, role]) => [rowId("user_roles", `${p}:${role}`), `${p}:${role}`]));
    ops.push({ k: "SELECT", sql: `select id::text from public.user_roles order by 1`, map: (rows) => rows.map((r) => lbl[r.id]).sort().join(",") || "∅" });
    for (const role of ["member", "gestor", "admin", "super_admin"])
      for (const ten of ["A", "B", "C", "NULL"])
        ops.push({ k: `INSERT:${role}@${ten}`, sql: `insert into public.user_roles (user_id, role, tenant_id) values ('${NEW_USER}', '${role}', ${ten === "NULL" ? "NULL" : `'${T[ten]}'`})` });
    for (const [id, l] of Object.entries(lbl)) {
      ops.push({ k: `UPDATE:${l}`, sql: `update public.user_roles set role = role where id = '${id}'` });
      ops.push({ k: `PROMOTE_GESTOR:${l}`, sql: `update public.user_roles set role = 'gestor' where id = '${id}'` });
      ops.push({ k: `PROMOTE_ADMIN:${l}`, sql: `update public.user_roles set role = 'admin' where id = '${id}'` });
      ops.push({ k: `MOVE_B:${l}`, sql: `update public.user_roles set tenant_id = '${T.B}' where id = '${id}'` });
      ops.push({ k: `DELETE:${l}`, sql: `delete from public.user_roles where id = '${id}'` });
    }
    return ops;
  }
  const lbl = Object.fromEntries(Object.keys(ROWS).map((l) => [rowId(t, l), l]));
  ops.push({ k: "SELECT", sql: `select id::text from public.${t}`, map: (rows) => rows.map((r) => lbl[r.id]).sort().join(",") || "∅" });
  const self = uid ? `'${uid}'` : "NULL";
  for (const ten of ["A", "B", "C", "NULL"])
    ops.push({ k: `INSERT:${ten}`, sql: `insert into public.${t} (tenant_id, status, is_active, created_by) values (${ten === "NULL" ? "NULL" : `'${T[ten]}'`}, 'draft', true, ${self})` });
  ops.push({ k: "INSERT:A_by_other", sql: `insert into public.${t} (tenant_id, status, is_active, created_by) values ('${T.A}', 'draft', true, '${U.gestor_B}')` });
  for (const l of Object.keys(ROWS)) {
    const id = rowId(t, l);
    ops.push({ k: `UPDATE:${l}`, sql: `update public.${t} set status = status where id = '${id}'` });
    ops.push({ k: `DELETE:${l}`, sql: `delete from public.${t} where id = '${id}'` });
  }
  ops.push({ k: "MOVE_B:A", sql: `update public.${t} set tenant_id = '${T.B}' where id = '${rowId(t, "A")}'` });
  ops.push({ k: "MOVE_A:B", sql: `update public.${t} set tenant_id = '${T.A}' where id = '${rowId(t, "B")}'` });
  return ops;
}

async function runAs(db, persona, header, sql) {
  const role = persona === "anon" ? "anon" : "authenticated";
  const claims = persona === "anon" ? { role: "anon" } : { sub: U[persona], role: "authenticated" };
  const headers = header ? { "x-active-tenant": header } : {};
  await db.exec("BEGIN");
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true), set_config('request.headers', $2, true)`, [JSON.stringify(claims), JSON.stringify(headers)]);
    await db.exec(`SET LOCAL ROLE ${role}`);
    const r = await db.query(sql);
    return { rows: r.rows, affected: r.affectedRows ?? 0 };
  } catch (e) {
    return { err: e.code ?? "ERR" };
  } finally {
    await db.exec("ROLLBACK");
  }
}

async function matrix(db) {
  const out = {};
  for (const t of tables) {
    for (const persona of PERSONAS) {
      for (const [hname, hval] of Object.entries(HEADERS)) {
        if (persona === "anon" && hname !== "none" && hname !== "hdr_A") continue;
        const cell = {};
        for (const op of opsFor(t, persona === "anon" ? null : U[persona])) {
          const r = await runAs(db, persona, hval, op.sql);
          if (r.err) cell[op.k] = `ERR:${r.err}`;
          else if (op.map) cell[op.k] = op.map(r.rows);
          else cell[op.k] = r.affected > 0 ? "ok" : "0";
        }
        out[`${t}|${persona}|${hname}`] = cell;
      }
    }
  }
  return out;
}

// "deny" classes are equivalent: no row affected / RLS violation / no privilege.
const normv = (v) => (v === "0" || v === "∅" || v === "ERR:42501" ? "deny" : v);

function diff(a, b) {
  const d = [];
  for (const key of Object.keys(a))
    for (const op of Object.keys(a[key])) {
      const x = a[key][op];
      const y = b[key]?.[op];
      if (normv(x) !== normv(y)) d.push({ key, op, before: x, after: y });
    }
  return d;
}
function rawDiff(a, b) {
  let n = 0;
  for (const key of Object.keys(a)) for (const op of Object.keys(a[key])) if (a[key][op] !== b[key]?.[op]) n++;
  return n;
}

async function explain(db, label) {
  // 20k players in A, 10k in B (prod: largest tenant 20,698 rows).
  await db.exec(`
    DELETE FROM public.players WHERE id NOT IN ('${rowId("players", "A")}');
    INSERT INTO public.players (tenant_id, status) SELECT '${T.A}', 'x' FROM generate_series(1, 20000);
    INSERT INTO public.players (tenant_id, status) SELECT '${T.B}', 'x' FROM generate_series(1, 10000);
    ANALYZE public.players; ANALYZE public.user_roles;`);
  const lines = [`===== ${label} =====`];
  for (const [desc, sql] of [
    ["count(*) RLS only", "select count(*) from public.players"],
    ["count(*) with explicit tenant filter", `select count(*) from public.players where tenant_id = '${T.A}'`],
  ]) {
    for (const persona of ["member_A", "super_admin"]) {
      const r = await runAs(db, persona, T.A, `explain (analyze, costs off, timing on, summary on) ${sql}`);
      lines.push(`--- ${persona} (x-active-tenant=A): ${desc}`);
      lines.push(...(r.rows ?? []).map((x) => x["QUERY PLAN"]), r.err ? `ERR ${r.err}` : "");
      const c = await runAs(db, persona, T.A, sql);
      lines.push(`count = ${c.rows?.[0]?.count ?? c.err}`);
    }
  }
  return lines.join("\n");
}

// ---------- run ----------
const t0 = Date.now();
const db = await buildDb();
await db.exec(BEFORE);
console.log(`schema ready: ${affected.length} tables (${tables.length} under test)`);
const before = await matrix(db);
console.log(`before: ${Object.keys(before).length} cells (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
const explainBefore = ONLY ? "" : await explain(await withFresh("before"), "BEFORE (production policies)");
await db.exec(MIGRATION);
const after = await matrix(db);
console.log(`after: ${Object.keys(after).length} cells (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
await db.exec(MIGRATION); // idempotency: re-applying must succeed and change nothing
const again = await matrix(db);
await db.exec(ROLLBACK);
const rolledBack = await matrix(db);
const explainAfter = ONLY ? "" : await explain(await withFresh("after"), "AFTER (20261015090000_consolidate_tenant_rls)");

async function withFresh(phase) {
  const d = await buildDb();
  await d.exec(BEFORE);
  if (phase === "after") await d.exec(MIGRATION);
  return d;
}

const dAfter = diff(before, after);
const dAgain = diff(after, again);
const dRollback = diff(before, rolledBack);
const result = {
  generated_at: new Date().toISOString(),
  tables: tables.length,
  personas: PERSONAS,
  headers: Object.keys(HEADERS),
  cells: Object.keys(before).length,
  operations: Object.values(before).reduce((n, c) => n + Object.keys(c).length, 0),
  differences_before_vs_after: dAfter.length,
  raw_differences_before_vs_after: rawDiff(before, after),
  differences_after_vs_reapply: dAgain.length,
  differences_before_vs_rollback: dRollback.length,
  diff: dAfter,
  raw_examples: (() => {
    const ex = [];
    for (const key of Object.keys(before))
      for (const op of Object.keys(before[key])) if (before[key][op] !== after[key][op] && ex.length < 20) ex.push({ key, op, before: before[key][op], after: after[key][op] });
    return ex;
  })(),
};
writeFileSync(resolve(here, "con08-matrix-result.json"), JSON.stringify(result, null, 1));

// compact matrix: one line per table × persona × header
const summarize = (cell) => {
  const pick = (prefix) =>
    Object.entries(cell)
      .filter(([k, v]) => k.startsWith(prefix) && normv(v) !== "deny")
      .map(([k]) => k.slice(prefix.length))
      .join(",") || "-";
  return [cell.SELECT, pick("INSERT:"), pick("UPDATE:"), pick("DELETE:"), pick("MOVE_"), pick("PROMOTE_GESTOR:"), pick("PROMOTE_ADMIN:")].join("\t");
};
const tsv = ["table\tpersona\theader\tphase\tselect_visible\tinsert_ok\tupdate_ok\tdelete_ok\tmove_ok\tpromote_gestor_ok\tpromote_admin_ok"];
for (const key of Object.keys(before)) {
  const [t, p, h] = key.split("|");
  const b = summarize(before[key]);
  const a = summarize(after[key]);
  tsv.push(`${t}\t${p}\t${h}\tbefore\t${b}`);
  tsv.push(`${t}\t${p}\t${h}\t${a === b ? "after(=)" : "after(DIFF)"}\t${a}`);
}
if (!ONLY) {
  writeFileSync(resolve(here, "con08-access-matrix.tsv"), tsv.join("\n") + "\n");
  writeFileSync(resolve(here, "con08-explain.txt"), `${explainBefore}\n\n${explainAfter}\n`);
}

console.log(JSON.stringify({ ...result, diff: result.diff.slice(0, 20) }, null, 1));
console.log(`total ${((Date.now() - t0) / 1000).toFixed(0)} s`);
process.exit(dAfter.length || dAgain.length || dRollback.length ? 1 : 0);
