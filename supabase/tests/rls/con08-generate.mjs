// CON-08 — generates the RLS consolidation migration and its rollback from the
// read-only production snapshot (prod_snapshot_2026-10-14.json).
//
//   node supabase/tests/rls/con08-generate.mjs
//
// Every table whose policies call has_tenant_access / current_tenant_id /
// is_super_admin / is_tenant_owner / auth.uid() / user_roles is classified by
// its exact policy signature. An unknown signature aborts the generator: a new
// shape must be reviewed by hand (and added below) before it is rewritten.
//
// Outputs:
//   supabase/migrations/20261015090000_consolidate_tenant_rls.sql
//   supabase/tests/rls/before_policies.sql      (prod policies, used by the matrix test)
//   supabase/tests/rls/rollback_20261015090000.sql
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const snap = JSON.parse(readFileSync(resolve(here, "prod_snapshot_2026-10-14.json"), "utf8"));

const FN_RE = /has_tenant_access|current_tenant_id|is_super_admin|is_tenant_owner|is_tenant_admin|has_role|auth\.uid|user_roles/;
const touches = (p) => FN_RE.test(`${p.qual ?? ""} ${p.with_check ?? ""}`);

// ---------- expression building blocks (all InitPlans) ----------
const SA = "(select public.is_super_admin())";
const CUR = "tenant_id = (select public.current_tenant_id())";
const ACC = "tenant_id = any ((select public.accessible_tenant_ids())::uuid[])";
// NOTE: there is deliberately no "admin tenants" helper. The production policies
// that test EXISTS(user_roles … role = 'admin') run that subquery as the caller,
// so it is filtered by user_roles' own RLS, whose restrictive
// user_roles_block_tenant_admin_escalation hides every role='admin' row from
// non-super-admins. Net effect today: those policies admit super admins only
// (tenant admins are denied). Preserved as-is; see finding F5 in the doc.
const UID = "(select auth.uid())";
const or = (...xs) => `(${xs.join(" OR ")})`;

// ---------- signatures (normalized: "P|R ~ roles ~ cmd ~ qual ~ check") ----------
const L = {
  isoP: "P~{authenticated}~ALL~((tenant_id = current_tenant_id()) OR is_super_admin())~((tenant_id = current_tenant_id()) OR is_super_admin())",
  isoPpublic: "P~{public}~ALL~((tenant_id = current_tenant_id()) OR is_super_admin())~((tenant_id = current_tenant_id()) OR is_super_admin())",
  guardR: "R~{authenticated}~ALL~((tenant_id = current_tenant_id()) OR is_super_admin())~((tenant_id = current_tenant_id()) OR is_super_admin())",
  htaP: "P~{authenticated}~ALL~has_tenant_access(tenant_id)~has_tenant_access(tenant_id)",
  htaPpublic: "P~{public}~ALL~has_tenant_access(tenant_id)~has_tenant_access(tenant_id)",
  htaR: "R~{authenticated}~ALL~has_tenant_access(tenant_id)~has_tenant_access(tenant_id)",
  htaSel: "P~{authenticated}~SELECT~has_tenant_access(tenant_id)~",
  htaSelPublic: "P~{public}~SELECT~has_tenant_access(tenant_id)~",
  htaUpdPublic: "P~{public}~UPDATE~has_tenant_access(tenant_id)~has_tenant_access(tenant_id)",
  saAll: "P~{authenticated}~ALL~is_super_admin()~is_super_admin()",
  saSel: "P~{authenticated}~SELECT~is_super_admin()~",
  saOrCurSel: "P~{authenticated}~SELECT~(is_super_admin() OR (tenant_id = current_tenant_id()))~",
  curSel: "P~{authenticated}~SELECT~(tenant_id = current_tenant_id())~",
  curAll: "P~{authenticated}~ALL~(tenant_id = current_tenant_id())~(tenant_id = current_tenant_id())",
  falseSel: "P~{authenticated}~SELECT~false~",
  adminExistsSel:
    "P~{authenticated}~SELECT~(is_super_admin() OR (EXISTS ( SELECT 1 FROM user_roles ur WHERE ((ur.user_id = auth.uid()) AND (ur.tenant_id = T.tenant_id) AND (ur.role = 'admin'::app_role)))))~",
};
const sig = (...keys) => keys.map((k) => L[k]).sort().join("\n");

