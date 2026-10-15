// SEC-01 — generates 20261015100000_fix_rls_privilege_escalation.sql, its rollback and
// sec01-targets.json (lists shared with sec01-matrix.mjs) from the decisions below and the
// read-only production ACL snapshot prod_acl_2026-10-15.json.
//
//   node supabase/tests/rls/sec01-generate.mjs
import fs from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const acl = JSON.parse(fs.readFileSync(`${ROOT}/supabase/tests/rls/prod_acl_2026-10-15.json`, "utf8"));

const SA = "(select public.is_super_admin())";
const CUR = "tenant_id = (select public.current_tenant_id())";
const ACC = "tenant_id = any ((select public.accessible_tenant_ids())::uuid[])";
const MNG = "tenant_id = any ((select public.managed_tenant_ids())::uuid[])";
const UID = "(select auth.uid())";
const READONLY = [
  "tenant_sms_credit_balances",
  "sms_credit_ledger",
  "sms_credit_orders",
  "tenant_sms_pricing",
  "deposits",
  "withdrawals",
  "tenant_audit_logs",
];
// config tables: writes only super admin or admin/gestor of the ACTIVE tenant
const MANAGER_CUR = ["automation_settings", "dashboard_settings", "webhook_configs"];
// config tables of the has_tenant_access family (any of my tenants): admin/gestor of that tenant
const MANAGER_ACC = ["shortio_settings"];
const SAONLY = ["call_providers", "email_senders", "email_smtp_configs"];
const SERVICEONLY = ["meta_connections", "meta_oauth_states", "email_unsubscribe_tokens"];
const COLSECRET = [
  ["call_providers", ["api_key", "api_secret", "headers_config"]],
  ["webhook_configs", ["secret"]],
];
// WhatsApp tables are out of scope by decision: F4 skips them too.
const WHATSAPP_EXCLUDE_SQL = `c.relname LIKE '%whatsapp%' OR c.relname = 'antiban_settings'`;
const isWhatsapp = (t) => t.includes("whatsapp") || t === "antiban_settings";

// functions: REVOKE FROM PUBLIC, anon; GRANT authenticated, service_role
const FN_CLIENT = [
  "admin_adjust_sms_credits(uuid,integer,text,text)",
  "admin_clear_tenant_sms_pricing(uuid)",
  "admin_list_users_with_usage(timestamp with time zone,timestamp with time zone)",
  "admin_mark_sms_credit_order_paid(uuid,text,text,jsonb)",
  "admin_platform_metrics(timestamp with time zone,timestamp with time zone)",
  "admin_set_sms_credit_settings(numeric,numeric,integer,integer)",
  "admin_set_tenant_sms_pricing(uuid,numeric,numeric)",
  "admin_sms_credit_overview()",
  "apply_sms_credit_mutation(uuid,integer,text,text,text,text,text,jsonb,uuid)",
  "create_sms_credit_checkout(uuid,uuid,integer)",
  "dashboard_totals(uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone)",
  "get_my_webhook_token(uuid)",
  "get_tenant_webhook_token(uuid)",
  "get_webhook_config_secret(uuid)",
  "is_tenant_admin(uuid)",
  "refund_sms_credits(uuid,integer,text,text,text,text)",
  "reserve_sms_credits(uuid,integer,text,text,text)",
  "sms_credit_summary(uuid)",
  "sms_effective_pricing(uuid)",
];
// no auth check inside, called only with service_role: REVOKE also from authenticated
const FN_SERVICE = ["claim_due_sms_campaigns(integer)", "recover_stuck_sms_campaigns()"];

const fnAcl = Object.fromEntries(acl.functions.map((f) => [f.sig, f.acl]));
for (const s of [...FN_CLIENT, ...FN_SERVICE]) if (!fnAcl[s]) throw new Error(`function not in prod snapshot: ${s}`);
const fnHolders = (s) =>
  fnAcl[s]
    .split(",")
    .map((e) => e.split("=")[0])
    .map((w) => (w === "" ? "PUBLIC" : w));
