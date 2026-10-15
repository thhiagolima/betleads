// SEC-01 — access matrix: CON-08 state × 20261015100000_fix_rls_privilege_escalation.sql.
//
//   node supabase/tests/rls/sec01-matrix.mjs          (from the repo root)
//   SEC01_TABLES=user_roles,deposits node supabase/tests/rls/sec01-matrix.mjs   (subset)
//
// Same harness as con08-matrix.mjs (PGlite, production helper functions verbatim, production
// grants/RLS flags from prod_snapshot_2026-10-14.json, Supabase-identical auth.uid() stubs,
// one rolled-back transaction per operation under SET LOCAL ROLE). Phases:
//
//   A = production policies (before_policies.sql) + CON-08 migration   (the baseline)
//   B = A + SEC-01 migration
//   C = B + SEC-01 again                                                (idempotency)
//   D = C + rollback_20261015100000.sql                                 (must equal A)
//
// Every difference A → B is classified against the INTENDED restrictions below. The script
// fails (exit 1) on any unexpected difference, any widening other than "a user reads their own
// user_roles rows", any difference on a non-target table, B ≠ C, or A ≠ D.
//
// Also checks: no difference at all (raw) on WhatsApp tables; EXECUTE of the SEC-01 functions
// (stubs with the production ACLs of prod_acl_2026-10-15.json) after SEC-01 and after rollback.
//
// Extra operation vs CON-08: SELECT_SECRET (reads the secret column) on tables that hold
// credentials. The harness tables get those secret columns so the column grants are exercised.
//
// Outputs (next to this file):
//   sec01-matrix-result.json   summary, every A → B difference with its classification
//   sec01-access-matrix.tsv    target tables: one line per table × persona × header, A and B
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const snap = JSON.parse(readFileSync(resolve(here, "prod_snapshot_2026-10-14.json"), "utf8"));
const BEFORE = readFileSync(resolve(here, "before_policies.sql"), "utf8");
const CON08 = readFileSync(resolve(root, "supabase/migrations/20261015090000_consolidate_tenant_rls.sql"), "utf8");
const SEC01 = readFileSync(resolve(root, "supabase/migrations/20261015100000_fix_rls_privilege_escalation.sql"), "utf8");
const ROLLBACK = readFileSync(resolve(here, "rollback_20261015100000.sql"), "utf8");

const ONLY = process.env.SEC01_TABLES ? new Set(process.env.SEC01_TABLES.split(",")) : null;

// ---------- intended changes ----------
// Lists come from sec01-generate.mjs (the same lists that produced the migration).
const TG = JSON.parse(readFileSync(resolve(here, "sec01-targets.json"), "utf8"));
const PROD_ACL = JSON.parse(readFileSync(resolve(here, "prod_acl_2026-10-15.json"), "utf8"));
const READONLY = new Set(TG.READONLY);
const SERVICE_ONLY = new Set(TG.SERVICEONLY);
const SA_ONLY = new Set(TG.SAONLY);
const MANAGER = new Set([...TG.MANAGER_CUR, ...TG.MANAGER_ACC]);
// secret columns added to the harness tables (SELECT_SECRET reads the first one).
// whatsapp_proxies is tested on purpose: it must NOT change (WhatsApp out of scope).
const SECRET_COLS = {
  call_providers: ["api_key", "api_secret", "headers_config"],
  webhook_configs: ["secret"],
  whatsapp_proxies: ["password_encrypted"],
  meta_connections: ["access_token"],
  email_smtp_configs: ["password_encrypted"],
};
const COLUMN_SECRET = new Set(TG.COLSECRET.map(([t]) => t));
const TARGETS = new Set([...READONLY, ...SERVICE_ONLY, ...SA_ONLY, ...COLUMN_SECRET, ...MANAGER, "user_roles"]);
const isWhatsapp = (t) => t.includes("whatsapp") || t === "antiban_settings";
// personas that are only `member` in tenant A (multi is admin of C): they lose config writes on A rows
const MEMBER_OF_A = new Set(["member_A", "multi_mA_aC"]);
const FN_ALL = [...TG.FN_CLIENT, ...TG.FN_SERVICE, "managed_tenant_ids()"];

