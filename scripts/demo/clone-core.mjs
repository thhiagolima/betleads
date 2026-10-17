// Demo tenant clone, as a library (Task 12). The CLI (clone-tenant-demo.mjs)
// and the PGlite integration test both drive `cloneTenantDemo`.
//
// Everything runs in ONE transaction on a direct connection (ruling R2):
//   1. create/refresh the demo tenant row (is_demo = true, fresh webhook secrets)
//   2. build fake identities in JS (deterministic) and load them into temp tables
//   3. with session_replication_role = replica (no user triggers — they would
//      drop/alter copied rows — and no FK checks during the bulk copy), wipe
//      every demo row and copy each table of clone-plan.mjs, set-based in SQL
//      (or row by row in JS for small config tables)
//   4. back to origin: rebuild the aggregates for the demo, verify counts,
//      sums, every FK and that no row points at a player left out of the
//      sample, then run the PII scan
//   5. any scan hit → ROLLBACK; dry-run → ROLLBACK; --apply → upload the
//      Storage placeholders, then COMMIT
// Ruling R14: only a deterministic ~50% sample of the players (and everything
// hanging from them) is cloned — see clone-plan.mjs. Aggregates
// (crm_results_daily, player_lifecycle_daily, tenant_daily_metrics,
// crm_results_health) are therefore NOT copied but recomputed for the demo
// with the production per-tenant/per-day functions.
import { createHash, randomBytes } from "node:crypto";

import {
  DEMO_BRAND,
  DEMO_DOMAIN,
  DEMO_SLUG,
  demoUuid,
  fakeLoosePhones,
  fakePlayers,
  inDemoSample,
  makeRewriteContext,
  nationalDigits,
  phoneForms,
  normalizeHosts,
  remapUuidIn,
  rewriteJson,
  rewriteText,
  scrubJson,
  shortLinkMap,
  withPlayers,
} from "./anonymize.mjs";
import {
  CLONE_TABLES,
  KEEP_ON_RESET,
  LEASE_COLUMNS,
  PLAYER_REFS,
  REBUILT_TABLES,
  USER_COLUMNS,
  copySql,
  isInsertable,
  isJson,
  isTextArray,
  isTextual,
} from "./clone-plan.mjs";
import { collectNeedles, publicColumns, scanTenant } from "./pii-scan.mjs";
import { lit, rewriteFunctionsSql, setSecretSql } from "./sql-rewrite.mjs";
import { IMAGE_BUCKET, VOICE_BUCKET, placeholderLayout, readPlaceholders } from "./storage.mjs";

const BATCH = 5000;
const INSERT_BATCH = 500;
const FALLBACK_PHONE = "+5511900000000";

const parseJson = (value) => (typeof value === "string" ? JSON.parse(value) : value);

async function insertJsonRows(client, table, columnNames, rows) {
  const cols = columnNames.map((c) => `"${c}"`).join(", ");
  for (let i = 0; i < rows.length; i += INSERT_BATCH)
    await client.query(
      `insert into ${table} (${cols}) select ${cols} from json_populate_recordset(null::${table}, $1::json)`,
      [JSON.stringify(rows.slice(i, i + INSERT_BATCH))],
    );
}

async function foreignKeys(client) {
  const { rows } = await client.query(
    `select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent, c.conname,
            array(select a.attname::text from unnest(c.conkey) with ordinality k(n, o)
                    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n order by k.o) as child_cols,
            array(select a.attname::text from unnest(c.confkey) with ordinality k(n, o)
                    join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.n order by k.o) as parent_cols
       from pg_constraint c
      where c.contype = 'f' and c.connamespace = 'public'::regnamespace`,
  );
  const strip = (name) => name.replace(/^public\./, "");
  return rows.map((r) => ({ ...r, child: strip(r.child), parent: strip(r.parent) }));
}

