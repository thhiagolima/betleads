// Task 12 — integration test of the demo clone on a PGlite database with every
// migration applied (real columns, constraints and triggers). Synthetic source
// tenant: Maria, Pedro and Carla are inside the R14 player sample, José is
// not (each has rows across the player-linked tables), plus 300 bulk players
// with one deposit each to measure the sample ratio.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { inDemoSample, remapId } from "./anonymize.mjs";
import { CLONE_TABLES, REBUILT_TABLES } from "./clone-plan.mjs";
import { cloneTenantDemo } from "./clone-core.mjs";
import { collectNeedles, scanTenant } from "./pii-scan.mjs";
import { createMigratedDb } from "./test-support/migrated-pglite.mjs";

const SOURCE = "03b73a96-aef7-414d-94fc-93a996f8256b";
const MARIA = "6f1d2c3b-0000-4000-8000-000000000001";
const JOSE = "6f1d2c3b-0000-4000-8000-000000000002"; // outside the sample
const CARLA = "6f1d2c3b-0000-4000-8000-000000000003";
const PEDRO = "6f1d2c3b-0000-4000-8000-000000000006";
const JOURNEY = "6f1d2c3b-0000-4000-8000-0000000000a0";
const STEP = "6f1d2c3b-0000-4000-8000-0000000000a1";
const ENR_M = "6f1d2c3b-0000-4000-8000-0000000000a2";
const ENR_J = "6f1d2c3b-0000-4000-8000-0000000000a3";
const EXE_M = "6f1d2c3b-0000-4000-8000-0000000000a4";
const EXE_J = "6f1d2c3b-0000-4000-8000-0000000000a5";
const SMS_1 = "6f1d2c3b-0000-4000-8000-0000000000b1";
const SMS_2 = "6f1d2c3b-0000-4000-8000-0000000000b2";
const SMS_J1 = "6f1d2c3b-0000-4000-8000-0000000000b3";
const SMS_J2 = "6f1d2c3b-0000-4000-8000-0000000000b4";
const LINK = "6f1d2c3b-0000-4000-8000-0000000000c1";
const DISPATCH = "6f1d2c3b-0000-4000-8000-0000000000c2";
const TOKEN = "6f1d2c3b-0000-4000-8000-0000000000c3";
const LINK_J = "6f1d2c3b-0000-4000-8000-0000000000c4";
const DISPATCH_J = "6f1d2c3b-0000-4000-8000-0000000000c5";
const TOKEN_J = "6f1d2c3b-0000-4000-8000-0000000000c6";
const QUEUE_J = "6f1d2c3b-0000-4000-8000-0000000000d1";
const CAMPAIGN = "6f1d2c3b-0000-4000-8000-0000000000e1";
const STORAGE = "https://project.storage.test";
const BULK = 300;

/** Every source id that belongs to José (must leave no trace in the demo). */
const JOSE_IDS = [JOSE, ENR_J, EXE_J, SMS_J1, SMS_J2, LINK_J, DISPATCH_J, TOKEN_J, QUEUE_J];

let db: PGlite;
const uploads: unknown[] = [];
const storage = {
  async replace(plan: unknown) {
    uploads.push(plan);
  },
};

const run = (apply: boolean) =>
  cloneTenantDemo(db, { sourceSlug: "pixpgf", targetSlug: "demo", apply, storage, storageBaseUrl: STORAGE });

type Count = { table: string; source: number; demo: number; expected: number | null; mode: string };

async function demoId(): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(`select id from public.tenants where slug = 'demo'`);
  return rows[0]?.id ?? null;
}

const ALL_TABLES = [...CLONE_TABLES.map((t) => t.table), ...REBUILT_TABLES.map((t) => t.table)];

/** Every demo row of every cloned or rebuilt table, canonically ordered. */
async function snapshot() {
  const id = await demoId();
  const out: Record<string, string[]> = {};
  for (const table of ALL_TABLES) {
    const { rows } = await db.query<{ j: string }>(
      `select to_jsonb(t)::text as j from public.${table} t where tenant_id = $1 order by 1`,
      [id],
    );
    out[table] = rows.map((r) => r.j);
  }
  return out;
}

