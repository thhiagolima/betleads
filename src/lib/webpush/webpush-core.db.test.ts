// Web push (OneSignal) — Task 1: PGlite test for
// supabase/migrations/20261202100000_webpush_core.sql: core tables, the
// claim/batch RPCs, the link_dispatches channel check and the rate limit
// seed. Uses the full migrated database (every migration in
// supabase/migrations applied) so the real FKs/checks/triggers are exercised.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Dynamic import with a variable path (not a static specifier): avoids tsc
// trying to resolve a declaration file for this plain .mjs helper, matching
// src/lib/observability/scrub.test.ts's instrument.mjs import.
const migratedPglitePath = "../../../scripts/demo/test-support/migrated-pglite.mjs";
const { createMigratedDb } = (await import(/* @vite-ignore */ migratedPglitePath)) as {
  createMigratedDb: () => Promise<{ db: PGlite }>;
};

const TENANT = "7a1d2c3b-0000-4000-8000-000000000001";
const DEMO_TENANT = "7a1d2c3b-0000-4000-8000-000000000002";

const APP_ATIVO = "7a1d2c3b-0000-4000-8000-0000000000a1";
const APP_LEGADO = "7a1d2c3b-0000-4000-8000-0000000000a2";
const APP_DESATIVADO = "7a1d2c3b-0000-4000-8000-0000000000a3";

const P1 = "7a1d2c3b-0000-4000-8000-0000000000b1";
const P2 = "7a1d2c3b-0000-4000-8000-0000000000b2";

const SUB_INATIVA = "7a1d2c3b-0000-4000-8000-0000000000c1"; // app ativo, inativa, player P1
const SUB_APP_DESATIVADO = "7a1d2c3b-0000-4000-8000-0000000000c2"; // app desativado, ativa, player P2
const SUB_ATIVA_LEGADO = "7a1d2c3b-0000-4000-8000-0000000000c3"; // app legado, ativa, player P1

const CAMPAIGN_TODOS = "7a1d2c3b-0000-4000-8000-0000000000d1";
const CAMPAIGN_FILTRO = "7a1d2c3b-0000-4000-8000-0000000000d2";

let db: PGlite;

beforeAll(async () => {
  ({ db } = await createMigratedDb());

  await db.query(
    `insert into public.tenants (id, nome, slug, status, plano, is_demo)
     values ($1, 'Casa Teste Webpush', 'webpush-teste', 'active', 'starter', false),
            ($2, 'Casa Demo Webpush', 'webpush-demo', 'active', 'starter', true)`,
    [TENANT, DEMO_TENANT],
  );

  await db.query(
    `insert into public.players (id, tenant_id, nome)
     values ($1, $3, 'Jogador Um'), ($2, $3, 'Jogador Dois')`,
    [P1, P2, TENANT],
  );

  await db.query(
    `insert into public.tenant_webpush_apps
       (id, tenant_id, origin, onesignal_app_id, api_key_encrypted, created_via, status)
     values
       ($1, $4, 'https://ativo.example', 'os-app-ativo', 'enc-1', 'manual', 'ativo'),
       ($2, $4, 'https://legado.example', 'os-app-legado', 'enc-2', 'manual', 'legado'),
       ($3, $4, 'https://desativado.example', 'os-app-desativado', 'enc-3', 'manual', 'desativado')`,
    [APP_ATIVO, APP_LEGADO, APP_DESATIVADO, TENANT],
  );

  await db.query(
    `insert into public.push_subscriptions
       (id, tenant_id, app_id, subscription_id, player_id, status)
     values
       ($1, $5, $6, 'sub-inativa', $8, 'inativa'),
       ($2, $5, $7, 'sub-app-desativado', $9, 'ativa'),
       ($3, $5, $4, 'sub-ativa-legado', $8, 'ativa')`,
    [SUB_INATIVA, SUB_APP_DESATIVADO, SUB_ATIVA_LEGADO, APP_LEGADO, TENANT, APP_ATIVO, APP_DESATIVADO, P1, P2],
  );

  await db.query(
    `insert into public.webpush_campaigns
       (id, tenant_id, name, title, body, url, audience_kind, status, scheduled_at)
     values
       ($1, $3, 'Todos', 'Titulo', 'Corpo', 'https://casa.example', 'todos', 'agendada', now()),
       ($2, $3, 'Filtro P1', 'Titulo', 'Corpo', 'https://casa.example', 'filtro', 'agendada', now())`,
    [CAMPAIGN_TODOS, CAMPAIGN_FILTRO, TENANT],
  );
  await db.query(`update public.webpush_campaigns set target_player_ids = $2 where id = $1`, [
    CAMPAIGN_FILTRO,
    [P1],
  ]);
}, 180_000);