/** Source tenant + demo tenant row (created or refreshed). */
async function prepareTenants(client, sourceSlug, targetSlug) {
  if (String(sourceSlug).toLowerCase() === String(targetSlug).toLowerCase())
    throw new Error("source and target are the same tenant");
  const { rows: sources } = await client.query(`select * from public.tenants where slug = $1`, [sourceSlug]);
  const source = sources[0];
  if (!source) throw new Error(`source tenant '${sourceSlug}' not found`);
  if (source.is_demo) throw new Error(`source tenant '${sourceSlug}' is a demo tenant`);
  const { rows: targets } = await client.query(`select * from public.tenants where slug = $1`, [targetSlug]);
  const existing = targets[0];
  if (existing && !existing.is_demo)
    throw new Error(`tenant '${targetSlug}' exists and is not a demo tenant — refusing to overwrite it`);
  if (existing && existing.id === source.id) throw new Error("source and target are the same tenant");
  const demoTenantId = existing?.id ?? demoUuid(source.id);
  const { rows: byId } = await client.query(`select is_demo from public.tenants where id = $1`, [demoTenantId]);
  if (byId[0] && !byId[0].is_demo)
    throw new Error(`tenant ${demoTenantId} exists and is not a demo tenant — refusing to overwrite it`);
  const values = [
    demoTenantId,
    DEMO_BRAND,
    targetSlug,
    source.plano,
    source.crm_model,
    randomBytes(24).toString("hex"),
    randomBytes(32).toString("hex"),
    JSON.stringify(source.limits ?? {}),
  ];
  await client.query(
    `insert into public.tenants (id, nome, slug, status, plano, crm_model, webhook_token, webhook_secret,
                                 webhook_hmac_enforced, metadata, legacy_webhook, limits, is_demo)
     values ($1, $2, $3, 'active', $4, $5, $6, $7, true, '{}'::jsonb, false, $8::jsonb, true)
     on conflict (id) do update set
       nome = excluded.nome, slug = excluded.slug, status = 'active', plano = excluded.plano,
       crm_model = excluded.crm_model, webhook_token = excluded.webhook_token,
       webhook_secret = excluded.webhook_secret, webhook_hmac_enforced = true, metadata = '{}'::jsonb,
       legacy_webhook = false, limits = excluded.limits, is_demo = true
     where public.tenants.is_demo`,
    values,
  );
  // The guarded upsert writes nothing when the row is not a demo tenant.
  const { rows: check } = await client.query(`select is_demo, slug from public.tenants where id = $1`, [demoTenantId]);
  if (!check[0]?.is_demo || check[0].slug !== targetSlug)
    throw new Error(`could not create/refresh demo tenant '${targetSlug}' — refusing to continue`);
  return { source, demoTenantId };
}

/** Fake identities (JS, deterministic) loaded into pg_temp tables for the SQL copy. */
async function loadFakeIdentities(client, sourceTenantId, needles, secret) {
  const { rows: players } = await client.query(
    `select id::text as id, nome, telefone, email, cpf, data_nascimento::text as data_nascimento,
            player_external_id, affiliate_id, expert
       from public.players where tenant_id = $1`,
    [sourceTenantId],
  );
  const avoidForms = new Set([...needles.phones.flatMap(phoneForms), ...needles.cpfs]);
  const fakes = fakePlayers(players, { avoidForms, avoidNames: new Set(needles.names ?? []), secret });

  const phoneMap = new Map();
  const emailMap = new Map();
  const used = new Set();
  const playerByNat = new Map();
  for (const player of [...players].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const fake = fakes.get(player.id);
    for (const form of phoneForms(fake.telefone)) used.add(`t:${form}`);
    if (player.telefone && fake.telefone) {
      const nat = nationalDigits(player.telefone);
      if (nat && !phoneMap.has(nat)) {
        phoneMap.set(nat, fake.telefone);
        playerByNat.set(nat, player.id);
      }
    }
    if (player.email && fake.email) emailMap.set(String(player.email).toLowerCase(), fake.email);
  }
  const loose = needles.phones.map(nationalDigits).filter((nat) => nat && !phoneMap.has(nat));
  for (const [nat, fake] of fakeLoosePhones(loose, { avoidForms, used, secret })) phoneMap.set(nat, fake);

  await client.query(`drop table if exists pg_temp.demo_fake_players`);
  await client.query(
    `create temp table demo_fake_players (src_id uuid primary key, nome text, telefone text, email text,
       cpf text, data_nascimento date, player_external_id text, affiliate_id text, expert text)`,
  );
  await insertJsonRows(
    client,
    "pg_temp.demo_fake_players",
    ["src_id", "nome", "telefone", "email", "cpf", "data_nascimento", "player_external_id", "affiliate_id", "expert"],
    players.map((p) => ({ src_id: p.id, ...fakes.get(p.id) })),
  );
  await client.query(`drop table if exists pg_temp.demo_fake_phones`);
  await client.query(`create temp table demo_fake_phones (nat text primary key, fake text not null)`);
  await insertJsonRows(
    client,
    "pg_temp.demo_fake_phones",
    ["nat", "fake"],
    [...phoneMap].map(([nat, fake]) => ({ nat, fake })),
  );
  // Phone → player (first player by id with that national number): rows that
  // carry a phone but no player follow that player's sample (R14).
  await client.query(`drop table if exists pg_temp.demo_phone_player`);
  await client.query(`create temp table demo_phone_player (nat text primary key, src_id uuid not null)`);
  await insertJsonRows(
    client,
    "pg_temp.demo_phone_player",
    ["nat", "src_id"],
    [...playerByNat].map(([nat, src_id]) => ({ nat, src_id })),
  );
  await client.query(
    `create or replace function pg_temp.demo_phone_in_sample(t text) returns boolean language sql stable as $f$
  select case when t is null then false else coalesce(
    (select pg_temp.demo_in_sample(pp.src_id::text) from pg_temp.demo_phone_player pp where pp.nat = pg_temp.demo_nat(t)),
    pg_temp.demo_in_sample(pg_temp.demo_nat(t))) end
$f$`,
  );
  await client.query(`analyze pg_temp.demo_fake_players`);
  await client.query(`analyze pg_temp.demo_fake_phones`);
  await client.query(`analyze pg_temp.demo_phone_player`);

  const playerCtx = new Map(players.map((p) => [p.id, { source: p, fake: fakes.get(p.id) }]));
  return { fakes, phoneMap, emailMap, playerCtx, playerByNat, players };
}