const fq = (s) => `public.${s}`;

let m = `-- SEC-01 — intentional fix of the RLS/privilege findings F1–F4 (+F6) of CON-08
-- (docs/CON-08_RLS_REVISAO_SEGURANCA.md), with the decisions approved on 2026-10-15.
-- Applied AFTER 20261015090000_consolidate_tenant_rls.sql (aborts otherwise).
-- NOT APPLIED automatically — see docs/SEC-01_CORRECAO_PERMISSOES.md (flows checked, access
-- matrix, communication, rollback). Idempotent: every DROP/CREATE/GRANT/REVOKE can be re-run.
--
-- This migration CHANGES access on purpose; every difference is checked by
-- supabase/tests/rls/sec01-matrix.mjs (CON-08 state × SEC-01 × rollback).
--
--   F1  read-only for tenant users (writes: super admin; real writes run as service_role or
--       in SECURITY DEFINER RPCs): ${READONLY.join(", ")}.
--   F2  user_roles: SELECT own rows (or super admin); writes super admin only (team
--       management runs as service_role after server-side checks).
--   F3  service_role only: ${SERVICEONLY.join(", ")}.
--       super admin only: ${SAONLY.join(", ")}.
--       secret columns out of client SELECT: ${COLSECRET.map(([t, c]) => `${t}(${c.join(", ")})`).join(", ")}.
--   CFG config tables: INSERT/UPDATE/DELETE only super admin or admin/gestor of the tenant
--       (SELECT unchanged): ${[...MANAGER_CUR, ...MANAGER_ACC].join(", ")}.
--       Config tables that a member-reachable screen writes with the user JWT are NOT restricted
--       (send_window_settings, marketing_integrations, gamification_settings, ai_intents,
--       ai_synonyms, ai_training_examples, dispatch_pause_state) — see the doc, section 3.4.
--   F4  anon loses INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER and authenticated loses
--       TRUNCATE on every public table EXCEPT WhatsApp tables (*whatsapp*, antiban_settings).
--   F6  EXECUTE revoked from PUBLIC/anon on ${FN_CLIENT.length} SECURITY DEFINER functions (authenticated
--       and service_role keep it), and from authenticated too on ${FN_SERVICE.length} service-only functions.
--   WhatsApp tables are untouched by decision (pending, see the doc).
`;
m += `
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regprocedure('public.accessible_tenant_ids()') IS NULL THEN
    RAISE EXCEPTION 'SEC-01 requires 20261015090000_consolidate_tenant_rls.sql to be applied first';
  END IF;
END $$;

-- ============================================================
-- 0) helper: tenants where the caller is admin or gestor
-- ============================================================
CREATE OR REPLACE FUNCTION public.managed_tenant_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(array_agg(DISTINCT ur.tenant_id), '{}'::uuid[])
  FROM public.user_roles ur
  WHERE ur.user_id = auth.uid()
    AND ur.tenant_id IS NOT NULL
    AND ur.role IN ('admin', 'gestor')
$$;
REVOKE ALL ON FUNCTION public.managed_tenant_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.managed_tenant_ids() TO authenticated, service_role;

-- ============================================================
-- F1) billing / financial tables: tenant users read, only super admin writes
-- ============================================================
`;
for (const t of READONLY) {
  m += `
DROP POLICY IF EXISTS ${t}_tenant_rls ON public.${t};
DROP POLICY IF EXISTS ${t}_tenant_select ON public.${t};
DROP POLICY IF EXISTS ${t}_super_admin_write ON public.${t};
CREATE POLICY ${t}_tenant_select ON public.${t}
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (${SA} OR ${CUR});
CREATE POLICY ${t}_super_admin_write ON public.${t}
  AS PERMISSIVE FOR ALL TO authenticated
  USING (${SA})
  WITH CHECK (${SA});
`;
}
m += `
-- ============================================================
-- F2) user_roles: read own memberships; only super admin writes
-- ============================================================
DROP POLICY IF EXISTS user_roles_tenant_rls ON public.user_roles;
DROP POLICY IF EXISTS user_roles_block_super_admin_escalation ON public.user_roles;
DROP POLICY IF EXISTS user_roles_block_tenant_admin_escalation ON public.user_roles;
DROP POLICY IF EXISTS user_roles_select_own ON public.user_roles;
DROP POLICY IF EXISTS user_roles_super_admin_write ON public.user_roles;
CREATE POLICY user_roles_select_own ON public.user_roles
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (${SA} OR user_id = ${UID});
CREATE POLICY user_roles_super_admin_write ON public.user_roles
  AS PERMISSIVE FOR ALL TO authenticated
  USING (${SA})
  WITH CHECK (${SA});

-- ============================================================
-- F3a) service-only tables (tokens, OAuth nonces): no client access
-- ============================================================
`;
for (const t of SERVICEONLY) {
  m += `DROP POLICY IF EXISTS ${t}_tenant_rls ON public.${t};
REVOKE ALL ON public.${t} FROM anon, authenticated;
GRANT ALL ON public.${t} TO service_role;
`;
}
m += `
-- ============================================================
-- F3b) platform configuration: super admin only
-- ============================================================
`;
for (const t of SAONLY) {
  m += `
DROP POLICY IF EXISTS ${t}_tenant_rls ON public.${t};
DROP POLICY IF EXISTS ${t}_super_admin_all ON public.${t};
CREATE POLICY ${t}_super_admin_all ON public.${t}
  AS PERMISSIVE FOR ALL TO authenticated
  USING (${SA})
  WITH CHECK (${SA});
`;
}
m += `
-- ============================================================
-- CFG) tenant configuration: everyone in the tenant reads, admin/gestor (or super admin) write
-- The write policy is FOR ALL; its USING is a subset of the select policy, so SELECT is unchanged.
-- ============================================================
`;
for (const t of MANAGER_CUR) {
  m += `
DROP POLICY IF EXISTS ${t}_tenant_rls ON public.${t};
DROP POLICY IF EXISTS ${t}_tenant_select ON public.${t};
DROP POLICY IF EXISTS ${t}_manager_write ON public.${t};
CREATE POLICY ${t}_tenant_select ON public.${t}
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (${SA} OR ${CUR});
CREATE POLICY ${t}_manager_write ON public.${t}
  AS PERMISSIVE FOR ALL TO authenticated
  USING (${SA} OR (${CUR} AND ${MNG}))
  WITH CHECK (${SA} OR (${CUR} AND ${MNG}));
`;
}
for (const t of MANAGER_ACC) {
  m += `
DROP POLICY IF EXISTS ${t}_tenant_rls ON public.${t};
DROP POLICY IF EXISTS ${t}_tenant_select ON public.${t};
DROP POLICY IF EXISTS ${t}_manager_write ON public.${t};
CREATE POLICY ${t}_tenant_select ON public.${t}
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (${SA} OR ${ACC});
CREATE POLICY ${t}_manager_write ON public.${t}
  AS PERMISSIVE FOR ALL TO authenticated
  USING (${SA} OR ${MNG})
  WITH CHECK (${SA} OR ${MNG});
`;
}
m += `
-- ============================================================
-- F3c) secret columns: SELECT granted per column, secrets excluded.
-- A table-level REVOKE also drops existing column grants; the column list is read from the
-- catalog, so the block is idempotent and picks up new columns. INSERT/UPDATE stay.
-- ============================================================
DO $$
DECLARE
  r record;
  cols text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
${COLSECRET.map(([t, c]) => `      ('${t}'::text, ARRAY[${c.map((x) => `'${x}'`).join(", ")}]::text[])`).join(",\n")}
    ) AS v(tbl, secret)
  LOOP
    EXECUTE format('REVOKE SELECT ON public.%I FROM anon, authenticated', r.tbl);
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum)
      INTO cols
      FROM pg_attribute a
     WHERE a.attrelid = format('public.%I', r.tbl)::regclass
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND a.attname <> ALL (r.secret);
    EXECUTE format('GRANT SELECT (%s) ON public.%I TO authenticated', cols, r.tbl);
  END LOOP;
END $$;

-- email_smtp_configs is super-admin-only after F3b; anon never needs to read it.
REVOKE SELECT ON public.email_smtp_configs FROM anon;

-- ============================================================
-- F4) anon: no write privileges; nobody: TRUNCATE (ignores RLS). WhatsApp tables skipped.
-- ============================================================
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND NOT (${WHATSAPP_EXCLUDE_SQL})
  LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.%I FROM anon', r.relname);
    EXECUTE format('REVOKE TRUNCATE ON public.%I FROM authenticated', r.relname);
  END LOOP;
END $$;
-- Tables created later by role postgres (migrations) no longer grant these to anon.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE TRUNCATE ON TABLES FROM authenticated;

-- ============================================================
-- F6) SECURITY DEFINER functions: no EXECUTE for PUBLIC/anon
-- (all verified to be called only by logged-in users or service_role; none is a trigger)
-- ============================================================
${FN_CLIENT.map((s) => `REVOKE EXECUTE ON FUNCTION ${fq(s)} FROM PUBLIC, anon;\nGRANT EXECUTE ON FUNCTION ${fq(s)} TO authenticated, service_role;`).join("\n")}
-- service-only (no caller check inside; used by the SMS dispatcher with service_role / pg_cron)
${FN_SERVICE.map((s) => `REVOKE EXECUTE ON FUNCTION ${fq(s)} FROM PUBLIC, anon, authenticated;\nGRANT EXECUTE ON FUNCTION ${fq(s)} TO service_role;`).join("\n")}

COMMIT;
`;
fs.writeFileSync(`${ROOT}/supabase/migrations/20261015100000_fix_rls_privilege_escalation.sql`, m);

