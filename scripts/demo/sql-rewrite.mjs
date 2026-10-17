// SQL twins of the generic rewrite helpers in anonymize.mjs, created as
// pg_temp functions inside the clone transaction (they vanish with the
// session). Built from the same rule data as `rewriteGeneric`, so JS and SQL
// produce identical output (asserted in sql-rewrite.test.ts).
import {
  DEMO_DOMAIN,
  DEMO_NAMESPACE,
  DEMO_SAMPLE_SALT,
  UUID_PATTERN,
  genericRules,
  keepTree,
  normalizeHosts,
  shortLinkPattern,
} from "./anonymize.mjs";

export const lit = (value) => (value === null || value === undefined ? "null" : `'${String(value).replace(/'/g, "''")}'`);

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The per-run secret lives only in the transaction-local setting
 * `demo.secret` (set with a bind parameter, see `setSecretSql`); it is never
 * written into a function body or a table.
 */
export const setSecretSql = `select set_config('demo.secret', $1, true)`;
// Fail closed: every secret-keyed function raises when the secret is unset.
const SECRET = `pg_temp.demo_secret()`;

/**
 * One statement per entry (PGlite's query() runs a single statement).
 * Creates pg_temp.demo_short_map (key = lower(host)/path → demo short url),
 * filled by the caller before any copy.
 */
