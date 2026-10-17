// What the demo clone copies and how each column is rewritten (Task 12).
//
// Every column of a cloned table gets a rule, safe by default:
//   tenant_id                    → demo tenant
//   FK to a table not cloned     → null (auth.users, email_campaigns, …)
//   other uuid                   → pg_temp.demo_uuid (deterministic remap)
//   lease/claim columns          → null (rows never look claimed)
//   text / text[]                → pg_temp.demo_rw (uuids, e-mails, query values, hosts, brand)
//   jsonb                        → {} / [] unless a keep list says which keys the UI reads
//   anything else (numbers, dates, booleans, enums) → copied as is
// `set` overrides a column with an explicit SQL expression (alias `s` = source row).
// mode "js" tables are small config tables rewritten row by row in JS
// (rewriteText / rewriteJson over every string, json kept and rewritten).
//
// Ruling R14 - only ~half of the players: `players` keeps the rows where
// pg_temp.demo_in_sample(id) holds (md5-based, stable across reruns). Every
// player-linked table has a `sample` predicate that follows its player /
// parent chain; parents are copied first, so a child predicate can ask
// whether its (remapped) parent row already exists in the demo. Rows with no
// player fall back to a key of their own (phone, e-mail, event id, row id) so
// they are halved too. Configuration tables have no `sample` and are cloned
// whole. Aggregates (REBUILT_TABLES) are not copied: they are recomputed for
// the demo with the production refresh functions, so they match the sample.
import { scrubJsonSql } from "./sql-rewrite.mjs";

export const LEASE_COLUMNS = new Set([
  "claimed_at",
  "claimed_by",
  "lease_expires_at",
  "lease_owner",
  "locked_at",
  "locked_by",
]);
export const USER_COLUMNS = new Set([
  "created_by",
  "changed_by",
  "updated_by",
  "approved_by",
  "actor_user_id",
]);

const pid = (column) => `pg_temp.demo_pid(s.${column})`;
const newKey = (column = "idempotency_key") =>
  `case when s.${column} is null then null else 'demo:' || pg_temp.demo_uuid(s.id)::text end`;
const playerPhone = (phoneColumn, playerColumn) =>
  `case when s.${phoneColumn} is null then null
        when pg_temp.demo_nat(s.${phoneColumn}) = '' then s.${phoneColumn}
        else coalesce(
          (select fp.telefone from pg_temp.demo_fake_players fp where fp.src_id = s.${playerColumn} and fp.telefone is not null),
          (select ph.fake from pg_temp.demo_fake_phones ph where ph.nat = pg_temp.demo_nat(s.${phoneColumn})),
          '+5511900000000') end`;
const placeholder = (column, urlKey) =>
  `case when s.${column} is null then null else {{${urlKey}}} end`;

// --- R14 sample predicates (alias `s` = source row, $1 = source tenant) -----
const inSample = (column) => `pg_temp.demo_in_sample(s.${column}::text)`;
/** Player column, falling back to the row id when it is null. */
const playerSample = (column) => `pg_temp.demo_in_sample(coalesce(s.${column}, s.id)::text)`;
/** The parent row (uuid column) was copied into the demo. */
const kept = (table, column) =>
  `exists (select 1 from public.${table} d where d.id = pg_temp.demo_uuid(s.${column}))`;
const keptOrNull = (table, column) => `(s.${column} is null or ${kept(table, column)})`;
const phoneSample = (column) =>
  `case when s.${column} is null then pg_temp.demo_in_sample(s.id::text) else pg_temp.demo_phone_in_sample(s.${column}) end`;
const SHORT_PATH = "'dm' || left(md5('short:' || pg_temp.demo_uuid(s.id)::text), 8)";
const UUID_TEXT = "'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'";

/**
 * Columns that point at a player (FK or soft reference). The clone verifies
 * that none of them, in the demo, holds the remapped id of a source player
 * left out of the sample.
 */
export const PLAYER_REFS = [
  ["deposits", "player_id"],
  ["withdrawals", "player_id"],
  ["events", "player_id"],
  ["sessions", "player_id"],
  ["player_attributions", "player_id"],
  ["journey_enrollments", "player_id"],
  ["journey_crossing_states", "cursor_player_id"],
  ["sms_send_logs", "player_id"],
  ["email_send_logs", "player_id"],
  ["link_dispatches", "recipient_player_id"],
  ["conversion_attributions", "player_id"],
  ["call_queue", "lead_id"],
  ["call_history", "lead_id"],
];