// ---------- identities (same as con08-matrix.mjs) ----------
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
const ROWS = {
  A: { tenant: "A", status: "draft", active: true },
  A_sent: { tenant: "A", status: "sent", active: false },
  B: { tenant: "B", status: "draft", active: true },
  C: { tenant: "C", status: "draft", active: true },
  NULL: { tenant: null, status: "draft", active: true },
};
const rowId = (table, label) => {
  let h = 0;
  for (const ch of `${table}:${label}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `20000000-0000-4000-8000-${h.toString(16).padStart(12, "0")}`;
};
const ownRoles = (persona) =>
  MEMBERSHIPS.filter(([p]) => p === persona)
    .map(([p, role]) => `${p}:${role}`)
    .sort()
    .join(",") || "∅";

// ---------- schema ----------
const affected = [...new Set([...BEFORE.matchAll(/ON public\.(\w+)/g)].map((m) => m[1]))].sort();
const tables = ONLY ? affected.filter((t) => ONLY.has(t)) : affected;
const rls = Object.fromEntries(snap.rls.map((r) => [r.relname, r]));
const grants = {};
for (const g of snap.grants)
  (grants[g.table_name] ??= {})[g.grantee] = g.privs
    .split(",")
    .filter((p) => ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"].includes(p));

function aclGrants(fn) {
  const out = [`REVOKE ALL ON FUNCTION public.${fn.sig} FROM PUBLIC;`];
  for (const item of fn.acl.replace(/[{}]/g, "").split(",")) {
    const [who] = item.split("=");
    if (who === "postgres") continue;
    out.push(`GRANT EXECUTE ON FUNCTION public.${fn.sig} TO ${who === "" ? "PUBLIC" : who};`);
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
    const secret = (SECRET_COLS[t] ?? []).map((c) => `, ${c} text`).join("");
    ddl.push(`CREATE TABLE public.${t} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, status text, is_active boolean, created_by uuid${secret});
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
  const order = ["is_super_admin(uuid)", "has_tenant_access(uuid,uuid)", "current_tenant_id()", "is_tenant_owner(uuid)", "is_tenant_admin(uuid)", "has_role(uuid,app_role)"];
  for (const sig of order) {
    const fn = snap.functions.find((f) => f.sig === sig);
    ddl.push(fn.def.trim().replace(/;?\s*$/, ";"));
    ddl.push(aclGrants(fn));
  }
  await db.exec(ddl.join("\n"));

  const seed = [`INSERT INTO public.tenants (id, nome) VALUES ('${T.A}','A'),('${T.B}','B'),('${T.C}','C');`];
  for (const [p, role, ten] of MEMBERSHIPS)
    seed.push(`INSERT INTO public.user_roles (id, user_id, role, tenant_id) VALUES ('${rowId("user_roles", `${p}:${role}`)}','${U[p]}','${role}',${ten ? `'${T[ten]}'` : "NULL"});`);
  for (const t of affected) {
    if (t === "tenants" || t === "user_roles") continue;
    const sc = SECRET_COLS[t] ?? [];
    for (const [label, r] of Object.entries(ROWS))
      seed.push(
        `INSERT INTO public.${t} (id, tenant_id, status, is_active, created_by${sc.map((c) => `, ${c}`).join("")}) VALUES ('${rowId(t, label)}', ${r.tenant ? `'${T[r.tenant]}'` : "NULL"}, '${r.status}', ${r.active}, '${U.admin_A}'${sc.map(() => ", 's3cr3t'").join("")});`,
      );
  }
  await db.exec(seed.join("\n"));
  return db;
}

// ---------- operations (con08-matrix.mjs + SELECT_SECRET) ----------
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
  const visible = (rows) => rows.map((r) => lbl[r.id]).sort().join(",") || "∅";
  ops.push({ k: "SELECT", sql: `select id::text from public.${t}`, map: visible });
  if (SECRET_COLS[t]) ops.push({ k: "SELECT_SECRET", sql: `select id::text, ${SECRET_COLS[t][0]} from public.${t}`, map: visible });
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
  for (const t of tables)
    for (const persona of PERSONAS)
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
  return out;
}