afterAll(async () => {
  await db?.close();
});

async function batch(campaign: string, after: string | null, limit = 10) {
  const { rows } = await db.query<{
    subscription_row_id: string;
    subscription_id: string;
    player_id: string | null;
    app_id: string;
    onesignal_app_id: string;
    click_key: string;
  }>("select * from public.webpush_campaign_batch($1, $2, $3)", [campaign, after, limit]);
  return rows;
}

describe("webpush_campaign_batch", () => {
  it("returns only the active subscription from the legado app (skips inativa and app desativado)", async () => {
    const rows = await batch(CAMPAIGN_TODOS, null);
    expect(rows).toHaveLength(1);
    expect(rows[0].subscription_row_id).toBe(SUB_ATIVA_LEGADO);
    expect(rows[0].onesignal_app_id).toBe("os-app-legado");
    expect(rows[0].click_key).toBeTruthy();
  });

  it("audience_kind=filtro restricts to target_player_ids", async () => {
    // Extra subscription that would qualify for a 'todos' campaign but must
    // be excluded here: active, app ativo, but belongs to P2 (not targeted).
    await db.query(
      `insert into public.push_subscriptions (id, tenant_id, app_id, subscription_id, player_id, status)
       values ('7a1d2c3b-0000-4000-8000-0000000000c4', $1, $2, 'sub-p2-ativa', $3, 'ativa')`,
      [TENANT, APP_ATIVO, P2],
    );

    const rows = await batch(CAMPAIGN_FILTRO, null);
    expect(rows).toHaveLength(1);
    expect(rows[0].subscription_row_id).toBe(SUB_ATIVA_LEGADO);
    expect(rows[0].player_id).toBe(P1);
  });

  it("skips subscriptions already logged for the campaign; p_after skips ids <= cursor", async () => {
    await db.query(
      `insert into public.webpush_send_logs (tenant_id, campaign_id, subscription_row_id, player_id, app_id, status)
       values ($1, $2, $3, $4, $5, 'enviado')`,
      [TENANT, CAMPAIGN_TODOS, SUB_ATIVA_LEGADO, P1, APP_LEGADO],
    );

    const rows = await batch(CAMPAIGN_TODOS, null);
    expect(rows.map((r) => r.subscription_row_id)).not.toContain(SUB_ATIVA_LEGADO);

    // p_after pagination: the sole eligible row for CAMPAIGN_FILTRO is
    // SUB_ATIVA_LEGADO; passing it as the cursor must yield nothing further.
    const paged = await batch(CAMPAIGN_FILTRO, SUB_ATIVA_LEGADO);
    expect(paged).toHaveLength(0);
  });
});