/**
 * Cloned tables, in insertion order. Keys:
 *   set     { column: sqlExpr }      explicit expressions
 *   keep    { column: [paths] }      jsonb keys the UI reads (scrubJson keep list)
 *   joins   [sql]                    extra joins (alias `s` is the source row)
 *   jsText  { columns, player, phone } free-text columns rewritten in JS batches
 *   mode    "js"                     whole rows rewritten in JS (small config tables)
 *   sample  sqlPredicate             R14: which source rows are copied (absent = all)
 *   prepare [sql]                    run before the copy ($1 = source tenant)
 *   after   [sql]                    run after the copy ($1 = source, $2 = demo tenant)
 */
export const CLONE_TABLES = [
  {
    table: "players",
    joins: ["join pg_temp.demo_fake_players f on f.src_id = s.id"],
    set: {
      nome: "f.nome",
      telefone: "f.telefone",
      email: "f.email",
      cpf: "f.cpf",
      data_nascimento: "f.data_nascimento",
      player_external_id: "f.player_external_id",
      affiliate_id: "f.affiliate_id",
      expert: "f.expert",
      // Marketing click id: no screen reads it and it would point at a real click.
      bl_click_id: "null",
    },
    sample: inSample("id"),
  },
  {
    table: "deposits",
    set: { external_id: pid("external_id"), event_id: pid("event_id") },
    sample: playerSample("player_id"),
  },
  {
    table: "withdrawals",
    set: { external_id: pid("external_id"), event_id: pid("event_id") },
    sample: playerSample("player_id"),
  },
  {
    table: "events",
    set: { provider_event_id: pid("provider_event_id") },
    keep: { metadata: ["jogo", "event", "status", "trigger_name", "campaign"] },
    sample: playerSample("player_id"),
  },
  {
    table: "sessions",
    set: { provider_event_id: pid("provider_event_id") },
    sample: playerSample("player_id"),
  },
  {
    table: "player_attributions",
    set: {
      ...Object.fromEntries(
        [
          "event_id",
          "fbclid",
          "gclid",
          "gbraid",
          "wbraid",
          "ttclid",
          "msclkid",
          "trackgram_click_id",
          "matched_ad_account_id",
          "matched_campaign_id",
          "matched_adset_id",
          "matched_ad_id",
        ].map((c) => [c, pid(c)]),
      ),
      bl_click_id: "null",
    },
    keep: {
      raw_payload: [
        "normalized.depositos",
        "raw.depositos",
        "raw.primeiro_deposito",
        "raw.ultimo_deposito",
      ],
    },
    sample: playerSample("player_id"),
  },
  { table: "journey_voice_assets", mode: "js" },
  { table: "journeys", mode: "js" },
  { table: "journey_steps", mode: "js" },
  { table: "journey_contact_limits" },
  {
    table: "journey_crossing_states",
    set: {
      cursor_player_id: `case when ${inSample("cursor_player_id")} then pg_temp.demo_uuid(s.cursor_player_id) end`,
    },
  },
  {
    table: "journey_enrollments",
    keep: { metadata: ["deposited_before_entry"] },
    sample: playerSample("player_id"),
  },
  {
    table: "journey_step_executions",
    set: {
      provider_message_id: pid("provider_message_id"),
      // uuid column: regenerated from the row id (spec §6), not the real key.
      idempotency_key: "md5('idem:' || pg_temp.demo_uuid(s.id)::text)::uuid",
    },
    keep: { provider_response: ["variant_index", "channel_permit_id"] },
    sample: kept("journey_enrollments", "enrollment_id"),
  },
  {
    table: "journey_events",
    keep: { detail: ["reason", "step_position", "channel", "status", "variant_index"] },
    sample: `${keptOrNull("journey_enrollments", "enrollment_id")} and ${keptOrNull("journey_step_executions", "execution_id")}`,
  },
  { table: "sms_templates", mode: "js" },
  { table: "sms_template_versions", mode: "js" },
  { table: "sms_audiences", mode: "js" },
  { table: "sms_campaigns", mode: "js" },
  {
    table: "sms_send_logs",
    jsText: { columns: ["content"], player: "player_id", phone: "to_phone" },
    set: {
      to_phone: playerPhone("to_phone", "player_id"),
      provider_message_id: pid("provider_message_id"),
      idempotency_key: newKey(),
    },
    sample: `case when s.player_id is not null then ${inSample("player_id")} else ${phoneSample("to_phone")} end`,
  },
  {
    // A send's credit reservation/refund carries reference_id =
    // sms_send_logs.provider_response.billing_reference_id: it follows its log.
    // Purchases, adjustments, reversals and expirations are kept whole.
    table: "sms_credit_ledger",
    set: { idempotency_key: newKey() },
    prepare: [
      `drop table if exists pg_temp.demo_billing_refs`,
      `create temp table demo_billing_refs (ref text primary key, kept boolean not null)`,
      `insert into pg_temp.demo_billing_refs (ref, kept)
       select l.provider_response->>'billing_reference_id',
              bool_or(exists (select 1 from public.sms_send_logs d where d.id = pg_temp.demo_uuid(l.id)))
         from public.sms_send_logs l
        where l.tenant_id = $1 and l.provider_response->>'billing_reference_id' is not null
        group by 1`,
    ],
    sample: `case when s.entry_type in ('sms_reservation', 'sms_refund') and s.reference_id is not null
                  then coalesce((select b.kept from pg_temp.demo_billing_refs b where b.ref = s.reference_id),
                                pg_temp.demo_in_sample(s.reference_id))
                  else true end`,
  },
  {
    // Copied whole, then corrected by what the left-out sends had consumed:
    // every ledger balance_after and the tenant balance get those credits back,
    // lifetime_used loses them.
    table: "tenant_sms_credit_balances",
    after: [
      `with src as (
         select s.id, s.delta_credits, s.balance_after, s.created_at,
                exists (select 1 from public.sms_credit_ledger d where d.id = pg_temp.demo_uuid(s.id)) as kept
           from public.sms_credit_ledger s where s.tenant_id = $1),
       adj as (
         select id, kept,
                balance_after + sum(case when kept then 0 else -delta_credits end)
                  over (order by created_at, id rows unbounded preceding) as bal
           from src)
       update public.sms_credit_ledger d set balance_after = greatest(adj.bal, 0)
         from adj where adj.kept and d.tenant_id = $2 and d.id = pg_temp.demo_uuid(adj.id)`,
      `update public.tenant_sms_credit_balances b
          set balance_credits = greatest(b.balance_credits + x.used, 0),
              lifetime_used_credits = greatest(b.lifetime_used_credits - x.used, 0)
         from (select coalesce(sum(-s.delta_credits), 0)::int as used
                 from public.sms_credit_ledger s
                where s.tenant_id = $1
                  and not exists (select 1 from public.sms_credit_ledger d where d.id = pg_temp.demo_uuid(s.id))) x
        where b.tenant_id = $2`,
    ],
  },
  { table: "tenant_sms_pricing" },
  { table: "email_templates", mode: "js" },
  { table: "email_template_versions", mode: "js" },
  { table: "email_senders", mode: "js" },
  {
    table: "email_send_logs",
    jsText: { columns: ["subject"], player: "player_id" },
    set: {
      // Fallback keyed with the run secret: never a plain hash of the real address.
      to_email: `coalesce((select fp.email from pg_temp.demo_fake_players fp where fp.src_id = s.player_id and fp.email is not null),
                          'contato+' || left(pg_temp.demo_hash('email:' || lower(s.to_email)), 10) || '@example.com')`,
    },
    keep: { provider_response: ["status", "retry_at", "reason"] },
    sample: `case when s.player_id is not null then ${inSample("player_id")}
                  else pg_temp.demo_in_sample(lower(s.to_email)) end`,
  },
  {
    // Before tracked_links (FKs are checked after the copy): a link follows
    // the dispatches that use it.
    table: "link_dispatches",
    set: { recipient_hash: "pg_temp.demo_sha(s.recipient_hash)", idempotency_key: newKey() },
    sample: `case when s.recipient_player_id is not null then ${inSample("recipient_player_id")}
                  when s.message_log_type = 'sms' and s.message_log_id ~ ${UUID_TEXT}
                    then exists (select 1 from public.sms_send_logs d where d.id = pg_temp.demo_uuid(s.message_log_id::uuid))
                  else pg_temp.demo_in_sample(s.id::text) end`,
  },
  {
    table: "tracked_links",
    set: {
      shortio_link_id: pid("shortio_link_id"),
      canonical_url_hash: "pg_temp.demo_sha(pg_temp.demo_uuid(s.id)::text)",
      // Never the real Short.io code: a code derived from the demo link id
      // (JS twin: demoShortPath). Free-text copies of the short link are
      // mapped to the same URL through pg_temp.demo_short_map.
      path: `case when s.path is null then null else ${SHORT_PATH} end`,
      short_url: `'https://' || {{demoDomain}} || '/' || ${SHORT_PATH}`,
    },
    // Kept when a kept dispatch uses it, or when no dispatch uses it at all.
    sample: `exists (select 1 from public.link_dispatches d where d.tracked_link_id = pg_temp.demo_uuid(s.id))
             or not exists (select 1 from public.link_dispatches o where o.tracked_link_id = s.id)`,
  },
  {
    table: "click_events",
    set: {
      request_id: newKey("request_id"),
      ip_hash: "pg_temp.demo_sha(s.ip_hash)",
      user_agent_hash: "pg_temp.demo_sha(s.user_agent_hash)",
    },
    sample: kept("link_dispatches", "link_dispatch_id"),
  },
  // Snapshots of the kept links (remapped, payload emptied): the link reports
  // chart clicks per snapshot, and the narrow rows copy in seconds.
  { table: "link_click_snapshots", sample: kept("tracked_links", "tracked_link_id") },
  {
    table: "conversion_attributions",
    set: { event_id: pid("event_id") },
    // evidence (conversion-attribution.server.ts): token_source (enum),
    // dispatch_sent_at, supplied_touch_at (timestamps) — none identifying; no
    // screen reads them today, kept for parity with the source.
    keep: { evidence: ["token_source", "dispatch_sent_at", "supplied_touch_at"] },
    sample: `${inSample("player_id")} and ${kept("link_dispatches", "link_dispatch_id")}`,
  },
  {
    // No player column: the event id leads to the deposit / withdrawal / event /
    // session / signup that raised the issue, hence to its player.
    table: "conversion_attribution_issues",
    set: { event_id: pid("event_id") },
    prepare: [
      `drop table if exists pg_temp.demo_event_player`,
      `create temp table demo_event_player (event_id text primary key, player_id uuid not null)`,
      `insert into pg_temp.demo_event_player (event_id, player_id)
       select x.event_id, x.player_id from (
         select event_id, player_id from public.deposits where tenant_id = $1
         union all select external_id, player_id from public.deposits where tenant_id = $1
         union all select event_id, player_id from public.withdrawals where tenant_id = $1
         union all select external_id, player_id from public.withdrawals where tenant_id = $1
         union all select provider_event_id, player_id from public.events where tenant_id = $1
         union all select provider_event_id, player_id from public.sessions where tenant_id = $1
         union all select 'signup:' || player_external_id, id from public.players where tenant_id = $1
       ) x
       where x.event_id is not null and x.player_id is not null
         and x.event_id in (select i.event_id from public.conversion_attribution_issues i where i.tenant_id = $1)
       on conflict do nothing`,
    ],
    sample: `coalesce((select pg_temp.demo_in_sample(ep.player_id::text) from pg_temp.demo_event_player ep
                        where ep.event_id = s.event_id),
                      pg_temp.demo_in_sample(s.event_type || ':' || s.event_id))`,
  },
  {
    table: "activation_runs",
    keep: {
      totals: [
        "analyzed",
        "eligible",
        "enqueued",
        "skipped",
        "by_trigger",
        "by_channel",
        "blocked_reasons",
        "cursor_after_id",
      ],
    },
  },
  { table: "call_scripts", mode: "js" },
  { table: "call_script_versions", mode: "js" },
  {
    table: "call_queue",
    set: {
      phone_number: playerPhone("phone_number", "lead_id"),
      audio_url: placeholder("audio_url", "audioUrl"),
      provider_request_id: pid("provider_request_id"),
      audio_generation_id: "null", // call_audio_generations is not cloned
    },
    keep: { provider_response: ["status"] },
    sample: `case when s.lead_id is not null then ${inSample("lead_id")} else ${phoneSample("phone_number")} end`,
  },
  {
    table: "call_history",
    jsText: { columns: ["rendered_text"], player: "lead_id", phone: "to_phone" },
    set: {
      to_phone: playerPhone("to_phone", "lead_id"),
      audio_url: placeholder("audio_url", "audioUrl"),
      recording_url: placeholder("recording_url", "audioUrl"),
      provider_call_id: pid("provider_call_id"),
    },
    keep: { provider_response: ["status", "channel_permit_id"] },
    sample: `case when s.call_queue_id is not null then ${kept("call_queue", "call_queue_id")}
                  when s.lead_id is not null then ${inSample("lead_id")}
                  else ${phoneSample("to_phone")} end`,
  },
  { table: "voice_contact_policies" },
  { table: "send_window_settings" },
  { table: "dashboard_settings" },
  {
    table: "shortio_settings",
    set: {
      domain: "case when s.domain is null then null else {{demoDomain}} end",
      domain_id: "null",
      allowed_destination_hosts:
        "array(select distinct h from unnest(pg_temp.demo_rw_arr(s.allowed_destination_hosts)) h order by h)",
    },
  },
];