function makeEnv({ ctx, identities, layout, placeholders, fkTargets, cloned, demoTenantId }) {
  const contexts = new Map();
  const forPlayer = (playerId) => {
    const p = playerId && identities.playerCtx.get(playerId);
    if (!p) return ctx;
    if (!contexts.has(playerId)) contexts.set(playerId, withPlayers(ctx, [p]));
    return contexts.get(playerId);
  };
  const fakePhone = (raw, playerId) => {
    if (raw === null || raw === undefined || raw === "") return raw ?? null;
    const byPlayer = playerId && identities.fakes.get(String(playerId))?.telefone;
    if (byPlayer) return byPlayer;
    return identities.phoneMap.get(nationalDigits(raw)) ?? FALLBACK_PHONE;
  };
  /** JS twin of pg_temp.demo_phone_in_sample. */
  const phoneInSample = (raw) => {
    if (raw === null || raw === undefined) return false;
    const nat = nationalDigits(raw);
    const playerId = identities.playerByNat.get(nat);
    return inDemoSample(playerId ?? nat);
  };
  const recipientInSample = (item) => {
    if (typeof item === "string") return phoneInSample(item);
    if (!item || typeof item !== "object") return false;
    return item.playerId ? inDemoSample(String(item.playerId)) : phoneInSample(item.phone);
  };
  return {
    ctx,
    identities,
    layout,
    placeholders,
    fkTargets,
    cloned,
    demoTenantId,
    forPlayer,
    fakePhone,
    recipientInSample,
  };
}

/** Recipients of the sample only (R14), with fake phones and remapped player ids. */
function mapRecipients(list, env) {
  if (!Array.isArray(list)) return list === null || list === undefined ? list : [];
  return list.filter(env.recipientInSample).map((item) => {
    if (typeof item === "string") return env.fakePhone(item, null);
    if (!item || typeof item !== "object") return item;
    const out = { phone: env.fakePhone(item.phone, item.playerId) };
    if (item.playerId) out.playerId = remapUuidIn(env.ctx, String(item.playerId));
    if (item.reason) out.reason = item.reason;
    return out;
  });
}

