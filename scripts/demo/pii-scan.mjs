// PII scan for the demo tenant (Task 12).
//
// `collectNeedles` reads the real identities of the source tenant; `scanTenant`
// looks for any of them in every text/jsonb/text[] column of every table that
// has rows of the scanned tenant. Matching is set-based in SQL: tokens are
// extracted with regexes (digit runs, e-mails, id-like words, uuids) and
// hash-joined against needle tables, so the cost grows with the amount of
// text, not with the number of needles.
import { UUID_PATTERN, nationalDigits, normalizeHosts, phoneForms } from "./anonymize.mjs";

const qi = (name) => `"${String(name).replace(/"/g, '""')}"`;
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** information_schema snapshot: Map<table, Array<{ name, type, udt }>> for public base tables. */
export async function publicColumns(client) {
  const { rows } = await client.query(
    `select c.table_name, c.column_name, c.data_type, c.udt_name, c.is_nullable,
            (c.is_generated = 'ALWAYS' or c.identity_generation = 'ALWAYS') as generated
       from information_schema.columns c
       join information_schema.tables t using (table_schema, table_name)
      where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
      order by c.table_name, c.ordinal_position`,
  );
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.table_name)) out.set(r.table_name, []);
    out.get(r.table_name).push({
      name: r.column_name,
      type: r.data_type,
      udt: r.udt_name,
      nullable: r.is_nullable === "YES",
      generated: r.generated === true,
    });
  }
  return out;
}

const has = (columns, table, column) => (columns.get(table) ?? []).some((c) => c.name === column);

/** Distinct non-empty values of `expr` over `from` (alias s) for one tenant. */
async function distinctValues(client, sources, tenantId) {
  const values = new Set();
  for (const { expr, from } of sources) {
    const { rows } = await client.query(
      `select distinct v from (select ${expr} as v from ${from} where s.tenant_id = $1) x
        where v is not null and v <> ''`,
      [tenantId],
    );
    for (const r of rows) values.add(String(r.v));
  }
  return [...values];
}

function columnSources(columns, pairs) {
  return pairs
    .filter(([table, column]) => has(columns, table, column))
    .map(([table, column]) => ({ expr: `s.${qi(column)}`, from: `public.${qi(table)} s` }));
}

/** Phones inside sms_campaigns.recipients / unresolved_recipients ([{ phone, … }]). */
function campaignPhoneSources(columns) {
  return ["recipients", "unresolved_recipients"]
    .filter((column) => has(columns, "sms_campaigns", column))
    .map((column) => ({
      expr: "e->>'phone'",
      from: `public.sms_campaigns s cross join lateral jsonb_array_elements(
        case when jsonb_typeof(s.${column}) = 'array' then s.${column} else '[]'::jsonb end) e`,
    }));
}

/** Real identities of the source tenant that must never appear in the demo. */
export async function collectNeedles(client, sourceTenantId, { excludeHosts = [] } = {}) {
  const columns = await publicColumns(client);
  const phones = await distinctValues(
    client,
    [
      ...columnSources(columns, [
        ["players", "telefone"],
        ["sms_send_logs", "to_phone"],
        ["call_queue", "phone_number"],
        ["call_history", "to_phone"],
      ]),
      ...campaignPhoneSources(columns),
    ],
    sourceTenantId,
  );
  const pick = (pairs) => distinctValues(client, columnSources(columns, pairs), sourceTenantId);
  const emails = (await pick([
    ["players", "email"],
    ["email_send_logs", "to_email"],
  ])).map((e) => e.toLowerCase());
  const cpfs = (await pick([["players", "cpf"]]))
    .map((c) => c.replace(/\D/g, ""))
    .filter((c) => c.length === 11);
  const externalIds = await pick([
    ["players", "player_external_id"],
    ["players", "affiliate_id"],
  ]);
  const providerIds = await pick([
    ["sms_send_logs", "provider_message_id"],
    ["journey_step_executions", "provider_message_id"],
    ["call_history", "provider_call_id"],
    ["call_queue", "provider_request_id"],
  ]);
  const shortioLinkIds = await pick([["tracked_links", "shortio_link_id"]]);
  const hosts = await collectHosts(client, columns, sourceTenantId);
  const { rows: tenantRows } = await client.query(
    `select nome, slug from public.tenants where id = $1`,
    [sourceTenantId],
  );
  const tenant = tenantRows[0] ?? {};
  const brands = [
    ...new Set(
      ["sortealta", "sorte alta", "sorte-alta", "sorte_alta", "sorte.alta", "pixpgf", tenant.nome, tenant.slug]
        .filter((b) => b && String(b).trim().length >= 4)
        .map((b) => String(b).trim().toLowerCase()),
    ),
  ];
  return {
    phones,
    emails,
    cpfs,
    externalIds,
    providerIds,
    shortioLinkIds,
    uuids: [sourceTenantId.toLowerCase()],
    domains: normalizeHosts(hosts, excludeHosts),
    brands,
  };
}