/**
 * Aggregates recomputed for the demo (after every copy) with the same
 * per-tenant/per-day functions the crons use, for each day the source has
 * rows; `stamp` is then set to the source's latest value so a rerun is
 * byte-identical. Order matters: the health check reads crm_results_daily.
 */
export const REBUILT_TABLES = [
  { table: "crm_results_daily", fn: "refresh_crm_results_day", stamp: "updated_at" },
  { table: "player_lifecycle_daily", fn: "refresh_player_lifecycle_day", stamp: "updated_at" },
  { table: "tenant_daily_metrics", fn: "refresh_tenant_daily_metric_day", stamp: "updated_at" },
  { table: "crm_results_health", fn: "check_crm_results_day", stamp: "checked_at" },
];

/**
 * Deliberately not cloned (spec §6), besides webhook_logs & co: campaign_drafts
 * (created_by is NOT NULL + ON DELETE RESTRICT to auth.users — copying would
 * pin real staff accounts into the demo and block deleting them; drafts are
 * unfinished work, not results).
 */
export const NOT_CLONED = [
  "webhook_logs",
  "webhook_event_receipts",
  "financial_webhook_attempts",
  "dispatcher_runs",
  "link_tracking_sync_runs",
  "admin_audit_logs",
  "tenant_audit_logs",
  "user_roles",
  "email_unsubscribe_tokens",
  "journey_scan_jobs",
  "journey_level_outbox",
  "dispatch_pause_state",
  "campaign_drafts",
];