describe("claim_due_webpush_campaigns", () => {
  const OVERDUE = "7a1d2c3b-0000-4000-8000-0000000000e1";
  const FUTURE = "7a1d2c3b-0000-4000-8000-0000000000e2";
  const DEMO_OVERDUE = "7a1d2c3b-0000-4000-8000-0000000000e3";
  const STUCK_ENVIANDO = "7a1d2c3b-0000-4000-8000-0000000000e4";

  beforeAll(async () => {
    await db.query(
      `insert into public.webpush_campaigns
         (id, tenant_id, name, title, body, url, audience_kind, status, scheduled_at)
       values
         ($1, $5, 'Vencida', 't', 'b', 'https://casa.example', 'todos', 'agendada', now() - interval '1 minute'),
         ($2, $5, 'Futura', 't', 'b', 'https://casa.example', 'todos', 'agendada', now() + interval '1 hour'),
         ($3, $6, 'Demo vencida', 't', 'b', 'https://casa.example', 'todos', 'agendada', now() - interval '1 minute'),
         ($4, $5, 'Presa', 't', 'b', 'https://casa.example', 'todos', 'enviando', now() - interval '1 minute')`,
      [OVERDUE, FUTURE, DEMO_OVERDUE, STUCK_ENVIANDO, TENANT, DEMO_TENANT],
    );
    await db.query(
      `update public.webpush_campaigns set locked_at = now() - interval '6 minutes' where id = $1`,
      [STUCK_ENVIANDO],
    );
  });

  it("claims the overdue agendada campaign and resumes the stuck enviando one; skips future and demo", async () => {
    const { rows } = await db.query<{ id: string; status: string }>(
      "select * from public.claim_due_webpush_campaigns($1)",
      [5],
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(OVERDUE);
    expect(ids).toContain(STUCK_ENVIANDO);
    expect(ids).not.toContain(FUTURE);
    expect(ids).not.toContain(DEMO_OVERDUE);
    expect(rows.every((r) => r.status === "enviando")).toBe(true);
  });
});

describe("link_dispatches.channel accepts webpush", () => {
  const LINK = "7a1d2c3b-0000-4000-8000-0000000000f1";

  beforeAll(async () => {
    await db.query(
      `insert into public.tracked_links
         (id, tenant_id, shortio_link_id, short_url, original_url, canonical_url_hash)
       values ($1, $2, 'sl-webpush-1', 'https://short.example/wp1', 'https://casa.example/promo', 'hash-wp-1')`,
      [LINK, TENANT],
    );
  });

  it("accepts channel='webpush'", async () => {
    await expect(
      db.query(
        `insert into public.link_dispatches
           (tenant_id, tracked_link_id, channel, source_type, original_url, sent_url, idempotency_key)
         values ($1, $2, 'webpush', 'webpush_campaign', 'https://casa.example/promo', 'https://short.example/wp1', 'idem-webpush-1')`,
        [TENANT, LINK],
      ),
    ).resolves.toBeDefined();
  });

  it("rejects channel='push'", async () => {
    await expect(
      db.query(
        `insert into public.link_dispatches
           (tenant_id, tracked_link_id, channel, source_type, original_url, sent_url, idempotency_key)
         values ($1, $2, 'push', 'webpush_campaign', 'https://casa.example/promo', 'https://short.example/wp1', 'idem-push-1')`,
        [TENANT, LINK],
      ),
    ).rejects.toThrow();
  });
});

describe("channel_rate_limits seed", () => {
  it("has a global and a tenant_default row for onesignal/webpush", async () => {
    const { rows } = await db.query<{
      scope: string;
      per_second: string;
      burst: string;
    }>(
      `select scope, per_second, burst from public.channel_rate_limits
        where provider = 'onesignal' and channel = 'webpush' order by scope`,
    );
    expect(rows).toHaveLength(2);
    const global = rows.find((r) => r.scope === "global")!;
    const tenantDefault = rows.find((r) => r.scope === "tenant_default")!;
    expect(Number(global.per_second)).toBe(10);
    expect(Number(global.burst)).toBe(10);
    expect(Number(tenantDefault.per_second)).toBe(5);
    expect(Number(tenantDefault.burst)).toBe(5);
  });
});

describe("push_subscriptions cascades on player deletion", () => {
  it("deleting the player deletes their subscriptions", async () => {
    const before = await db.query("select 1 from public.push_subscriptions where player_id = $1", [P2]);
    expect(before.rows.length).toBeGreaterThan(0);

    await db.query("delete from public.players where id = $1", [P2]);

    const after = await db.query("select 1 from public.push_subscriptions where player_id = $1", [P2]);
    expect(after.rows).toHaveLength(0);
  });
});