/** Every host in the source's links, journey configs, templates and Short.io settings. */
export async function collectHosts(client, columns, sourceTenantId) {
  const sources = [
    ["tracked_links", "original_url"],
    ["tracked_links", "short_url"],
    ["link_dispatches", "original_url"],
    ["link_dispatches", "sent_url"],
    ["journey_steps", "config"],
    ["sms_templates", "content"],
    ["email_templates", "body_html"],
    ["sms_campaigns", "content"],
  ].filter(([t, c]) => has(columns, t, c));
  const hosts = new Set();
  for (const [table, column] of sources) {
    const { rows } = await client.query(
      `select distinct lower(m[1]) as host
         from public.${qi(table)} s
         cross join lateral regexp_matches(s.${qi(column)}::text, 'https?://([A-Za-z0-9.-]+)', 'gi') m
        where s.tenant_id = $1`,
      [sourceTenantId],
    );
    for (const r of rows) hosts.add(r.host);
  }
  if (has(columns, "shortio_settings", "domain")) {
    const { rows } = await client.query(
      `select domain, allowed_destination_hosts from public.shortio_settings where tenant_id = $1`,
      [sourceTenantId],
    );
    for (const r of rows) {
      if (r.domain) hosts.add(String(r.domain).toLowerCase());
      for (const h of r.allowed_destination_hosts ?? []) hosts.add(String(h).toLowerCase());
    }
  }
  return [...hosts];
}

/** Needle rows by matching strategy. */
export function needleRows(needles) {
  const rows = new Map();
  const add = (kind, needle) => {
    const value = String(needle ?? "").trim().toLowerCase();
    if (!value) return;
    rows.set(`${kind}\u0000${value}`, { kind, needle: value });
  };
  for (const phone of needles.phones ?? []) {
    for (const form of phoneForms(phone)) add("digits", form);
    if (nationalDigits(phone).length >= 8) add("exact", phone);
  }
  for (const cpf of needles.cpfs ?? []) {
    const digits = String(cpf).replace(/\D/g, "");
    if (digits.length === 11) add("digits", digits);
  }
  for (const email of needles.emails ?? []) {
    add("email", email);
    add("exact", email);
  }
  for (const id of [...(needles.externalIds ?? []), ...(needles.providerIds ?? []), ...(needles.shortioLinkIds ?? [])]) {
    const value = String(id ?? "").trim();
    if (value.length < 4) continue;
    add("exact", value);
    if (/^\d+$/.test(value)) {
      if (value.length >= 8 && value.length <= 13) add("digits", value);
    } else if (/^[A-Za-z0-9_-]{6,}$/.test(value)) add("token", value);
  }
  for (const s of [...(needles.uuids ?? []), ...(needles.domains ?? []), ...(needles.brands ?? [])])
    if (String(s).trim().length >= 4) add("sub", s);
  return [...rows.values()];
}

const TEXTUAL = (c) =>
  ["text", "character varying", "jsonb", "json"].includes(c.type) ||
  (c.type === "ARRAY" && ["_text", "_varchar"].includes(c.udt));

const DIGIT_RUN_SEPARATED = "(?<![0-9A-Za-z_])([0-9][0-9 ().+-]{6,22}[0-9])(?![0-9A-Za-z_])";
const DIGIT_RUN = "(?<![0-9])([0-9]{8,13})(?![0-9])";
const EMAIL = "([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,})";
const TOKEN = "([A-Za-z0-9_-]{6,})";

/**
 * Scans every textual column of every table holding rows of `tenantId`.
 * Options: `tables` (restrict), `sourceTenantId` (also flag any uuid — column
 * or embedded in text — that belongs to a source-tenant row), `limit`.
 * Returns [{ table, column, id, needle, kind }].
 */