// plan(table) -> { create: [sql...], note }
const tenantRls = (t) => `CREATE POLICY ${t}_tenant_rls ON public.${t}`;
const P = {
  SA_OR_CUR_ALL: (t) => [
    `${tenantRls(t)}\n  AS PERMISSIVE FOR ALL TO authenticated\n  USING ${or(SA, CUR)}\n  WITH CHECK ${or(SA, CUR)};`,
  ],
  SA_OR_ACC_ALL: (t) => [
    `${tenantRls(t)}\n  AS PERMISSIVE FOR ALL TO authenticated\n  USING ${or(SA, ACC)}\n  WITH CHECK ${or(SA, ACC)};`,
  ],
  SA_OR_ACC_SELECT: (t) => [`${tenantRls(t)}\n  AS PERMISSIVE FOR SELECT TO authenticated\n  USING ${or(SA, ACC)};`],
  CUR_SELECT: (t) => [`${tenantRls(t)}\n  AS PERMISSIVE FOR SELECT TO authenticated\n  USING (${CUR});`],
  CUR_ALL: (t) => [`${tenantRls(t)}\n  AS PERMISSIVE FOR ALL TO authenticated\n  USING (${CUR})\n  WITH CHECK (${CUR});`],
  SA_SELECT: (t) => [`${tenantRls(t)}\n  AS PERMISSIVE FOR SELECT TO authenticated\n  USING (${SA});`],
  SA_ALL: (t) => [`${tenantRls(t)}\n  AS PERMISSIVE FOR ALL TO authenticated\n  USING (${SA})\n  WITH CHECK (${SA});`],
};