async function seed() {
  // A migration seeds an unrelated 'pixpgf' row; move it out of the way.
  await db.query(`update public.tenants set slug = 'pixpgf-seed' where slug = 'pixpgf'`);
  await db.query(
    `insert into public.tenants (id, nome, slug, status, plano) values ($1, 'Sorte Alta', 'pixpgf', 'active', 'pro')`,
    [SOURCE],
  );
  await db.query(
    `insert into public.players (id, tenant_id, nome, telefone, email, cpf, data_nascimento, player_external_id,
                                 affiliate_id, expert, origem, utm_campaign, total_depositado)
     values ($2, $1, 'Maria Souza', '+5521987654321', 'maria.souza@gmail.com', '52998224725', '1990-05-17',
             '884512', 'AFF77SORTE', 'Joao Expert', 'site', 'sortealta-outubro', 150),
            ($3, $1, 'Pedro Alves', '+5511912345678', 'pedro.alves@hotmail.com', '11144477735', '1985-01-02',
             'EXT2002', 'AFF77SORTE', null, 'site', null, 40),
            ($4, $1, 'Carla', null, null, null, null, null, null, null, null, null, 0),
            ($5, $1, 'Jose Lima', '+5531988887777', 'jose.lima@uol.com.br', '39053344705', '1979-03-03',
             'EXT3003', 'AFF88SORTE', null, 'site', null, 100)`,
    [SOURCE, MARIA, PEDRO, CARLA, JOSE],
  );
  await db.query(
    `insert into public.players (id, tenant_id, nome, origem)
     select md5('bulk-player-' || i)::uuid, $1, 'Jogador ' || i, 'site' from generate_series(1, ${BULK}) i`,
    [SOURCE],
  );
  await db.query(
    `insert into public.deposits (tenant_id, player_id, valor, status, external_id, event_id, raw_payload)
     values ($1, $2, 100.50, 'aprovado', 'tx-1', 'ev-1', '{"cpf":"52998224725","telefone":"5521987654321"}'),
            ($1, $2, 49.50, 'aprovado', 'tx-2', 'ev-2', '{}'),
            ($1, $3, 40, 'aprovado', 'tx-3', 'ev-3', '{"email":"pedro.alves@hotmail.com"}'),
            ($1, $3, 10, 'pending', 'tx-4', null, '{}'),
            ($1, $4, 70, 'aprovado', 'tx-5', 'ev-5', '{}'),
            ($1, $4, 30, 'aprovado', 'tx-6', 'ev-6', '{}')`,
    [SOURCE, MARIA, PEDRO, JOSE],
  );
  await db.query(
    `insert into public.deposits (tenant_id, player_id, valor, status, external_id)
     select $1, md5('bulk-player-' || i)::uuid, i, 'aprovado', 'bulk-tx-' || i from generate_series(1, ${BULK}) i`,
    [SOURCE],
  );
  await db.query(
    `insert into public.events (tenant_id, player_id, tipo, metadata, provider_event_id)
     values ($1, $2, 'login', '{"jogo":"Aviator","telefone":"5521987654321","nome":"Maria Souza"}', 'login:884512:1'),
            ($1, $3, 'login', '{"jogo":"Mines"}', 'login:EXT3003:1')`,
    [SOURCE, MARIA, JOSE],
  );
  await db.query(
    `insert into public.journeys (id, tenant_id, name, status, trigger_type, trigger_config, entry_rules)
     values ($2, $1, 'Boas-vindas Sorte Alta', 'active', 'lead_cadastrado',
             '{"landing":"https://sortealta.bet/cadastro"}', '{"reentry":"once"}')`,
    [SOURCE, JOURNEY],
  );
  await db.query(
    `insert into public.journey_steps (id, tenant_id, journey_id, position, step_type, label, config)
     values ($2, $1, $3, 1, 'sms', 'SMS Sorte Alta',
             '{"variants":[{"content":"Oi {{nome}}, a Sorte Alta te espera: https://sortealta.bet/promo?btag=AFF77SORTE"}],
               "test_phone":"+5521987654321"}')`,
    [SOURCE, STEP, JOURNEY],
  );
  await db.query(
    `insert into public.journey_enrollments (id, tenant_id, journey_id, journey_version, player_id, entry_key, status,
                                             claimed_at, claimed_by, metadata)
     values ($5, $1, $2, 1, $3, 'once', 'completed', now(), 'worker-1', '{"deposited_before_entry":150,"phone":"5521987654321"}'),
            (gen_random_uuid(), $1, $2, 1, $4, 'once', 'completed', null, null, '{}'),
            ($7, $1, $2, 1, $6, 'once', 'completed', null, null, '{}')`,
    [SOURCE, JOURNEY, MARIA, PEDRO, ENR_M, JOSE, ENR_J],
  );
  await db.query(
    `insert into public.journey_step_executions (id, tenant_id, journey_id, enrollment_id, step_id, step_position, status)
     values ($2, $1, $3, $4, $5, 1, 'sent'), ($6, $1, $3, $7, $5, 1, 'sent')`,
    [SOURCE, EXE_M, JOURNEY, ENR_M, STEP, EXE_J, ENR_J],
  );
  await db.query(
    `insert into public.journey_events (tenant_id, journey_id, enrollment_id, execution_id, event_type)
     values ($1, $2, $3, $4, 'step_sent'), ($1, $2, $5, $6, 'step_sent'), ($1, $2, null, null, 'journey_activated')`,
    [SOURCE, JOURNEY, ENR_M, EXE_M, ENR_J, EXE_J],
  );
  await db.query(
    `insert into public.sms_send_logs (id, tenant_id, to_phone, content, status, provider, player_id,
                                       provider_message_id, idempotency_key, trigger_name, provider_response, last_callback)
     values ($2, $1, '+5521987654321', 'Oi Maria, acesse https://sortealta.link/AbC1 - Sorte Alta', 'sent', 'shortcode',
             $3, 'sc-777', 'journey:' || $5 || ':5521987654321', 'journey:' || $5,
             '{"to":"5521987654321","id":"sc-777","billing_reference_id":"bill-M"}',
             '{"status":"DELIVERED","msisdn":"5521987654321"}'),
            ($4, $1, '5511912345678', 'Pedro, seu bônus na SORTE ALTA', 'sent', 'shortcode',
             null, 'sc-778', null, 'campanha:Outubro:1', '{}', null),
            ($6, $1, '+5531988887777', 'Oi Jose, volte para a Sorte Alta', 'sent', 'shortcode',
             $7, 'sc-779', null, 'journey:' || $5, '{"billing_reference_id":"bill-J1"}', null),
            ($8, $1, '5531988887777', 'Jose, bônus na SORTE ALTA', 'sent', 'shortcode',
             null, 'sc-780', null, 'campanha:Outubro:1', '{"billing_reference_id":"bill-J2"}', null)`,
    [SOURCE, SMS_1, MARIA, SMS_2, JOURNEY, SMS_J1, JOSE, SMS_J2],
  );
  await db.query(
    `insert into public.sms_credit_ledger (tenant_id, delta_credits, balance_after, entry_type, reference_type,
                                           reference_id, created_at)
     values ($1, 100, 100, 'purchase', null, null, '2026-10-01T10:00:00Z'),
            ($1, -1, 99, 'sms_reservation', 'sms_send', 'bill-M', '2026-10-01T11:00:00Z'),
            ($1, -1, 98, 'sms_reservation', 'sms_send', 'bill-J1', '2026-10-01T12:00:00Z'),
            ($1, -1, 97, 'sms_reservation', 'sms_send', 'bill-J2', '2026-10-01T13:00:00Z'),
            ($1, 10, 107, 'manual_adjustment', null, null, '2026-10-01T14:00:00Z')`,
    [SOURCE],
  );
  await db.query(
    `insert into public.tenant_sms_credit_balances (tenant_id, balance_credits, lifetime_purchased_credits,
                                                    lifetime_manual_credits, lifetime_used_credits)
     values ($1, 107, 100, 10, 3)`,
    [SOURCE],
  );
  await db.query(
    `insert into public.tracked_links (id, tenant_id, shortio_link_id, short_url, original_url, canonical_url_hash, path, status)
     values ($2, $1, 'lnk_RealShort01', 'https://sortealta.link/AbC1',
             'https://betleads.io/api/public/click/' || $3 || '?s=sig123', 'hash-1', 'AbC1', 'active'),
            ($4, $1, 'lnk_RealShort02', 'https://sortealta.link/JoS2',
             'https://betleads.io/api/public/click/' || $5 || '?s=sig456', 'hash-2', 'JoS2', 'active')`,
    [SOURCE, LINK, TOKEN, LINK_J, TOKEN_J],
  );
  await db.query(
    `insert into public.link_dispatches (id, tenant_id, tracked_link_id, tracking_token, channel, recipient_player_id,
                                         recipient_hash, source_type, source_id, message_log_type, message_log_id,
                                         url_position, original_url, sent_url, send_status, idempotency_key)
     values ($2, $1, $3, $4, 'sms', $5, 'rh-1', 'journey', $6, 'sms', $7, 0,
             'https://sortealta.bet/promo?btag=AFF77SORTE&utm_source=sms', 'https://sortealta.link/AbC1', 'sent',
             'journey:' || $6 || ':0'),
            ($8, $1, $9, $10, 'sms', $11, 'rh-2', 'journey', $6, 'sms', $12, 0,
             'https://sortealta.bet/promo?utm_source=sms', 'https://sortealta.link/JoS2', 'sent',
             'journey:' || $6 || ':1')`,
    [SOURCE, DISPATCH, LINK, TOKEN, MARIA, JOURNEY, SMS_1, DISPATCH_J, LINK_J, TOKEN_J, JOSE, SMS_J1],
  );
  await db.query(
    `insert into public.click_events (tenant_id, link_dispatch_id, tracking_token, request_id, ip_hash)
     values ($1, $2, $3, 'req-1', 'ip-1'), ($1, $4, $5, 'req-2', 'ip-2')`,
    [SOURCE, DISPATCH, TOKEN, DISPATCH_J, TOKEN_J],
  );
  await db.query(
    `insert into public.link_click_snapshots (tenant_id, tracked_link_id, snapshot_at, clicks)
     values ($1, $2, now(), 3), ($1, $3, now(), 5)`,
    [SOURCE, LINK, LINK_J],
  );
  await db.query(
    `insert into public.conversion_attributions (tenant_id, source_type, source_id, link_dispatch_id, tracking_token,
                                                 player_id, event_type, event_id, occurred_at, monetary_value)
     values ($1, 'journey', $2, $3, $4, $5, 'deposit_approved', 'tx-1', now(), 100.50),
            ($1, 'journey', $2, $6, $7, $8, 'deposit_approved', 'tx-5', now(), 70)`,
    [SOURCE, JOURNEY, DISPATCH, TOKEN, MARIA, DISPATCH_J, TOKEN_J, JOSE],
  );
  await db.query(
    `insert into public.conversion_attribution_issues (tenant_id, event_type, event_id, reason)
     values ($1, 'deposit_approved', 'tx-2', 'no_confirmed_click'),
            ($1, 'deposit_approved', 'tx-6', 'no_confirmed_click')`,
    [SOURCE],
  );
  await db.query(
    `insert into public.call_queue (id, tenant_id, lead_id, phone_number, status)
     values ($2, $1, $3, '+5531988887777', 'completed'), (gen_random_uuid(), $1, $4, '+5521987654321', 'completed')`,
    [SOURCE, QUEUE_J, JOSE, MARIA],
  );
  await db.query(
    `insert into public.call_history (tenant_id, lead_id, call_queue_id, to_phone, rendered_text, status)
     values ($1, $2, $3, '+5531988887777', 'Oi Jose, aqui e da Sorte Alta', 'completed')`,
    [SOURCE, JOSE, QUEUE_J],
  );
  await db.query(
    `insert into public.email_send_logs (tenant_id, player_id, to_email, subject, status)
     values ($1, $2, 'maria.souza@gmail.com', 'Maria, novidades', 'sent'),
            ($1, $3, 'jose.lima@uol.com.br', 'Jose, novidades', 'sent')`,
    [SOURCE, MARIA, JOSE],
  );
  await db.query(
    `insert into public.sms_campaigns (id, tenant_id, name, content, scheduled_at, status, recipients, total_count,
                                       sent_count, sent_cursor)
     values ($2, $1, 'Outubro', 'Bônus Sorte Alta', now(), 'enviado',
             jsonb_build_array(jsonb_build_object('phone', '+5521987654321', 'playerId', $3::text),
                               jsonb_build_object('phone', '+5531988887777', 'playerId', $4::text)), 2, 2, 2)`,
    [SOURCE, CAMPAIGN, MARIA, JOSE],
  );
  // Source aggregates, as the crons would have left them.
  await db.query(`select public.refresh_crm_results_day($1, (now() at time zone 'America/Sao_Paulo')::date)`, [SOURCE]);
  await db.query(`select public.refresh_player_lifecycle_day($1, (now() at time zone 'America/Sao_Paulo')::date)`, [
    SOURCE,
  ]);
  await db.query(`select public.refresh_tenant_daily_metric_day($1, (now() at time zone 'America/Sao_Paulo')::date)`, [
    SOURCE,
  ]);
  await db.query(`select public.check_crm_results_day($1, (now() at time zone 'America/Sao_Paulo')::date)`, [SOURCE]);
}