export async function scanTenant(client, tenantId, needles, { tables, sourceTenantId, limit = 200 } = {}) {
  const columns = await publicColumns(client);
  await client.query(`drop table if exists pg_temp.demo_scan_needles`);
  await client.query(`create temp table demo_scan_needles (kind text not null, needle text not null)`);
  const rows = needleRows(needles);
  for (let i = 0; i < rows.length; i += 20000)
    await client.query(
      `insert into pg_temp.demo_scan_needles (kind, needle)
       select kind, needle from json_to_recordset($1::json) as x(kind text, needle text)`,
      [JSON.stringify(rows.slice(i, i + 20000))],
    );
  await client.query(`create index on pg_temp.demo_scan_needles (kind, needle)`);
  await client.query(`analyze pg_temp.demo_scan_needles`);
  const subs = rows.filter((r) => r.kind === "sub").map((r) => escapeRegex(r.needle));
  const subRegex = subs.length ? subs.join("|") : null;

  const candidates = [...columns.keys()].filter(
    (t) => (t === "tenants" || has(columns, t, "tenant_id")) && (!tables || tables.includes(t)),
  );

  const useUuids = Boolean(sourceTenantId);
  if (useUuids) await buildSourceUuidSet(client, columns, candidates.filter((t) => t !== "tenants"), sourceTenantId);

  const hits = [];
  for (const table of candidates) {
    if (hits.length >= limit) break;
    const cols = columns.get(table);
    const where = table === "tenants" ? "s.id = $1" : "s.tenant_id = $1";
    const idExpr = cols.some((c) => c.name === "id") ? "s.id::text" : "s.ctid::text";
    const textual = cols.filter(TEXTUAL);
    const remaining = limit - hits.length;
    if (textual.length) {
      const values = textual
        .map((c) =>
          c.type === "ARRAY"
            ? `('${c.name}', array_to_string(s.${qi(c.name)}, ' '))`
            : `('${c.name}', s.${qi(c.name)}::text)`,
        )
        .join(", ");
      const branches = [
        subRegex &&
          `select v.id, v.col, n.needle, n.kind from v join pg_temp.demo_scan_needles n
             on n.kind = 'sub' and strpos(v.lval, n.needle) > 0 where v.lval ~ $2`,
        `select v.id, v.col, n.needle, n.kind from v
           cross join lateral regexp_matches(v.val, '${DIGIT_RUN_SEPARATED}', 'g') m
           join pg_temp.demo_scan_needles n on n.kind = 'digits' and n.needle = regexp_replace(m[1], '[^0-9]', '', 'g')`,
        `select v.id, v.col, n.needle, n.kind from v
           cross join lateral regexp_matches(v.val, '${DIGIT_RUN}', 'g') m
           join pg_temp.demo_scan_needles n on n.kind = 'digits' and n.needle = m[1]`,
        `select v.id, v.col, n.needle, n.kind from v
           cross join lateral regexp_matches(v.val, '${EMAIL}', 'g') m
           join pg_temp.demo_scan_needles n on n.kind = 'email' and n.needle = lower(m[1])`,
        `select v.id, v.col, n.needle, n.kind from v
           cross join lateral regexp_matches(v.val, '${TOKEN}', 'g') m
           join pg_temp.demo_scan_needles n on n.kind = 'token' and n.needle = lower(m[1])`,
        `select v.id, v.col, n.needle, n.kind from v
           join pg_temp.demo_scan_needles n on n.kind = 'exact' and n.needle = v.lval`,
        useUuids &&
          `select v.id, v.col, u.id::text, 'uuid' from v
             cross join lateral regexp_matches(v.val, '(${UUID_PATTERN})', 'gi') m
             join pg_temp.demo_scan_uuids u on u.id = lower(m[1])::uuid`,
      ].filter(Boolean);
      const sql = `with v as materialized (
          select ${idExpr} as id, c.col, c.val, lower(c.val) as lval
            from public.${qi(table)} s
            cross join lateral (values ${values}) c(col, val)
           where ${where} and c.val is not null and length(c.val) >= 4
        )
        select distinct id, col, needle, kind from (${branches.join("\n union all \n")}) h
        limit ${remaining}`;
      const params = subRegex ? [tenantId, subRegex] : [tenantId];
      const { rows: found } = await client.query(sql, params);
      for (const r of found) hits.push({ table, column: r.col, id: r.id, needle: r.needle, kind: r.kind });
    }
    if (useUuids && table !== "tenants") {
      for (const c of cols.filter((c) => c.udt === "uuid" && c.name !== "tenant_id")) {
        if (hits.length >= limit) break;
        const { rows: found } = await client.query(
          `select ${idExpr} as id, s.${qi(c.name)}::text as needle
             from public.${qi(table)} s join pg_temp.demo_scan_uuids u on u.id = s.${qi(c.name)}
            where s.tenant_id = $1 limit ${limit - hits.length}`,
          [tenantId],
        );
        for (const r of found) hits.push({ table, column: c.name, id: r.id, needle: r.needle, kind: "uuid" });
      }
    }
  }
  return hits;
}

/** Every uuid held by a source-tenant row (ids, FKs, tokens) of the scanned tables. */
async function buildSourceUuidSet(client, columns, tables, sourceTenantId) {
  await client.query(`drop table if exists pg_temp.demo_scan_uuids`);
  await client.query(`create temp table demo_scan_uuids (id uuid primary key)`);
  await client.query(`insert into pg_temp.demo_scan_uuids values ($1::uuid) on conflict do nothing`, [sourceTenantId]);
  for (const table of tables) {
    for (const c of columns.get(table).filter((c) => c.udt === "uuid" && c.name !== "tenant_id")) {
      await client.query(
        `insert into pg_temp.demo_scan_uuids (id)
         select distinct s.${qi(c.name)} from public.${qi(table)} s
          where s.tenant_id = $1 and s.${qi(c.name)} is not null
         on conflict do nothing`,
        [sourceTenantId],
      );
    }
  }
  await client.query(`analyze pg_temp.demo_scan_uuids`);
}

export function formatHits(hits) {
  return hits.map((h) => `  ${h.table}.${h.column} id=${h.id} ${h.kind}:${h.needle}`).join("\n");
}
