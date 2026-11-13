// PGlite test for
// supabase/migrations/20261228100000_webpush_campaign_dispatch_source.sql —
// link_dispatches rows pointing at a webpush campaign must pass
// validate_conversion_dispatch_source, and only inside the campaign's tenant.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migratedPglitePath = "../../../scripts/demo/test-support/migrated-pglite.mjs";
const { createMigratedDb } = (await import(/* @vite-ignore */ migratedPglitePath)) as {
  createMigratedDb: () => Promise<{ db: PGlite }>;
};

const TENANT = "7a2e3c4b-0000-4000-8000-000000000101";
const OTHER_TENANT = "7a2e3c4b-0000-4000-8000-000000000102";
const CAMPAIGN = "7a2e3c4b-0000-4000-8000-0000000001d1";

let db: PGlite;
const links: Record<string, string> = {};

beforeAll(async () => {
  ({ db } = await createMigratedDb());

  await db.query(
    `insert into public.tenants (id, nome, slug, status, plano, is_demo)
     values ($1, 'Casa Push Fonte', 'webpush-fonte-teste', 'active', 'starter', false),
            ($2, 'Outra Casa', 'webpush-fonte-outra', 'active', 'starter', false)`,
    [TENANT, OTHER_TENANT],
  );
  await db.query(
    `insert into public.webpush_campaigns
       (id, tenant_id, name, title, body, url, audience_kind, status, scheduled_at)
     values ($1, $2, 'Campanha', 'Titulo', 'Corpo', 'https://casa.example', 'todos', 'enviando', now())`,
    [CAMPAIGN, TENANT],
  );
  const { rows } = await db.query<{ id: string; tenant_id: string }>(
    `insert into public.tracked_links
       (tenant_id, shortio_link_id, short_url, original_url, canonical_url_hash)
     values ($1, 'sl-fonte-1', 'https://short.example/f1', 'https://casa.example', 'hash-fonte-1'),
            ($2, 'sl-fonte-2', 'https://short.example/f2', 'https://casa.example', 'hash-fonte-2')
     returning id, tenant_id`,
    [TENANT, OTHER_TENANT],
  );
  for (const row of rows) links[row.tenant_id] = row.id;
}, 180_000);

afterAll(async () => {
  await db?.close();
});

async function insertDispatch(tenantId: string, key: string) {
  await db.query(
    `insert into public.link_dispatches
       (tenant_id, idempotency_key, tracked_link_id, tracking_token, channel, recipient_hash,
        source_type, source_id, url_position, original_url, sent_url, send_status)
     values ($1, $2, $4, gen_random_uuid(), 'webpush', 'hash-1',
             'campaign', $3, 0, 'https://casa.example', 'https://app.example/c', 'prepared')`,
    [tenantId, key, CAMPAIGN, links[tenantId]],
  );
}

describe("validate_conversion_dispatch_source for webpush campaigns", () => {
  it("accepts a dispatch whose source is a webpush campaign of the same tenant", async () => {
    await insertDispatch(TENANT, `webpush:${CAMPAIGN}:sub-1:0`);
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from public.link_dispatches where source_id = $1`,
      [CAMPAIGN],
    );
    expect(rows[0].n).toBe(1);
  });

  it("still rejects the same campaign id under another tenant", async () => {
    await expect(insertDispatch(OTHER_TENANT, `webpush:${CAMPAIGN}:sub-2:0`)).rejects.toThrow(
      /campaign source does not exist in tenant/,
    );
  });
});