const GROUPS = [
  // Standard trio: P(cur OR sa) + P(has_tenant_access) + R(cur OR sa) => sa OR cur.
  { name: "trio", sig: sig("isoP", "htaP", "guardR"), plan: "SA_OR_CUR_ALL" },
  // "Super admin only" config tables that ALSO carry tenant_access_base: today any
  // member of the active tenant can read/write its rows (security finding F4).
  { name: "sa_cfg+base", sig: sig("htaP", "saAll", "saSel", "guardR"), plan: "SA_OR_CUR_ALL" },
  { name: "iso_only", sig: sig("isoP"), plan: "SA_OR_CUR_ALL" },
  { name: "hta_select", sig: sig("htaSel"), plan: "SA_OR_ACC_SELECT" },
  { name: "hta_P+R", sig: sig("htaP", "htaR"), plan: "SA_OR_ACC_ALL" },
  { name: "ai_catalog+base", sig: sig("htaP", "saAll", "saOrCurSel", "guardR"), plan: "SA_OR_CUR_ALL" },
  { name: "versions_cur_select", sig: sig("curSel"), plan: "CUR_SELECT" },
  { name: "hta_public+base", sig: sig("htaP", "htaPpublic", "guardR"), plan: "SA_OR_CUR_ALL" },
  { name: "hta_dup+base", sig: sig("htaP", "htaP", "guardR"), plan: "SA_OR_CUR_ALL" },
  { name: "hta_only", sig: sig("htaP"), plan: "SA_OR_ACC_ALL" },
  { name: "admin_exists_select", sig: sig("adminExistsSel"), plan: "SA_SELECT" }, // effective today: super admin only (F5),
  { name: "sa_select", sig: sig("saSel"), plan: "SA_SELECT" },
  { name: "cur_all", sig: sig("curAll"), plan: "CUR_ALL" },
  // meta_connections / meta_oauth_states: the "service_only" policy (auth.role()) is kept untouched.
  {
    name: "service_only+base",
    sig: [L.htaP, "P~{public}~ALL~(auth.role() = 'service_role'::text)~(auth.role() = 'service_role'::text)", L.guardR].sort().join("\n"),
    plan: "SA_OR_CUR_ALL",
  },
  { name: "hta_select_public", sig: sig("htaSelPublic"), plan: "SA_OR_ACC_SELECT" },
  { name: "hta_select+base", sig: sig("htaP", "htaSel", "guardR"), plan: "SA_OR_CUR_ALL" },
  { name: "credit+base", sig: sig("htaP", "saAll", "htaSel", "guardR"), plan: "SA_OR_CUR_ALL" },
  { name: "sa_all", sig: sig("saAll"), plan: "SA_ALL" },
  // cashback_payments: the restrictive block_client_* policies are kept untouched.
  {
    name: "cashback",
    sig: [
      L.htaP,
      L.htaSel,
      "R~{anon,authenticated}~DELETE~false~",
      "R~{anon,authenticated}~INSERT~~false",
      "R~{anon,authenticated}~UPDATE~false~false",
      L.guardR,
    ].sort().join("\n"),
    plan: "SA_OR_CUR_ALL",
  },
  // email_unsubscribe_tokens: "unsub_tokens_no_client_access" (USING false) is kept untouched.
  { name: "unsub", sig: sig("htaP", "falseSel", "guardR"), plan: "SA_OR_CUR_ALL" },
  { name: "meta_ad_accounts", sig: sig("htaP", "htaSelPublic", "htaUpdPublic", "guardR"), plan: "SA_OR_CUR_ALL" },
  { name: "sms_audiences", sig: sig("isoPpublic"), plan: "SA_OR_CUR_ALL" },
  {
    name: "suppressed_emails",
    sig: [
      L.htaP,
      "P~{authenticated}~DELETE~(is_super_admin() OR ((tenant_id IS NOT NULL) AND has_tenant_access(tenant_id)))~",
      "P~{authenticated}~INSERT~~(is_super_admin() OR ((tenant_id IS NOT NULL) AND has_tenant_access(tenant_id)))",
      "P~{authenticated}~SELECT~(is_super_admin() OR ((tenant_id IS NOT NULL) AND has_tenant_access(tenant_id)))~",
      "P~{authenticated}~UPDATE~(is_super_admin() OR ((tenant_id IS NOT NULL) AND has_tenant_access(tenant_id)))~(is_super_admin() OR ((tenant_id IS NOT NULL) AND has_tenant_access(tenant_id)))",
      L.guardR,
    ].sort().join("\n"),
    plan: "SA_OR_CUR_ALL",
  },
];