async function sourcePlayerIds(): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(`select id from public.players where tenant_id = $1`, [SOURCE]);
  return rows.map((r) => r.id);
}

beforeAll(async () => {
  ({ db } = await createMigratedDb());
  await seed();
}, 180_000);

afterAll(async () => {
  await db?.close();
});

describe("clone-tenant-demo", () => {
  it("fixture: Maria, Pedro and Carla are in the sample, José is not", () => {
    expect([MARIA, PEDRO, CARLA].map(inDemoSample)).toEqual([true, true, true]);
    expect(inDemoSample(JOSE)).toBe(false);
  });

  it("dry-run builds and scans everything, then rolls back", async () => {
    const result = await run(false);
    expect(result.ok).toBe(true);
    expect(result.applied).toBe(false);
    expect(result.hits).toEqual([]);
    const sampled = (await sourcePlayerIds()).filter(inDemoSample).length;
    expect(result.counts.find((c: Count) => c.table === "players")).toMatchObject({
      source: BULK + 4,
      demo: sampled,
      expected: sampled,
      mode: "sample",
    });
    expect(await demoId()).toBeNull();
    expect(uploads).toHaveLength(0);
  }, 120_000);

  it("--apply clones the sample with consistent counts and sums, fake identities and no needle left", async () => {
    const result = await run(true);
    expect(result.ok).toBe(true);
    expect(result.applied).toBe(true);
    for (const c of result.counts as Count[]) {
      if (c.mode === "whole") expect(c.demo, c.table).toBe(c.source);
      if (c.mode === "sample") expect(c.demo, c.table).toBe(c.expected);
    }
    const demo = (await demoId())!;
    expect(demo).toBe(result.demoTenantId);
    expect(demo).toBe(remapId("tenants", SOURCE));

    const { rows: tenant } = await db.query<Record<string, unknown>>(`select * from public.tenants where id = $1`, [demo]);
    expect(tenant[0]).toMatchObject({ nome: "Casa Demo", slug: "demo", is_demo: true, status: "active", plano: "pro" });
    expect(tenant[0].webhook_hmac_enforced).toBe(true);

    // Deposits: exactly those of the sampled players, values untouched.
    const { rows: deps } = await db.query<{ player_id: string; valor: string }>(
      `select player_id, valor::text from public.deposits where tenant_id = $1`,
      [SOURCE],
    );
    const expectedSum = deps
      .filter((d) => inDemoSample(d.player_id))
      .reduce((acc, d) => acc + Number(d.valor), 0);
    const { rows: sums } = await db.query<{ dst: string }>(
      `select sum(valor)::text as dst from public.deposits where tenant_id = $1`,
      [demo],
    );
    expect(Number(sums[0].dst)).toBeCloseTo(expectedSum, 2);

    const { rows: players } = await db.query<Record<string, string | null>>(
      `select id, nome, telefone, email, cpf, player_external_id, affiliate_id from public.players where tenant_id = $1 order by id`,
      [demo],
    );
    const named = players.filter((p) => [MARIA, PEDRO, CARLA, JOSE].map((id) => remapId("players", id)).includes(p.id!));
    expect(named.map((p) => p.id).sort()).toEqual([MARIA, PEDRO, CARLA].map((id) => remapId("players", id)).sort());
    // (Bulk players' fake names may legitimately use any first name of the pool.)
    for (const p of named) expect(p.nome).not.toMatch(/\b(maria|souza|pedro|alves|carla)\b/i);
    for (const p of players) {
      expect(p.nome).not.toMatch(/^Jogador \d+$/);
      if (p.telefone) expect(p.telefone).toMatch(/^\+5511900\d{6}$/);
      if (p.email) expect(p.email).toMatch(/@example\.com$/);
    }
    expect(players.filter((p) => p.telefone)).toHaveLength(2);

    const maria = players.find((p) => p.id === remapId("players", MARIA))!;
    const pedro = players.find((p) => p.id === remapId("players", PEDRO))!;
    const { rows: sms } = await db.query<Record<string, string>>(
      `select id, to_phone, content, provider_message_id, trigger_name, provider_response::text as pr,
              last_callback::text as lc from public.sms_send_logs where tenant_id = $1 order by id`,
      [demo],
    );
    expect(sms.map((s) => s.id).sort()).toEqual([SMS_1, SMS_2].map((id) => remapId("sms_send_logs", id)).sort());
    const first = sms.find((s) => s.id === remapId("sms_send_logs", SMS_1))!;
    const second = sms.find((s) => s.id === remapId("sms_send_logs", SMS_2))!;
    // No player_id on this log: the player (and the sample) is found by phone.
    expect(second.to_phone).toBe(pedro.telefone);
    expect(second.content).toBe(`${pedro.nome!.split(" ")[0]}, seu bônus na CASA DEMO`);
    expect(first.to_phone).toBe(maria.telefone);
    expect(first.content).toBe(
      `Oi ${maria.nome!.split(" ")[0]}, acesse https://demo.betleads.invalid/AbC1 - Casa Demo`,
    );
    expect(first.trigger_name).toBe(`journey:${remapId("journeys", JOURNEY)}`);
    expect(first.pr).toBe("{}");
    expect(first.lc).toBe("{}");

    const { rows: links } = await db.query<Record<string, string>>(
      `select id, short_url, original_url, shortio_link_id from public.tracked_links where tenant_id = $1`,
      [demo],
    );
    expect(links.map((l) => l.id)).toEqual([remapId("tracked_links", LINK)]);
    expect(links[0].short_url).toBe("https://demo.betleads.invalid/AbC1");
    expect(links[0].original_url).toBe(
      `https://demo.betleads.invalid/api/public/click/${remapId("link_dispatches", TOKEN)}?s=demo`,
    );
    expect(links[0].shortio_link_id).not.toBe("lnk_RealShort01");

    const { rows: dispatches } = await db.query<Record<string, string>>(
      `select tracking_token, source_id, message_log_id, original_url, sent_url, idempotency_key
         from public.link_dispatches where tenant_id = $1`,
      [demo],
    );
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({
      tracking_token: remapId("link_dispatches", TOKEN),
      source_id: remapId("journeys", JOURNEY),
      message_log_id: remapId("sms_send_logs", SMS_1),
      original_url: "https://demo.betleads.invalid/promo?btag=demo&utm_source=sms",
      sent_url: "https://demo.betleads.invalid/AbC1",
    });

    const { rows: enrollments } = await db.query<Record<string, unknown>>(
      `select claimed_at, claimed_by, metadata from public.journey_enrollments where tenant_id = $1 and player_id = $2`,
      [demo, maria.id],
    );
    expect(enrollments[0]).toMatchObject({ claimed_at: null, claimed_by: null, metadata: { deposited_before_entry: 150 } });

    const { rows: steps } = await db.query<{ config: { variants: Array<{ content: string }>; test_phone: string } }>(
      `select config from public.journey_steps where tenant_id = $1`,
      [demo],
    );
    expect(steps[0].config.variants[0].content).toBe(
      "Oi {{nome}}, a Casa Demo te espera: https://demo.betleads.invalid/promo?btag=demo",
    );
    expect(steps[0].config.test_phone).toBe(maria.telefone);

    expect(uploads).toHaveLength(1);
    const scan = await scanTenant(db, demo, await collectNeedles(db, SOURCE), { sourceTenantId: SOURCE });
    expect(scan).toEqual([]);
  }, 120_000);

  it("R14: the player sample is ~half, matches the JS rule and leaves nothing of José behind", async () => {
    const demo = (await demoId())!;
    const ids = await sourcePlayerIds();
    const sampled = ids.filter(inDemoSample);
    const ratio = sampled.length / ids.length;
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(0.6);
    const { rows: demoPlayers } = await db.query<{ id: string }>(`select id from public.players where tenant_id = $1`, [
      demo,
    ]);
    expect(demoPlayers.map((r) => r.id).sort()).toEqual(sampled.map((id) => remapId("players", id)).sort());

    // No demo row, in any column (uuid, text or jsonb), carries a remapped id of José's rows.
    const joseDemoIds = JOSE_IDS.map((id) => remapId("x", id));
    for (const table of ALL_TABLES) {
      const { rows } = await db.query<{ n: number }>(
        `select count(*)::int as n from public.${table} t
          where t.tenant_id = $1 and exists (select 1 from unnest($2::text[]) j where strpos(to_jsonb(t)::text, j) > 0)`,
        [demo, joseDemoIds],
      );
      expect(rows[0].n, table).toBe(0);
    }

    // Chains followed: José's enrollment → execution → events, dispatch → link →
    // click/snapshot/attribution, queue → call, issue via his deposit's event id.
    const one = async (sql: string) => (await db.query<{ n: number }>(sql, [demo])).rows[0].n;
    expect(await one(`select count(*)::int n from public.journey_enrollments where tenant_id = $1`)).toBe(2);
    expect(await one(`select count(*)::int n from public.journey_step_executions where tenant_id = $1`)).toBe(1);
    expect(await one(`select count(*)::int n from public.journey_events where tenant_id = $1`)).toBe(2);
    expect(await one(`select count(*)::int n from public.click_events where tenant_id = $1`)).toBe(1);
    expect(await one(`select count(*)::int n from public.link_click_snapshots where tenant_id = $1`)).toBe(1);
    expect(await one(`select count(*)::int n from public.conversion_attributions where tenant_id = $1`)).toBe(1);
    expect(await one(`select count(*)::int n from public.conversion_attribution_issues where tenant_id = $1`)).toBe(1);
    expect(await one(`select count(*)::int n from public.call_queue where tenant_id = $1`)).toBe(1);
    expect(await one(`select count(*)::int n from public.call_history where tenant_id = $1`)).toBe(0);
    expect(await one(`select count(*)::int n from public.email_send_logs where tenant_id = $1`)).toBe(1);

    // Credits: José's two reservations are gone and given back to the balances.
    const { rows: ledger } = await db.query<{ entry_type: string; delta_credits: number; balance_after: number }>(
      `select entry_type, delta_credits, balance_after from public.sms_credit_ledger where tenant_id = $1
        order by created_at`,
      [demo],
    );
    expect(ledger).toEqual([
      { entry_type: "purchase", delta_credits: 100, balance_after: 100 },
      { entry_type: "sms_reservation", delta_credits: -1, balance_after: 99 },
      { entry_type: "manual_adjustment", delta_credits: 10, balance_after: 109 },
    ]);
    const { rows: balance } = await db.query<Record<string, number>>(
      `select balance_credits, lifetime_used_credits, lifetime_purchased_credits
         from public.tenant_sms_credit_balances where tenant_id = $1`,
      [demo],
    );
    expect(balance[0]).toEqual({ balance_credits: 109, lifetime_used_credits: 1, lifetime_purchased_credits: 100 });

    // Campaign config is kept, its recipient list and counters follow the sample.
    const { rows: campaigns } = await db.query<{ recipients: Array<{ playerId: string }>; total_count: number; sent_count: number }>(
      `select recipients, total_count, sent_count from public.sms_campaigns where tenant_id = $1`,
      [demo],
    );
    expect(campaigns[0].recipients.map((r) => r.playerId)).toEqual([remapId("players", MARIA)]);
    expect(campaigns[0]).toMatchObject({ total_count: 1, sent_count: 1 });

    // Aggregates are recomputed from the sampled rows.
    const { rows: metrics } = await db.query<{ src: string; dst: string; dep: string }>(
      `select (select sum(approved_deposit_amount) from public.tenant_daily_metrics where tenant_id = $2)::text as src,
              (select sum(approved_deposit_amount) from public.tenant_daily_metrics where tenant_id = $1)::text as dst,
              (select sum(valor) from public.deposits where tenant_id = $1 and status = 'aprovado')::text as dep`,
      [demo, SOURCE],
    );
    expect(Number(metrics[0].dst)).toBeCloseTo(Number(metrics[0].dep), 2);
    expect(Number(metrics[0].dst)).toBeLessThan(Number(metrics[0].src));
    const { rows: lifecycle } = await db.query<{ n: number }>(
      `select sum(players)::int as n from public.player_lifecycle_daily where tenant_id = $1`,
      [demo],
    );
    expect(lifecycle[0].n).toBe(sampled.length);
  }, 120_000);

  it("running again after editing the demo restores the identical state", async () => {
    const before = await snapshot();
    const demo = (await demoId())!;
    await db.query(`update public.players set nome = 'Editado pelo prospect' where tenant_id = $1`, [demo]);
    await db.query(`delete from public.deposits where tenant_id = $1`, [demo]);
    await db.query(
      `insert into public.sms_templates (tenant_id, name, content) values ($1, 'criado no demo', 'texto')`,
      [demo],
    );
    const result = await run(true);
    expect(result.ok).toBe(true);
    expect(await snapshot()).toEqual(before);
  }, 120_000);

  it("a real phone in an untreated column makes the scan fail and leaves the demo untouched", async () => {
    const before = await snapshot();
    await db.query(`update public.players set origem = 'indicado por 21 98765-4321' where id = $1`, [PEDRO]);
    const result = await run(true);
    expect(result.ok).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "players", column: "origem", id: remapId("players", PEDRO) }),
      ]),
    );
    expect(await snapshot()).toEqual(before);
    expect(uploads).toHaveLength(2);
    await db.query(`update public.players set origem = 'site' where id = $1`, [PEDRO]);
  }, 120_000);
});