const JS_OVERRIDES = {
  journey_voice_assets(out, _row, env) {
    out.storage_path = env.layout.voiceAssetPath(out.id);
    out.content_type = "audio/mpeg";
    out.size_bytes = env.placeholders.audio.length;
    out.duration_seconds = env.placeholders.audioSeconds;
  },
  email_senders(out, row) {
    const tag = createHash("md5").update(`sender:${row.id}`).digest("hex").slice(0, 8);
    out.from_email = `remetente${tag}@example.com`;
    if (row.reply_to) out.reply_to = `resposta${tag}@example.com`;
    if (row.domain) out.domain = "example.com";
  },
  // Campaigns are configuration and are all kept, but their recipient lists
  // only name sampled players; the counters shrink in the same proportion
  // (the per-send truth is in sms_send_logs / crm_results_daily).
  sms_campaigns(out, row, env) {
    out.recipients = mapRecipients(row.recipients, env);
    out.unresolved_recipients = mapRecipients(row.unresolved_recipients, env);
    const ratio = (before, after) =>
      Array.isArray(before) && before.length ? after.length / before.length : 1;
    const r = ratio(row.recipients, out.recipients);
    const scale = (value, factor) => Math.round(Number(value ?? 0) * factor);
    for (const key of ["total_count", "sent_count", "failed_count", "deduplicated_count", "sent_cursor"])
      if (key in row) out[key] = scale(row[key], r);
    if ("unresolved_count" in row)
      out.unresolved_count = scale(row.unresolved_count, ratio(row.unresolved_recipients, out.unresolved_recipients));
  },
};

function transformRow(row, cols, spec, env) {
  const out = {};
  for (const c of cols) {
    const value = row[c.name];
    const fkTarget = env.fkTargets.get(`${spec.table}.${c.name}`);
    let next;
    if (c.name === "tenant_id") next = env.demoTenantId;
    else if (LEASE_COLUMNS.has(c.name)) next = null;
    else if (fkTarget && !env.cloned.has(fkTarget)) next = null;
    else if (USER_COLUMNS.has(c.name) && c.udt === "uuid") next = null;
    else if (value === null || value === undefined) next = null;
    else if (c.udt === "uuid") next = remapUuidIn(env.ctx, String(value));
    else if (isTextual(c)) next = rewriteText(value, env.ctx);
    else if (isTextArray(c)) next = value.map((item) => rewriteText(item, env.ctx));
    else if (isJson(c)) {
      const keep = spec.keep?.[c.name];
      next = rewriteJson(keep ? scrubJson(value, keep) : value, env.ctx);
    } else next = value;
    out[c.name] = next;
  }
  JS_OVERRIDES[spec.table]?.(out, row, env);
  return out;
}

async function copyJsTable(client, spec, cols, sourceTenantId, env) {
  const { rows } = await client.query(`select to_jsonb(s) as j from public.${spec.table} s where s.tenant_id = $1`, [
    sourceTenantId,
  ]);
  const out = rows.map((r) => transformRow(parseJson(r.j), cols, spec, env));
  await insertJsonRows(client, `public.${spec.table}`, cols.map((c) => c.name), out);
}

/** Free-text columns of a big table rewritten in JS batches into pg_temp.demo_js_<table>. */
async function preloadJsText(client, spec, sourceTenantId, env) {
  const { columns, player, phone } = spec.jsText;
  const temp = `demo_js_${spec.table}`;
  await client.query(`drop table if exists pg_temp.${temp}`);
  await client.query(`create temp table ${temp} (id uuid primary key, ${columns.map((c) => `${c} text`).join(", ")})`);
  let last = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const { rows } = await client.query(
      `select s.id::text as id, ${columns.map((c) => `s.${c}`).join(", ")},
              ${player ? `s.${player}::text` : "null"} as _player, ${phone ? `s.${phone}` : "null"} as _phone
         from public.${spec.table} s
        where s.tenant_id = $1 and s.id > $2::uuid${spec.sample ? ` and (${spec.sample})` : ""}
        order by s.id limit ${BATCH}`,
      [sourceTenantId, last],
    );
    if (!rows.length) break;
    last = rows[rows.length - 1].id;
    const out = rows.map((r) => {
      const known = r._player && env.identities.playerCtx.has(r._player) ? r._player : null;
      const playerId = known ?? (r._phone ? env.identities.playerByNat.get(nationalDigits(r._phone)) : null);
      const local = env.forPlayer(playerId);
      const row = { id: r.id };
      for (const c of columns) row[c] = rewriteText(r[c], local);
      return row;
    });
    await insertJsonRows(client, `pg_temp.${temp}`, ["id", ...columns], out);
    if (rows.length < BATCH) break;
  }
}