async function privileges(db) {
  const r = await db.query(`
    select c.relname t,
      has_table_privilege('anon', c.oid, 'INSERT') or has_table_privilege('anon', c.oid, 'UPDATE')
        or has_table_privilege('anon', c.oid, 'DELETE') anon_write,
      has_table_privilege('anon', c.oid, 'TRUNCATE') anon_truncate,
      has_table_privilege('authenticated', c.oid, 'TRUNCATE') auth_truncate
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' order by 1`);
  const count = (rows, k) => rows.filter((x) => x[k]).length;
  const wa = r.rows.filter((x) => isWhatsapp(x.t));
  const rest = r.rows.filter((x) => !isWhatsapp(x.t));
  const f = {};
  for (const sig of FN_ALL) {
    const q = await db.query(
      `select to_regprocedure($1) is not null as ok,
         case when to_regprocedure($1) is null then null else has_function_privilege('anon', to_regprocedure($1), 'EXECUTE') end anon,
         case when to_regprocedure($1) is null then null else has_function_privilege('authenticated', to_regprocedure($1), 'EXECUTE') end auth,
         case when to_regprocedure($1) is null then null else has_function_privilege('service_role', to_regprocedure($1), 'EXECUTE') end svc,
         case when to_regprocedure($1) is null then null else exists (
           select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
           where p.oid = to_regprocedure($1) and a.grantee = 0 and a.privilege_type = 'EXECUTE') end pub`,
      [`public.${sig}`],
    );
    const x = q.rows[0];
    f[sig] = x.ok ? `PUBLIC:${x.pub ? 1 : 0} anon:${x.anon ? 1 : 0} auth:${x.auth ? 1 : 0} svc:${x.svc ? 1 : 0}` : "absent";
  }
  return {
    tables: rest.length,
    anon_write: count(rest, "anon_write"),
    anon_truncate: count(rest, "anon_truncate"),
    auth_truncate: count(rest, "auth_truncate"),
    whatsapp_tables: wa.length,
    whatsapp_anon_write: count(wa, "anon_write"),
    whatsapp_anon_truncate: count(wa, "anon_truncate"),
    whatsapp_auth_truncate: count(wa, "auth_truncate"),
    functions: f,
  };
}

// production EXECUTE ACLs of the functions SEC-01 touches (stubs; body irrelevant)
async function createFunctionStubs(db) {
  const sql = [];
  for (const fn of PROD_ACL.functions) {
    if (!FN_ALL.includes(fn.sig) || fn.sig === "managed_tenant_ids()") continue;
    const exists = (await db.query(`select to_regprocedure($1) is not null ok`, [`public.${fn.sig}`])).rows[0].ok;
    if (!exists) sql.push(`CREATE FUNCTION public.${fn.sig} RETURNS void LANGUAGE sql AS $$ $$;`);
    sql.push(`REVOKE ALL ON FUNCTION public.${fn.sig} FROM PUBLIC, anon, authenticated, service_role;`);
    for (const item of fn.acl.split(",")) {
      const [who] = item.split("=");
      sql.push(`GRANT EXECUTE ON FUNCTION public.${fn.sig} TO ${who === "" ? "PUBLIC" : who};`);
    }
  }
  await db.exec(sql.join("\n"));
}

const normv = (v) => (v === "0" || v === "∅" || v === "ERR:42501" ? "deny" : v);
const isDeny = (v) => normv(v) === "deny";
const subsetOf = (a, b) => {
  if (isDeny(a)) return true;
  if (isDeny(b)) return false;
  const B = new Set(b.split(","));
  return a.split(",").every((x) => B.has(x));
};

function diff(a, b, raw = false) {
  const d = [];
  for (const key of Object.keys(a))
    for (const op of Object.keys(a[key])) {
      const x = a[key][op];
      const y = b[key]?.[op];
      if (raw ? x !== y : normv(x) !== normv(y)) d.push({ key, op, before: x, after: y });
    }
  return d;
}

