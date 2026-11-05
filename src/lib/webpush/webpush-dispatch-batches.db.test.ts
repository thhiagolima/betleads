// Web push (OneSignal) — Task 11 fix round 1: PGlite test for
// supabase/migrations/20261210100300_webpush_dispatch_batches.sql — the
// table's constraints and cascades. Uses the full migrated database (every
// migration applied) so the real FKs/checks are exercised.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migratedPglitePath = "../../../scripts/demo/test-support/migrated-pglite.mjs";
const { createMigratedDb } = (await import(/* @vite-ignore */ migratedPglitePath)) as {
  createMigratedDb: () => Promise<{ db: PGlite }>;
};

const TENANT = "7a2e3c4b-0000-4000-8000-000000000001";
const APP = "7a2e3c4b-0000-4000-8000-0000000000a1";
const CAMPAIGN = "7a2e3c4b-0000-4000-8000-0000000000d1";
const SUB_1 = "7a2e3c4b-0000-4000-8000-0000000000c1";
const SUB_2 = "7a2e3c4b-0000-4000-8000-0000000000c2";

let db: PGlite;

beforeAll(async () => {
  ({ db } = await createMigratedDb());

  await db.query(
    `insert into public.tenants (id, nome, slug, status, plano, is_demo)
     values ($1, 'Casa Teste Dispatch Batches', 'webpush-batches-teste', 'active', 'starter', false)`,
    [TENANT],
  );
  await db.query(
    `insert into public.tenant_webpush_apps
       (id, tenant_id, origin, onesignal_app_id, api_key_encrypted, created_via, status)
     values ($1, $2, 'https://batches.example', 'os-app-batches', 'enc-1', 'manual', 'ativo')`,
    [APP, TENANT],
  );
  await db.query(
    `insert into public.push_subscriptions (id, tenant_id, app_id, subscription_id, status)
     values ($1, $3, $4, 'sub-1', 'ativa'),
            ($2, $3, $4, 'sub-2', 'ativa')`,
    [SUB_1, SUB_2, TENANT, APP],
  );
  await db.query(
    `insert into public.webpush_campaigns
       (id, tenant_id, name, title, body, url, audience_kind, status, scheduled_at)
     values ($1, $2, 'Campanha', 'Titulo', 'Corpo', 'https://casa.example', 'todos', 'enviando', now())`,
    [CAMPAIGN, TENANT],
  );
}, 180_000);

afterAll(async () => {
  await db?.close();
});

describe("webpush_dispatch_batches", () => {
  it("inserts a pendente batch with defaults and nullable settlement columns", async () => {
    const { rows } = await db.query<{
      id: string;
      status: string;
      accepted: number | null;
      refused_row_ids: string[] | null;
    }>(
      `insert into public.webpush_dispatch_batches
         (tenant_id, campaign_id, app_id, subscription_row_ids, units)
       values ($1, $2, $3, $4, 2)
       returning id, status, accepted, refused_row_ids`,
      [TENANT, CAMPAIGN, APP, [SUB_1, SUB_2]],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pendente");
    expect(rows[0].accepted).toBeNull();
    expect(rows[0].refused_row_ids).toBeNull();
  });

  it("rejects an invalid status", async () => {
    await expect(
      db.query(
        `insert into public.webpush_dispatch_batches
           (tenant_id, campaign_id, app_id, subscription_row_ids, units, status)
         values ($1, $2, $3, $4, 1, 'inventado')`,
        [TENANT, CAMPAIGN, APP, [SUB_1]],
      ),
    ).rejects.toThrow();
  });

  it("accepts every documented status transition value", async () => {
    for (const status of ["pendente", "enviado", "liquidado", "concluido", "falhou"]) {
      await expect(
        db.query(
          `insert into public.webpush_dispatch_batches
             (tenant_id, campaign_id, app_id, subscription_row_ids, units, status)
           values ($1, $2, $3, $4, 1, $5)`,
          [TENANT, CAMPAIGN, APP, [SUB_1], status],
        ),
      ).resolves.toBeDefined();
    }
  });

  it("cascades on campaign deletion", async () => {
    const campaignId = "7a2e3c4b-0000-4000-8000-0000000000d2";
    await db.query(
      `insert into public.webpush_campaigns
         (id, tenant_id, name, title, body, url, audience_kind, status, scheduled_at)
       values ($1, $2, 'Descartável', 't', 'b', 'https://casa.example', 'todos', 'enviando', now())`,
      [campaignId, TENANT],
    );
    await db.query(
      `insert into public.webpush_dispatch_batches
         (tenant_id, campaign_id, app_id, subscription_row_ids, units)
       values ($1, $2, $3, $4, 1)`,
      [TENANT, campaignId, APP, [SUB_1]],
    );
    const before = await db.query(
      "select 1 from public.webpush_dispatch_batches where campaign_id = $1",
      [campaignId],
    );
    expect(before.rows.length).toBeGreaterThan(0);

    await db.query("delete from public.webpush_campaigns where id = $1", [campaignId]);

    const after = await db.query(
      "select 1 from public.webpush_dispatch_batches where campaign_id = $1",
      [campaignId],
    );
    expect(after.rows).toHaveLength(0);
  });

  it("cascades on tenant deletion", async () => {
    const tenantId = "7a2e3c4b-0000-4000-8000-000000000099";
    const campaignId = "7a2e3c4b-0000-4000-8000-0000000000d3";
    const appId = "7a2e3c4b-0000-4000-8000-0000000000a9";
    const subId = "7a2e3c4b-0000-4000-8000-0000000000c9";
    await db.query(
      `insert into public.tenants (id, nome, slug, status, plano, is_demo)
       values ($1, 'Casa Descartável', 'webpush-batches-descartavel', 'active', 'starter', false)`,
      [tenantId],
    );
    await db.query(
      `insert into public.tenant_webpush_apps
         (id, tenant_id, origin, onesignal_app_id, api_key_encrypted, created_via, status)
       values ($1, $2, 'https://descartavel.example', 'os-app-descartavel', 'enc-1', 'manual', 'ativo')`,
      [appId, tenantId],
    );
    await db.query(
      `insert into public.push_subscriptions (id, tenant_id, app_id, subscription_id, status)
       values ($1, $2, $3, 'sub-descartavel', 'ativa')`,
      [subId, tenantId, appId],
    );
    await db.query(
      `insert into public.webpush_campaigns
         (id, tenant_id, name, title, body, url, audience_kind, status, scheduled_at)
       values ($1, $2, 'Descartável', 't', 'b', 'https://casa.example', 'todos', 'enviando', now())`,
      [campaignId, tenantId],
    );
    await db.query(
      `insert into public.webpush_dispatch_batches
         (tenant_id, campaign_id, app_id, subscription_row_ids, units)
       values ($1, $2, $3, $4, 1)`,
      [tenantId, campaignId, appId, [subId]],
    );

    await db.query("delete from public.tenants where id = $1", [tenantId]);

    const after = await db.query(
      "select 1 from public.webpush_dispatch_batches where tenant_id = $1",
      [tenantId],
    );
    expect(after.rows).toHaveLength(0);
  });

  it("the (campaign_id, status) index exists", async () => {
    const { rows } = await db.query<{ indexname: string }>(
      `select indexname from pg_indexes
        where tablename = 'webpush_dispatch_batches' and indexname = 'webpush_dispatch_batches_campaign_status_idx'`,
    );
    expect(rows).toHaveLength(1);
  });
});