async function countPair(client, table, sourceTenantId, demoTenantId) {
  const { rows } = await client.query(
    `select (select count(*) from public.${table} where tenant_id = $1)::int as source,
            (select count(*) from public.${table} where tenant_id = $2)::int as demo`,
    [sourceTenantId, demoTenantId],
  );
  return rows[0];
}

/**
 * counts: [{ table, source, demo, expected, mode }] where mode is "whole"
 * (expected = source), "sample" (expected = source rows matching the sample
 * predicate) or "rebuilt" (aggregate recomputed; expected = null).
 */
async function verify(client, { specs, rebuilt, fks, sourceTenantId, demoTenantId }) {
  const counts = [];
  const problems = [];
  const tables = [...specs.map((s) => s.table), ...rebuilt];
  for (const spec of specs) {
    const pair = await countPair(client, spec.table, sourceTenantId, demoTenantId);
    let expected = pair.source;
    if (spec.sample) {
      const { rows } = await client.query(
        `select count(*)::int as n from public.${spec.table} s where s.tenant_id = $1 and (${spec.sample})`,
        [sourceTenantId],
      );
      expected = rows[0].n;
    }
    counts.push({ table: spec.table, ...pair, expected, mode: spec.sample ? "sample" : "whole" });
    if (pair.demo !== expected) problems.push(`${spec.table}: expected ${expected} × demo ${pair.demo}`);
  }
  for (const table of rebuilt) {
    const pair = await countPair(client, table, sourceTenantId, demoTenantId);
    counts.push({ table, ...pair, expected: null, mode: "rebuilt" });
  }
  for (const spec of specs.filter((s) => ["deposits", "withdrawals"].includes(s.table))) {
    const { rows } = await client.query(
      `select (select coalesce(sum(s.valor), 0) from public.${spec.table} s
                where s.tenant_id = $1 and (${spec.sample ?? "true"}))::text as source,
              (select coalesce(sum(valor), 0) from public.${spec.table} where tenant_id = $2)::text as demo`,
      [sourceTenantId, demoTenantId],
    );
    if (rows[0].source !== rows[0].demo)
      problems.push(`${spec.table}.valor sum: sampled source ${rows[0].source} × demo ${rows[0].demo}`);
  }
  // R14: no demo row may point at a player left out of the sample.
  await client.query(`drop table if exists pg_temp.demo_unsampled`);
  await client.query(`create temp table demo_unsampled (id uuid primary key)`);
  await client.query(
    `insert into pg_temp.demo_unsampled (id)
     select pg_temp.demo_uuid(p.id) from public.players p
      where p.tenant_id = $1 and not pg_temp.demo_in_sample(p.id::text)`,
    [sourceTenantId],
  );
  for (const [table, column] of PLAYER_REFS.filter(([t]) => tables.includes(t))) {
    const { rows } = await client.query(
      `select count(*)::int as n from public.${table} c join pg_temp.demo_unsampled u on u.id = c."${column}"
        where c.tenant_id = $1`,
      [demoTenantId],
    );
    if (rows[0].n) problems.push(`${table}.${column}: ${rows[0].n} row(s) point at players outside the sample`);
  }
  if (tables.includes("sms_campaigns")) {
    const { rows } = await client.query(
      `select count(*)::int as n from public.sms_campaigns c
         cross join lateral jsonb_array_elements(
           case when jsonb_typeof(c.recipients) = 'array' then c.recipients else '[]'::jsonb end
           || case when jsonb_typeof(c.unresolved_recipients) = 'array' then c.unresolved_recipients else '[]'::jsonb end) e
         join pg_temp.demo_unsampled u on u.id::text = e->>'playerId'
        where c.tenant_id = $1`,
      [demoTenantId],
    );
    if (rows[0].n) problems.push(`sms_campaigns recipients: ${rows[0].n} point at players outside the sample`);
  }
  for (const fk of fks.filter((f) => tables.includes(f.child))) {
    const cols = fk.child_cols.map((c, i) => ({ c, p: fk.parent_cols[i] }));
    const parent = fk.parent.includes(".") ? fk.parent : `public.${fk.parent}`;
    const { rows } = await client.query(
      `select count(*)::int as n from public.${fk.child} c
        where c.tenant_id = $1 and ${cols.map(({ c }) => `c."${c}" is not null`).join(" and ")}
          and not exists (select 1 from ${parent} p where ${cols.map(({ c, p }) => `p."${p}" = c."${c}"`).join(" and ")})`,
      [demoTenantId],
    );
    if (rows[0].n) problems.push(`${fk.child} → ${fk.parent} (${fk.conname}): ${rows[0].n} dangling`);
  }
  return { counts, problems };
}