// Tables with bespoke per-command rules: rewritten by hand, same policy names.
const CUSTOM = {
  campaign_drafts: {
    expect: [
      "P~{authenticated}~DELETE~(has_tenant_access(tenant_id) AND (status = 'draft'::text))~",
      "P~{authenticated}~INSERT~~(has_tenant_access(tenant_id) AND (created_by = auth.uid()))",
      L.htaSel,
      "P~{authenticated}~UPDATE~(has_tenant_access(tenant_id) AND (status = 'draft'::text))~has_tenant_access(tenant_id)",
    ],
    create: [
      `CREATE POLICY campaign_drafts_tenant_select ON public.campaign_drafts\n  AS PERMISSIVE FOR SELECT TO authenticated\n  USING ${or(SA, ACC)};`,
      `CREATE POLICY campaign_drafts_tenant_insert ON public.campaign_drafts\n  AS PERMISSIVE FOR INSERT TO authenticated\n  WITH CHECK (${or(SA, ACC)} AND created_by = ${UID});`,
      `CREATE POLICY campaign_drafts_tenant_update ON public.campaign_drafts\n  AS PERMISSIVE FOR UPDATE TO authenticated\n  USING (${or(SA, ACC)} AND status = 'draft'::text)\n  WITH CHECK ${or(SA, ACC)};`,
      `CREATE POLICY campaign_drafts_tenant_delete ON public.campaign_drafts\n  AS PERMISSIVE FOR DELETE TO authenticated\n  USING (${or(SA, ACC)} AND status = 'draft'::text);`,
    ],
  },
  conversion_experiments: {
    expect: [
      "P~{authenticated}~DELETE~(is_super_admin() OR (EXISTS ( SELECT 1 FROM user_roles ur WHERE ((ur.user_id = auth.uid()) AND (ur.tenant_id = T.tenant_id) AND (ur.role = 'admin'::app_role)))))~",
      "P~{authenticated}~INSERT~~(is_super_admin() OR (EXISTS ( SELECT 1 FROM user_roles ur WHERE ((ur.user_id = auth.uid()) AND (ur.tenant_id = T.tenant_id) AND (ur.role = 'admin'::app_role)))))",
      L.htaSel,
      "P~{authenticated}~UPDATE~(is_super_admin() OR (EXISTS ( SELECT 1 FROM user_roles ur WHERE ((ur.user_id = auth.uid()) AND (ur.tenant_id = T.tenant_id) AND (ur.role = 'admin'::app_role)))))~has_tenant_access(tenant_id)",
    ],
    create: [
      `CREATE POLICY conversion_experiments_tenant_select ON public.conversion_experiments\n  AS PERMISSIVE FOR SELECT TO authenticated\n  USING ${or(SA, ACC)};`,
      // "admin" policies: effective today = super admin only (F5); kept that way.
      `CREATE POLICY conversion_experiments_admin_insert ON public.conversion_experiments\n  AS PERMISSIVE FOR INSERT TO authenticated\n  WITH CHECK (${SA});`,
      `CREATE POLICY conversion_experiments_admin_update ON public.conversion_experiments\n  AS PERMISSIVE FOR UPDATE TO authenticated\n  USING (${SA})\n  WITH CHECK ${or(SA, ACC)};`,
      `CREATE POLICY conversion_experiments_admin_delete ON public.conversion_experiments\n  AS PERMISSIVE FOR DELETE TO authenticated\n  USING (${SA});`,
    ],
  },
  platform_pricing: {
    // "anyone authed can read pricing" (USING true) does not touch the helpers and is kept.
    expect: [L.saAll, "P~{authenticated}~SELECT~true~"],
    create: [
      `CREATE POLICY "super admin manages pricing" ON public.platform_pricing\n  AS PERMISSIVE FOR ALL TO authenticated\n  USING (${SA})\n  WITH CHECK (${SA});`,
    ],
  },
  sms_credit_packages: {
    expect: [L.saAll, "P~{authenticated}~SELECT~(is_active OR is_super_admin())~"],
    create: [
      `CREATE POLICY sms_credit_packages_read_active ON public.sms_credit_packages\n  AS PERMISSIVE FOR SELECT TO authenticated\n  USING (is_active OR ${SA});`,
      `CREATE POLICY sms_credit_packages_super_write ON public.sms_credit_packages\n  AS PERMISSIVE FOR ALL TO authenticated\n  USING (${SA})\n  WITH CHECK (${SA});`,
    ],
  },
  sms_credit_settings: {
    expect: [L.saAll, L.saSel],
    create: P.SA_ALL("sms_credit_settings"),
  },
  tenants: {
    expect: [L.saAll, "P~{authenticated}~SELECT~has_tenant_access(id)~"],
    create: [
      `CREATE POLICY tenants_member_select_own ON public.tenants\n  AS PERMISSIVE FOR SELECT TO authenticated\n  USING (${SA} OR id = any ((select public.accessible_tenant_ids())::uuid[]));`,
      `CREATE POLICY tenants_super_admin_all ON public.tenants\n  AS PERMISSIVE FOR ALL TO authenticated\n  USING (${SA})\n  WITH CHECK (${SA});`,
    ],
  },
  user_roles: {
    // Effective today: sa OR (tenant_id = current_tenant_id() AND role NOT IN (admin, super_admin)).
    // The OWN/has_tenant_access/self-read permissive policies are all implied by the
    // restrictive guard (current_tenant_id() is always a tenant the user belongs to).
    expect: [
      "P~{authenticated}~ALL~((tenant_id IS NOT NULL) AND is_tenant_owner(tenant_id))~((tenant_id IS NOT NULL) AND is_tenant_owner(tenant_id))",
      L.htaP,
      L.saAll,
      "P~{authenticated}~SELECT~((user_id = auth.uid()) OR is_super_admin())~",
      "P~{authenticated}~SELECT~(auth.uid() = user_id)~",
      "R~{authenticated}~ALL~((role <> 'admin'::app_role) OR is_super_admin(auth.uid()))~((role <> 'admin'::app_role) OR is_super_admin(auth.uid()))",
      "R~{authenticated}~ALL~((role <> 'super_admin'::app_role) OR is_super_admin(auth.uid()))~((role <> 'super_admin'::app_role) OR is_super_admin(auth.uid()))",
      L.guardR,
    ],
    create: [
      ...P.SA_OR_CUR_ALL("user_roles"),
      `CREATE POLICY user_roles_block_super_admin_escalation ON public.user_roles\n  AS RESTRICTIVE FOR ALL TO authenticated\n  USING ((role <> 'super_admin'::public.app_role) OR ${SA})\n  WITH CHECK ((role <> 'super_admin'::public.app_role) OR ${SA});`,
      `CREATE POLICY user_roles_block_tenant_admin_escalation ON public.user_roles\n  AS RESTRICTIVE FOR ALL TO authenticated\n  USING ((role <> 'admin'::public.app_role) OR ${SA})\n  WITH CHECK ((role <> 'admin'::public.app_role) OR ${SA});`,
    ],
  },
};