// Returns the reason a difference is intended, or null.
function classify({ key, op, before, after }) {
  const [t, persona] = key.split("|");
  if (persona === "anon") return null; // anon had no effective access before; nothing may change
  const sa = persona === "super_admin";
  const restriction = op === "SELECT" || op === "SELECT_SECRET" ? subsetOf(after, before) : isDeny(after);
  if (READONLY.has(t) && !sa && !op.startsWith("SELECT") && isDeny(after)) return "F1 tenant write removed";
  if (t === "user_roles" && !sa) {
    if (op === "SELECT" && after === ownRoles(persona)) return subsetOf(after, before) ? "F2 select limited to own rows" : "F2 select = own rows (own admin row now visible)";
    if (op !== "SELECT" && isDeny(after)) return "F2 tenant write removed";
  }
  if (SERVICE_ONLY.has(t) && isDeny(after)) return "F3 service-only (no client access)";
  if (SA_ONLY.has(t) && !sa && restriction && isDeny(after)) return "F3 super-admin-only";
  if (COLUMN_SECRET.has(t) && op === "SELECT_SECRET" && isDeny(after)) return "F3 secret column hidden";
  if (MANAGER.has(t) && MEMBER_OF_A.has(persona) && !op.startsWith("SELECT") && /:(A|A_sent|A_by_other)$|^MOVE_/.test(op) && isDeny(after))
    return "CFG member write on config removed (admin/gestor keep)";
  return null;
}