/**
 * Builds the demo inside the caller's open transaction. Returns counts, scan
 * hits and the Storage plan; never commits.
 */
export async function buildDemo(
  client,
  { sourceSlug, targetSlug = DEMO_SLUG, storageBaseUrl = "", log = () => {}, secret = randomBytes(32).toString("hex") },
) {
  const started = Date.now();
  const step = (message) => log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
  const { source, demoTenantId } = await prepareTenants(client, sourceSlug, targetSlug);
  step(`source ${source.slug} (${source.id}) → demo ${targetSlug} (${demoTenantId})`);

  const columns = await publicColumns(client);
  const fks = await foreignKeys(client);
  const fkTargets = new Map(fks.filter((f) => f.child_cols.length === 1).map((f) => [`${f.child}.${f.child_cols[0]}`, f.parent]));
  const specs = CLONE_TABLES.filter((spec) => columns.has(spec.table));
  const cloned = new Set(specs.map((s) => s.table));
  const layout = placeholderLayout(demoTenantId, storageBaseUrl);
  const placeholders = readPlaceholders();
  const storageHost = (() => {
    try {
      return new URL(storageBaseUrl).hostname;
    } catch {
      return null;
    }
  })();

  const needles = await collectNeedles(client, source.id, { excludeHosts: storageHost ? [storageHost] : [] });
  step(`needles: ${needles.phones.length} phones, ${needles.emails.length} e-mails, ${needles.domains.length} hosts`);
  // Per-run secret: transaction-local setting, passed as a bind parameter.
  await client.query(setSecretSql, [secret]);
  const { rows: links } = columns.has("tracked_links")
    ? await client.query(`select id::text as id, short_url from public.tracked_links where tenant_id = $1`, [source.id])
    : { rows: [] };
  const shortMap = shortLinkMap(links);
  const shortHosts = normalizeHosts([
    ...[...shortMap.keys()].map((key) => key.split("/")[0]),
    ...(columns.has("shortio_settings")
      ? (await client.query(`select domain from public.shortio_settings where tenant_id = $1`, [source.id])).rows.map(
          (r) => r.domain,
        )
      : []),
  ]);
  for (const sql of rewriteFunctionsSql({
    sourceTenantId: source.id,
    demoTenantId,
    hosts: needles.domains,
    brandNames: [source.nome],
    shortHosts,
  }))
    await client.query(sql);
  await insertJsonRows(
    client,
    "pg_temp.demo_short_map",
    ["key", "dst"],
    [...shortMap].map(([key, dst]) => ({ key, dst })),
  );
  const identities = await loadFakeIdentities(client, source.id, needles, secret);
  step(`fake identities: ${identities.players.length} players, ${identities.phoneMap.size} phones`);

  const voiceExact = columns.has("journey_voice_assets")
    ? (
        await client.query(`select id::text as id, storage_path from public.journey_voice_assets where tenant_id = $1`, [
          source.id,
        ])
      ).rows.map((r) => [r.storage_path, layout.voiceAssetPath(demoUuid(r.id))])
    : [];
  const ctx = makeRewriteContext({
    sourceTenantId: source.id,
    demoTenantId,
    hosts: needles.domains,
    brandNames: [source.nome],
    exact: voiceExact,
    imageUrl: layout.imageUrl,
    phoneMap: identities.phoneMap,
    emailMap: identities.emailMap,
    shortHosts,
    shortMap,
    secret,
  });
  const env = makeEnv({ ctx, identities, layout, placeholders, fkTargets, cloned, demoTenantId });

  await client.query(`set local session_replication_role = replica`);
  for (const [table, cols] of columns) {
    if (KEEP_ON_RESET(table) || !cols.some((c) => c.name === "tenant_id")) continue;
    await client.query(`delete from public.${table} where tenant_id = $1`, [demoTenantId]);
  }
  step("previous demo rows deleted");

  const sqlValues = { audioUrl: lit(layout.audioUrl), demoDomain: lit(DEMO_DOMAIN) };
  for (const spec of specs) {
    const cols = columns.get(spec.table).filter(isInsertable);
    // Hook statements without parameters (DDL) must not be sent any.
    for (const sql of spec.prepare ?? []) await client.query(sql, /\$1/.test(sql) ? [source.id] : []);
    if (spec.mode === "js") await copyJsTable(client, spec, cols, source.id, env);
    else {
      if (spec.jsText) await preloadJsText(client, spec, source.id, env);
      await client.query(copySql(spec, cols, { fkTargets, cloned, demoTenantId, values: sqlValues }), [source.id]);
    }
    for (const sql of spec.after ?? []) await client.query(sql, [source.id, demoTenantId]);
    step(`copied ${spec.table}`);
  }
  await client.query(`set local session_replication_role = origin`);

  const rebuilt = REBUILT_TABLES.filter((r) => columns.has(r.table));
  for (const { table, fn, stamp } of rebuilt) {
    const { rows: days } = await client.query(
      `select distinct metric_date::text as day from public.${table} where tenant_id = $1 order by 1`,
      [source.id],
    );
    for (const { day } of days) await client.query(`select public.${fn}($1::uuid, $2::date)`, [demoTenantId, day]);
    await client.query(
      `update public.${table} set ${stamp} = (select max(${stamp}) from public.${table} where tenant_id = $1)
        where tenant_id = $2`,
      [source.id, demoTenantId],
    );
    step(`rebuilt ${table} (${days.length} day(s))`);
  }
  const rebuiltTables = rebuilt.map((r) => r.table);

  const { counts, problems } = await verify(client, {
    specs,
    rebuilt: rebuiltTables,
    fks,
    sourceTenantId: source.id,
    demoTenantId,
  });
  if (problems.length) throw new Error(`clone verification failed:\n  ${problems.join("\n  ")}`);
  step("counts, sums, foreign keys and the player sample verified");

  const hits = await scanTenant(client, demoTenantId, needles, {
    sourceTenantId: source.id,
    tables: [...cloned, ...rebuiltTables, "tenants"],
  });
  step(`PII scan: ${hits.length} hit(s)`);

  const { rows: assets } = columns.has("journey_voice_assets")
    ? await client.query(`select storage_path from public.journey_voice_assets where tenant_id = $1`, [demoTenantId])
    : { rows: [] };
  const storagePlan = {
    prefixes: layout.prefixes,
    objects: [
      { bucket: VOICE_BUCKET, path: layout.audioPath, bytes: placeholders.audio, contentType: "audio/mpeg" },
      { bucket: IMAGE_BUCKET, path: layout.imagePath, bytes: placeholders.image, contentType: "image/png" },
      ...assets.map((a) => ({ bucket: VOICE_BUCKET, path: a.storage_path, bytes: placeholders.audio, contentType: "audio/mpeg" })),
    ],
  };
  return { sourceTenantId: source.id, demoTenantId, counts, hits, storagePlan };
}