/** Tables whose demo rows survive a reset (logins and audit trail). */
export const KEEP_ON_RESET = (table) =>
  table === "tenants" ||
  table === "user_roles" ||
  /audit/.test(table) ||
  /^ops_backup_/.test(table);

export const isTextual = (c) => c.type === "text" || c.type === "character varying";
export const isTextArray = (c) => c.type === "ARRAY" && ["_text", "_varchar"].includes(c.udt);
export const isJson = (c) => c.type === "jsonb" || c.type === "json";
export const isInsertable = (c) => !c.generated;

/** SQL expression for one column of a SQL-mode table. */
export function columnExpr(spec, column, { fkTargets, cloned, demoTenantId, values }) {
  const name = column.name;
  const fill = (expr) =>
    expr.replace(/\{\{(\w+)\}\}/g, (_m, key) => {
      if (!(key in values)) throw new Error(`clone-plan: no value for {{${key}}}`);
      return values[key];
    });
  if (spec.set && name in spec.set) return fill(spec.set[name]);
  if (spec.jsText && spec.jsText.columns.includes(name)) return `j.${name}`;
  if (name === "tenant_id") return `'${demoTenantId}'::uuid`;
  if (LEASE_COLUMNS.has(name)) return "null";
  const fkTarget = fkTargets.get(`${spec.table}.${name}`);
  if (fkTarget && !cloned.has(fkTarget)) return "null";
  if (USER_COLUMNS.has(name) && column.udt === "uuid") return "null";
  if (column.udt === "uuid") return `pg_temp.demo_uuid(s.${name})`;
  if (isTextual(column)) return `pg_temp.demo_rw(s.${name})`;
  if (isTextArray(column)) return `pg_temp.demo_rw_arr(s.${name})`;
  if (isJson(column)) {
    const keep = spec.keep?.[name];
    const cast = column.type === "json" ? "::json" : "";
    if (keep)
      return `case when s.${name} is null then null else pg_temp.demo_rw_json(${scrubJsonSql(`s.${name}::jsonb`, keep)})${cast} end`;
    return `pg_temp.demo_empty_json(s.${name}::jsonb)${cast}`;
  }
  return `s.${name}`;
}

/** INSERT … SELECT for a SQL-mode table ($1 = source tenant id). */
export function copySql(spec, columns, ctx) {
  const cols = columns.filter(isInsertable);
  const joins = [...(spec.joins ?? [])];
  if (spec.jsText) joins.push(`left join pg_temp.demo_js_${spec.table} j on j.id = s.id`);
  return `insert into public.${spec.table} (${cols.map((c) => `"${c.name}"`).join(", ")})
select ${cols.map((c) => columnExpr(spec, c, ctx)).join(",\n       ")}
  from public.${spec.table} s ${joins.join(" ")}
 where s.tenant_id = $1${spec.sample ? `\n   and (${spec.sample})` : ""}`;
}