export function rewriteFunctionsSql({ sourceTenantId, demoTenantId, hosts = [], brandNames = [], shortHosts = [] }) {
  const normalizedHosts = normalizeHosts(hosts);
  const shortPattern = shortLinkPattern(normalizeHosts(shortHosts));
  const rules = genericRules({ hosts: normalizedHosts, brandNames });
  const prefilter = [
    "[0-9a-f]{8}-[0-9a-f]{4}-",
    "@",
    "[?&]",
    "sorte",
    "pixpgf",
    ...normalizedHosts.map(escapeRegex),
    ...normalizeHosts(shortHosts).map(escapeRegex),
    ...brandNames.filter((n) => String(n ?? "").trim().length >= 4).map((n) => escapeRegex(String(n).trim()).replace(/\s+/g, "\\s+")),
  ].join("|");
  const ruleSteps = rules
    .map((rule) => `  r := regexp_replace(r, ${lit(rule.pattern)}, ${lit(rule.sql)}, ${lit(rule.flags)});`)
    .join("\n");
  const shortStep = shortPattern
    ? `  if r ~* ${lit(shortPattern)} then
    select string_agg(p.part || coalesce(pg_temp.demo_short_target(m.arr[1], m.arr[2]), ''), '' order by p.n)
      into r
      from unnest(regexp_split_to_array(r, ${lit(shortPattern)}, 'i')) with ordinality p(part, n)
      left join regexp_matches(r, ${lit(shortPattern)}, 'gi') with ordinality m(arr, n) on m.n = p.n;
  end if;
`
    : "";
  return [
    `create or replace function pg_temp.demo_secret() returns text language plpgsql stable as $f$
declare s text := current_setting('demo.secret', true);
begin
  if s is null or length(s) < 16 then
    raise exception 'demo.secret is not set — refusing to derive demo values without the run secret';
  end if;
  return s;
end
$f$`,
    `drop table if exists pg_temp.demo_short_map`,
    `create temp table demo_short_map (key text primary key, dst text not null)`,
    `create or replace function pg_temp.demo_short_target(host text, path text) returns text language sql stable as $f$
  select coalesce(
    (select m.dst from pg_temp.demo_short_map m where m.key = lower(host) || '/' || path),
    'https://${DEMO_DOMAIN}/dx' || left(md5(${SECRET} || ':short:' || lower(host) || '/' || path), 12))
$f$`,
    `create or replace function pg_temp.demo_uuid(u uuid) returns uuid language sql immutable as $f$
  select case
    when u is null then null
    when u = ${lit(sourceTenantId)}::uuid then ${lit(demoTenantId)}::uuid
    else (select (substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-3' || substr(h, 14, 3) || '-' ||
                  substr('89ab', (('x' || substr(h, 17, 1))::bit(4)::int & 3) + 1, 1) ||
                  substr(h, 18, 3) || '-' || substr(h, 21, 12))::uuid
          from (select md5(decode(${lit(DEMO_NAMESPACE.replace(/-/g, ""))}, 'hex') || convert_to(lower(u::text), 'UTF8')) h) d)
  end
$f$`,
    `create or replace function pg_temp.demo_rw_slow(t text) returns text language plpgsql stable as $f$
declare r text := t;
begin
${shortStep}  if r ~* ${lit(UUID_PATTERN)} then
    select string_agg(p.part || coalesce(pg_temp.demo_uuid(lower(m.arr[1])::uuid)::text, ''), '' order by p.n)
      into r
      from unnest(regexp_split_to_array(r, ${lit(UUID_PATTERN)}, 'i')) with ordinality p(part, n)
      left join regexp_matches(r, ${lit(UUID_PATTERN)}, 'gi') with ordinality m(arr, n) on m.n = p.n;
  end if;
${ruleSteps}
  return r;
end
$f$`,
    `create or replace function pg_temp.demo_rw(t text) returns text language sql stable as $f$
  select case when t is null or t !~* ${lit(prefilter)} then t else pg_temp.demo_rw_slow(t) end
$f$`,
    `create or replace function pg_temp.demo_rw_arr(a text[]) returns text[] language sql stable as $f$
  select case when a is null then null
    else array(select pg_temp.demo_rw(x) from unnest(a) with ordinality u(x, n) order by n) end
$f$`,
    `create or replace function pg_temp.demo_rw_json(j jsonb) returns jsonb language sql stable as $f$
  select case when j is null then null else pg_temp.demo_rw(j::text)::jsonb end
$f$`,
    `create or replace function pg_temp.demo_pid(t text) returns text language sql stable as $f$
  select case when t is null then null else 'demo' || left(md5(${SECRET} || ':pid:' || t), 24) end
$f$`,
    `create or replace function pg_temp.demo_nat(t text) returns text language sql immutable as $f$
  select case
    when d is null then null
    when length(d) in (12, 13) and left(d, 2) = '55' then substr(d, 3)
    else d end
  from (select regexp_replace(t, '[^0-9]', '', 'g') d) x
$f$`,
    `create or replace function pg_temp.demo_sha(t text) returns text language sql stable as $f$
  select case when t is null then null else encode(sha256(convert_to(${SECRET} || ':sha:' || t, 'UTF8')), 'hex') end
$f$`,
    `create or replace function pg_temp.demo_hash(t text) returns text language sql stable as $f$
  select case when t is null then null else md5(${SECRET} || ':' || t) end
$f$`,
    // ONE mapping for every idempotency key (sms_send_logs, journey_step_executions,
    // link_dispatches, sms_credit_ledger, …): applied component by component on
    // ':' so equal real keys stay equal and "<key>:<n>" stays "<demo key>:<n>"
    // (conversion_report_sources strips that suffix). 1–3 digit components (url
    // positions) are kept; a uuid component becomes a secret-keyed uuid (so a
    // uuid column and its ::text copy match); anything else (labels, phones,
    // ids) a secret-keyed hash.
    `create or replace function pg_temp.demo_key_part(c text) returns text language sql stable as $f$
  select case
    when c ~ '^[0-9]{1,3}$' or c = '' then c
    when c ~* ${lit(`^${UUID_PATTERN}$`)} then
      (select substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-a' || substr(h, 18, 3) || '-' || substr(h, 21, 12)
         from (select md5(${SECRET} || ':idem:' || lower(c)) h) x)
    else left(md5(${SECRET} || ':idem:' || c), 16) end
$f$`,
    `create or replace function pg_temp.demo_key(t text) returns text language sql stable as $f$
  select case when t is null then null else
    (select string_agg(pg_temp.demo_key_part(p.c), ':' order by p.n)
       from unnest(string_to_array(t, ':')) with ordinality p(c, n)) end
$f$`,
    `create or replace function pg_temp.demo_in_sample(t text) returns boolean language sql immutable as $f$
  select case when t is null then false else left(md5(${lit(DEMO_SAMPLE_SALT)} || lower(t)), 1) < '8' end
$f$`,
    `create or replace function pg_temp.demo_empty_json(j jsonb) returns jsonb language sql immutable as $f$
  select case when j is null then null when jsonb_typeof(j) = 'array' then '[]'::jsonb else '{}'::jsonb end
$f$`,
  ];
}

let aliasCounter = 0;

function scrubTreeSql(expr, tree) {
  const alias = `e${aliasCounter++}`;
  const keys = Object.keys(tree);
  if (!keys.length) return "'{}'::jsonb";
  const nested = keys.filter((k) => tree[k] !== true);
  const valueExpr = nested.length
    ? `case ${nested.map((k) => `when ${alias}.key = ${lit(k)} then ${scrubTreeSql(`${alias}.value`, tree[k])}`).join(" ")} else ${alias}.value end`
    : `${alias}.value`;
  return `(select coalesce(jsonb_object_agg(${alias}.key, ${valueExpr}), '{}'::jsonb) from jsonb_each(case when jsonb_typeof(${expr}) = 'object' then ${expr} else '{}'::jsonb end) ${alias} where ${alias}.key in (${keys.map(lit).join(", ")}))`;
}

/** SQL twin of scrubJson(value, keepKeys); `expr` is a jsonb SQL expression. */
export function scrubJsonSql(expr, keepKeys) {
  return scrubTreeSql(expr, keepTree(keepKeys));
}