// ---------------- rollback (back to the CON-08 / 2026-10-15 production state) ----------------
const conRls = (t, acc = false) => `CREATE POLICY ${t}_tenant_rls ON public.${t}
  AS PERMISSIVE FOR ALL TO authenticated
  USING (${SA} OR ${acc ? ACC : CUR})
  WITH CHECK (${SA} OR ${acc ? ACC : CUR});`;
const letters = { a: "INSERT", r: "SELECT", w: "UPDATE", d: "DELETE", D: "TRUNCATE", x: "REFERENCES", t: "TRIGGER" };
const privsOf = (aclStr, who) => {
  const e = aclStr.split(",").find((x) => x.startsWith(`${who}=`));
  if (!e) return [];
  return [...e.split("=")[1].split("/")[0]].map((c) => letters[c]).filter(Boolean);
};
const grantRows = [];
for (const { table, acl: a } of acl.tables) {
  if (isWhatsapp(table)) continue; // never touched by SEC-01
  for (const who of ["anon", "authenticated"]) {
    const p = privsOf(a, who);
    if (p.length) grantRows.push(`      ('${table}', '${who}', '${p.join(", ")}')`);
  }
}

let r = `-- ROLLBACK of 20261015100000_fix_rls_privilege_escalation.sql (SEC-01).
-- Restores the state left by CON-08 (20261015090000) as captured read-only in production on
-- 2026-10-15 (supabase/tests/rls/prod_acl_2026-10-15.json) — i.e. it REOPENS F1–F4/F6.
-- Use only if a legitimate flow broke and cannot be fixed forward. Checked by
-- supabase/tests/rls/sec01-matrix.mjs (rollback × CON-08 = 0 differences).
BEGIN;
SET LOCAL lock_timeout = '5s';
`;
for (const t of READONLY)
  r += `
DROP POLICY IF EXISTS ${t}_tenant_select ON public.${t};
DROP POLICY IF EXISTS ${t}_super_admin_write ON public.${t};
DROP POLICY IF EXISTS ${t}_tenant_rls ON public.${t};
${conRls(t)}
`;
r += `
DROP POLICY IF EXISTS user_roles_select_own ON public.user_roles;
DROP POLICY IF EXISTS user_roles_super_admin_write ON public.user_roles;
DROP POLICY IF EXISTS user_roles_tenant_rls ON public.user_roles;
DROP POLICY IF EXISTS user_roles_block_super_admin_escalation ON public.user_roles;
DROP POLICY IF EXISTS user_roles_block_tenant_admin_escalation ON public.user_roles;
${conRls("user_roles")}
CREATE POLICY user_roles_block_super_admin_escalation ON public.user_roles
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((role <> 'super_admin'::public.app_role) OR ${SA})
  WITH CHECK ((role <> 'super_admin'::public.app_role) OR ${SA});
CREATE POLICY user_roles_block_tenant_admin_escalation ON public.user_roles
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((role <> 'admin'::public.app_role) OR ${SA})
  WITH CHECK ((role <> 'admin'::public.app_role) OR ${SA});
`;
for (const t of SERVICEONLY)
  r += `
DROP POLICY IF EXISTS ${t}_tenant_rls ON public.${t};
${conRls(t)}
`;
for (const t of SAONLY)
  r += `
DROP POLICY IF EXISTS ${t}_super_admin_all ON public.${t};
DROP POLICY IF EXISTS ${t}_tenant_rls ON public.${t};
${conRls(t)}
`;
for (const t of [...MANAGER_CUR, ...MANAGER_ACC]) {
  const acc = MANAGER_ACC.includes(t);
  r += `
DROP POLICY IF EXISTS ${t}_tenant_select ON public.${t};
DROP POLICY IF EXISTS ${t}_manager_write ON public.${t};
DROP POLICY IF EXISTS ${t}_tenant_rls ON public.${t};
${conRls(t, acc)}
`;
}
r += `
-- managed_tenant_ids() is left in place (unused after rollback, harmless).

-- Table privileges of anon/authenticated exactly as before SEC-01 (production, 2026-10-15).
-- Tables that do not exist are skipped. Extra column-level SELECT grants left by SEC-01 on
-- call_providers/webhook_configs are covered by the table-level SELECT restored here.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
${grantRows.join(",\n")}
    ) AS v(tbl, grantee, privs)
  LOOP
    IF to_regclass(format('public.%I', r.tbl)) IS NOT NULL THEN
      EXECUTE format('GRANT %s ON public.%I TO %I', r.privs, r.tbl, r.grantee);
    END IF;
  END LOOP;
END $$;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT TRUNCATE ON TABLES TO authenticated;

-- Function EXECUTE exactly as before SEC-01.
${[...FN_CLIENT, ...FN_SERVICE]
  .map((s) => {
    const h = fnHolders(s).filter((w) => ["PUBLIC", "anon", "authenticated"].includes(w));
    return `GRANT EXECUTE ON FUNCTION ${fq(s)} TO ${h.join(", ")};`;
  })
  .join("\n")}
COMMIT;
`;
fs.writeFileSync(`${ROOT}/supabase/tests/rls/rollback_20261015100000.sql`, r);

// export the lists for the harness
fs.writeFileSync(
  `${ROOT}/supabase/tests/rls/sec01-targets.json`,
  JSON.stringify({ READONLY, MANAGER_CUR, MANAGER_ACC, SAONLY, SERVICEONLY, COLSECRET, FN_CLIENT, FN_SERVICE }, null, 1),
);
console.log("ok", grantRows.length, "grant rows");