// ---------- run ----------
const t0 = Date.now();
const log = (m) => console.log(`${m} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
const db = await buildDb();
await db.exec(BEFORE);
await db.exec(CON08);
await createFunctionStubs(db);
log(`schema ready: ${affected.length} tables (${tables.length} under test), CON-08 applied`);
const privA = await privileges(db);
const A = await matrix(db);
log(`A (CON-08): ${Object.keys(A).length} cells`);
await db.exec(SEC01);
const privB = await privileges(db);
const B = await matrix(db);
log(`B (SEC-01): ${Object.keys(B).length} cells`);
await db.exec(SEC01);
const C = await matrix(db);
log("C (SEC-01 re-applied)");
await db.exec(ROLLBACK);
const privD = await privileges(db);
const D = await matrix(db);
log("D (rollback)");

const dAB = diff(A, B).map((d) => ({ ...d, reason: classify(d) }));
const unexpected = dAB.filter((d) => !d.reason);
const widenings = dAB.filter((d) => !(d.op.startsWith("SELECT") ? subsetOf(d.after, d.before) : isDeny(d.after)));
const unexpectedWidenings = widenings.filter((d) => d.reason !== "F2 select = own rows (own admin row now visible)");
const offTarget = dAB.filter((d) => !TARGETS.has(d.key.split("|")[0]));
const rawAB = diff(A, B, true);
const rawOffTargetNonAnon = rawAB.filter((d) => !TARGETS.has(d.key.split("|")[0]) && d.key.split("|")[1] !== "anon");
const rawWhatsapp = rawAB.filter((d) => isWhatsapp(d.key.split("|")[0]));
const dBC = diff(B, C, true);
// expected function EXECUTE after SEC-01
const fnUnexpected = [];
for (const sig of FN_ALL) {
  const want = TG.FN_SERVICE.includes(sig) ? "PUBLIC:0 anon:0 auth:0 svc:1" : "PUBLIC:0 anon:0 auth:1 svc:1";
  if (privB.functions[sig] !== want) fnUnexpected.push(`${sig}: ${privB.functions[sig]} (want ${want})`);
}
const fnRollback = FN_ALL.filter((sig) => sig !== "managed_tenant_ids()" && privA.functions[sig] !== privD.functions[sig]);
const privUnexpected = [];
if (privB.anon_write || privB.anon_truncate || privB.auth_truncate) privUnexpected.push("non-WhatsApp tables still writable/truncatable");
for (const k of ["whatsapp_anon_write", "whatsapp_anon_truncate", "whatsapp_auth_truncate"]) {
  if (privB[k] !== privA[k]) privUnexpected.push(`${k} changed`);
}
for (const k of ["anon_write", "anon_truncate", "auth_truncate", "whatsapp_anon_write", "whatsapp_anon_truncate", "whatsapp_auth_truncate"])
  if (privD[k] !== privA[k]) privUnexpected.push(`rollback ${k}`);
const dAD = diff(A, D, true);

const byReason = {};
const byTable = {};
for (const d of dAB) {
  byReason[d.reason ?? "UNEXPECTED"] = (byReason[d.reason ?? "UNEXPECTED"] ?? 0) + 1;
  const [t, p] = d.key.split("|");
  ((byTable[t] ??= {})[p] ??= new Set()).add(d.op.replace(/:.*/, ""));
}
const rawAnon = rawAB.filter((d) => d.key.split("|")[1] === "anon");

const result = {
  generated_at: new Date().toISOString(),
  tables: tables.length,
  target_tables: [...TARGETS].filter((t) => tables.includes(t)).sort(),
  personas: PERSONAS,
  headers: Object.keys(HEADERS),
  cells: Object.keys(A).length,
  operations: Object.values(A).reduce((n, c) => n + Object.keys(c).length, 0),
  privileges: { con08: privA, sec01: privB, rollback: privD },
  differences_con08_vs_sec01: dAB.length,
  differences_by_reason: byReason,
  differences_by_table_persona: Object.fromEntries(
    Object.entries(byTable).map(([t, ps]) => [t, Object.fromEntries(Object.entries(ps).map(([p, s]) => [p, [...s].sort().join(",")]))]),
  ),
  unexpected_differences: unexpected.length,
  widenings: widenings.map((d) => `${d.key} ${d.op}: ${d.before} -> ${d.after}`),
  unexpected_widenings: unexpectedWidenings.length,
  differences_on_non_target_tables: offTarget.length,
  raw_differences_non_target_non_anon: rawOffTargetNonAnon.length,
  raw_differences_anon: rawAnon.length,
  raw_differences_anon_examples: rawAnon.slice(0, 5),
  raw_differences_whatsapp_tables: rawWhatsapp.length,
  function_privileges_unexpected: fnUnexpected,
  function_privileges_rollback_mismatch: fnRollback,
  table_privileges_unexpected: privUnexpected,
  differences_sec01_vs_reapply_raw: dBC.length,
  differences_con08_vs_rollback_raw: dAD.length,
  unexpected: unexpected.slice(0, 50),
  diff: dAB,
};
writeFileSync(resolve(here, ONLY ? "sec01-matrix-result.subset.json" : "sec01-matrix-result.json"), JSON.stringify(result, null, 1));

const summarize = (cell) => {
  const pick = (prefix) =>
    Object.entries(cell)
      .filter(([k, v]) => k.startsWith(prefix) && normv(v) !== "deny")
      .map(([k]) => k.slice(prefix.length))
      .join(",") || "-";
  return [cell.SELECT, cell.SELECT_SECRET ?? "", pick("INSERT:"), pick("UPDATE:"), pick("DELETE:"), pick("MOVE_"), pick("PROMOTE_GESTOR:"), pick("PROMOTE_ADMIN:")].join("\t");
};
const tsv = ["table\tpersona\theader\tphase\tselect_visible\tselect_secret_visible\tinsert_ok\tupdate_ok\tdelete_ok\tmove_ok\tpromote_gestor_ok\tpromote_admin_ok"];
for (const key of Object.keys(A)) {
  const [t, p, h] = key.split("|");
  if (!TARGETS.has(t)) continue;
  const a = summarize(A[key]);
  const b = summarize(B[key]);
  tsv.push(`${t}\t${p}\t${h}\tcon08\t${a}`);
  tsv.push(`${t}\t${p}\t${h}\t${a === b ? "sec01(=)" : "sec01(DIFF)"}\t${b}`);
}
if (!ONLY) writeFileSync(resolve(here, "sec01-access-matrix.tsv"), tsv.join("\n") + "\n");

const { diff: _d, unexpected: _u, ...summary } = result;
console.log(JSON.stringify({ ...summary, widenings: summary.widenings.slice(0, 20), unexpected: unexpected.slice(0, 20) }, null, 1));
log("total");
const fail = rawWhatsapp.length || fnUnexpected.length || fnRollback.length || privUnexpected.length || unexpected.length || unexpectedWidenings.length || offTarget.length || rawOffTargetNonAnon.length || dBC.length || dAD.length;
process.exit(fail ? 1 : 0);