// ---------- classify ----------
const byTable = new Map();
for (const p of snap.policies) {
  if (!byTable.has(p.tablename)) byTable.set(p.tablename, []);
  byTable.get(p.tablename).push(p);
}
const norm = (t, p) =>
  [p.permissive[0], p.roles, p.cmd, p.qual ?? "", p.with_check ?? ""]
    .join("~")
    .split(`${t}.`)
    .join("T.")
    .replace(/\s+/g, " ");

const plans = [];
const unknown = [];
for (const [t, ps] of [...byTable.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  if (!ps.some(touches)) continue;
  const lines = ps.map((p) => norm(t, p)).sort();
  if (CUSTOM[t]) {
    const exp = CUSTOM[t].expect.map((s) => s.replace(/\s+/g, " "));
    const touched = ps.filter(touches).map((p) => norm(t, p)).sort();
    if (JSON.stringify(touched) !== JSON.stringify([...exp].filter((s) => FN_RE.test(s)).sort())) {
      unknown.push({ t, lines });
      continue;
    }
    plans.push({ table: t, group: "custom", drop: ps.filter(touches), keep: ps.filter((p) => !touches(p)), create: CUSTOM[t].create });
    continue;
  }
  const s = lines.join("\n");
  const g = GROUPS.find((x) => x.sig === s);
  if (!g) {
    unknown.push({ t, lines });
    continue;
  }
  plans.push({ table: t, group: g.name, plan: g.plan, drop: ps.filter(touches), keep: ps.filter((p) => !touches(p)), create: P[g.plan](t) });
}
if (unknown.length) {
  console.error("UNKNOWN POLICY SHAPES — review by hand:\n" + unknown.map((u) => `${u.t}\n  ${u.lines.join("\n  ")}`).join("\n"));
  process.exit(1);
}

// ---------- SQL helpers ----------
const qi = (n) => (/^[a-z_][a-z0-9_]*$/.test(n) ? n : `"${n.replace(/"/g, '""')}"`);
const rolesSql = (r) =>
  r
    .replace(/[{}]/g, "")
    .split(",")
    .map((x) => (x === "public" ? "PUBLIC" : x))
    .join(", ");
const createOld = (p) => {
  let s = `CREATE POLICY ${qi(p.policyname)} ON public.${p.tablename}\n  AS ${p.permissive} FOR ${p.cmd} TO ${rolesSql(p.roles)}`;
  if (p.qual != null) s += `\n  USING (${p.qual})`;
  if (p.with_check != null) s += `\n  WITH CHECK (${p.with_check})`;
  return s + ";";
};
const newNames = (pl) => pl.create.map((c) => c.match(/CREATE POLICY ("[^"]+"|\S+) ON/)[1]);

// ---------- migration ----------
const tablesByPlan = {};
for (const pl of plans) (tablesByPlan[pl.plan ?? `custom:${pl.table}`] ??= []).push(pl.table);
const header = `-- CON-08 — RLS evaluated once per query, not once per row.
-- GENERATED by supabase/tests/rls/con08-generate.mjs from the read-only production
-- snapshot supabase/tests/rls/prod_snapshot_2026-10-14.json. Do not edit by hand:
-- edit the generator and re-run it. NOT APPLIED automatically — see
-- docs/CON-08_RLS_REVISAO_SEGURANCA.md (rollout, access matrix, rollback).
--
-- What it does
--   * new helper accessible_tenant_ids() (uuid[]; STABLE,
--     SECURITY DEFINER, search_path pinned, EXECUTE only for authenticated/service_role);
--   * pins search_path = public, pg_temp on the existing policy helpers;
--   * for each of the ${plans.length} tables below: drops every policy that calls the helpers and
--     recreates ONE policy per command (FOR ALL where USING = WITH CHECK) whose
--     function calls are wrapped in (select …) so they run once per statement as
--     InitPlans. Policies that do not call the helpers are left untouched.
--
-- Semantics are preserved exactly (proved by supabase/tests/rls/con08-matrix.mjs,
-- before × after access matrix, 0 differences). Key equivalences:
--   has_tenant_access(t)          == is_super_admin() OR t = ANY(accessible_tenant_ids())
--   P(cur OR sa) + P(hta) + R(cur OR sa)  ==  sa OR t = current_tenant_id()
--     (current_tenant_id() only returns a tenant the caller is a member of: the
--      x-active-tenant header is validated with has_tenant_access, else the
--      lowest tenant_id among the caller's admin/gestor/member memberships)
--   EXISTS(user_roles … role='admin') == is_super_admin() for every caller: the
--     subquery runs under user_roles RLS, which hides role='admin' rows from
--     non-super-admins (finding F5 in the doc — preserved, not widened)
--
-- Tables by resulting rule
${Object.entries(tablesByPlan)
  .map(([k, ts]) => `--   ${k} (${ts.length}):\n${wrap(ts.join(", "), "--     ")}`)
  .join("\n")}
--
-- user_roles(user_id) index: NOT added — user_roles_user_tenant_role_uniq and
-- user_roles_one_membership_per_tenant already lead with user_id; the 143M seq
-- scans came from per-row helper calls on an 11-row table, which this removes.
-- Out of scope: storage.objects / realtime.messages policies (non-public schemas).
`;
function wrap(text, prefix) {
  const out = [];
  let line = "";
  for (const w of text.split(" ")) {
    if ((line + " " + w).length > 76) {
      out.push(prefix + line.trim());
      line = "";
    }
    line += " " + w;
  }
  if (line.trim()) out.push(prefix + line.trim());
  return out.join("\n");
}

const helpers = `
BEGIN;
-- Fail fast instead of queueing behind long locks on hot tables (players, sms_send_logs…).
SET LOCAL lock_timeout = '5s';

-- ============================================================
-- 1) helpers: evaluated once per statement through (select …)
-- ============================================================
CREATE OR REPLACE FUNCTION public.accessible_tenant_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- Same membership rule as has_tenant_access(): admin/gestor/member of the tenant.
  SELECT coalesce(array_agg(DISTINCT ur.tenant_id), '{}'::uuid[])
  FROM public.user_roles ur
  WHERE ur.user_id = auth.uid()
    AND ur.tenant_id IS NOT NULL
    AND ur.role IN ('admin', 'gestor', 'member')
$$;

REVOKE ALL ON FUNCTION public.accessible_tenant_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accessible_tenant_ids() TO authenticated, service_role;

-- Existing helpers keep their body; only pg_temp is pinned last (SECURITY DEFINER hygiene).
ALTER FUNCTION public.current_tenant_id() SET search_path = public, pg_temp;
ALTER FUNCTION public.is_super_admin(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.has_tenant_access(uuid, uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.is_tenant_owner(uuid) SET search_path = public, pg_temp;

-- ============================================================
-- 2) policies
-- ============================================================
`;

const body = plans
  .map((pl) => {
    const drops = [...new Set([...pl.drop.map((p) => p.policyname), ...newNames(pl).map((n) => n.replace(/^"|"$/g, ""))])]
      .map((n) => `DROP POLICY IF EXISTS ${qi(n)} ON public.${pl.table};`)
      .join("\n");
    const kept = pl.keep.length ? `\n-- kept untouched: ${pl.keep.map((p) => p.policyname).join(", ")}` : "";
    return `-- ${pl.table} [${pl.group}${pl.plan ? ` -> ${pl.plan}` : ""}]${kept}\n${drops}\n${pl.create.join("\n")}\n`;
  })
  .join("\n");

const migration = `${header}${helpers}${body}
COMMIT;
`;
writeFileSync(resolve(root, "supabase/migrations/20261015090000_consolidate_tenant_rls.sql"), migration);

// ---------- before (prod) policies & rollback ----------
const affected = new Set(plans.map((p) => p.table));
const beforeSql = [...byTable.entries()]
  .filter(([t]) => affected.has(t))
  .flatMap(([, ps]) => ps.map(createOld))
  .join("\n");
writeFileSync(
  resolve(here, "before_policies.sql"),
  `-- Production policies (2026-10-14) of the ${affected.size} tables touched by CON-08. Generated.\n${beforeSql}\n`,
);

const rollback = `-- ROLLBACK of 20261015090000_consolidate_tenant_rls.sql. Generated by con08-generate.mjs.
-- Restores the exact production policies captured on 2026-10-14 (slow, per-row) and the
-- original search_path of the helpers. The new helper functions are left in place (unused, harmless).
SET lock_timeout = '5s';
BEGIN;
${plans
  .map((pl) => {
    const names = [...new Set([...newNames(pl).map((n) => n.replace(/^"|"$/g, "")), ...pl.drop.map((p) => p.policyname)])];
    return `${names.map((n) => `DROP POLICY IF EXISTS ${qi(n)} ON public.${pl.table};`).join("\n")}\n${pl.drop.map(createOld).join("\n")}`;
  })
  .join("\n\n")}

ALTER FUNCTION public.current_tenant_id() SET search_path = public;
ALTER FUNCTION public.is_super_admin(uuid) SET search_path = public;
ALTER FUNCTION public.has_tenant_access(uuid, uuid) SET search_path = public;
ALTER FUNCTION public.is_tenant_owner(uuid) SET search_path = public;
COMMIT;
`;
writeFileSync(resolve(here, "rollback_20261015090000.sql"), rollback);

console.log(`tables: ${plans.length}`);
for (const [k, ts] of Object.entries(tablesByPlan)) console.log(`  ${k}: ${ts.length}`);