/**
 * One transaction: build, scan, then COMMIT (apply) or ROLLBACK (dry-run or
 * any scan hit). `storage.replace(plan)` runs only AFTER a successful COMMIT
 * (a failed upload leaves committed rows pointing at missing placeholders,
 * which a rerun fixes; it can never leave uploads without the rows).
 */
export async function cloneTenantDemo(
  client,
  { apply = false, storage = null, statementTimeoutMs = 60 * 60 * 1000, ...options },
) {
  if (apply && !storage) throw new Error("--apply needs a storage adapter for the placeholders");
  await client.query("begin");
  let open = true;
  try {
    await client.query(`set local statement_timeout = ${Number(statementTimeoutMs)}`);
    const result = await buildDemo(client, options);
    if (result.hits.length || !apply) {
      await client.query("rollback");
      open = false;
      return { ...result, ok: result.hits.length === 0, applied: false };
    }
    await client.query("commit");
    open = false;
    try {
      await storage.replace(result.storagePlan);
    } catch (error) {
      throw new Error(
        `demo data COMMITTED, but the Storage placeholders failed (${error?.message ?? error}); run --apply again`,
      );
    }
    return { ...result, ok: true, applied: true };
  } finally {
    if (open) await client.query("rollback").catch(() => {});
  }
}
