// Fix round (Tasks 12+13, item 3): the clone never writes outside the demo
// tenant. PGlite with every migration; a source tenant and an unrelated third
// tenant are snapshotted before, cloned + reset, and must be byte-identical
// after; the refusals throw and leave everything untouched.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { remapId } from "./anonymize.mjs";
import { cloneTenantDemo } from "./clone-core.mjs";
import { createMigratedDb } from "./test-support/migrated-pglite.mjs";

const SOURCE = "03b73a96-aef7-414d-94fc-93a996f8256b";
const OTHER = "5e5e5e5e-0000-4000-8000-000000000001";
const THIRD = "5e5e5e5e-0000-4000-8000-000000000002";
const P1 = "6f1d2c3b-0000-4000-8000-000000000001"; // in the sample
const P2 = "6f1d2c3b-0000-4000-8000-000000000003"; // in the sample
const OP = "6f1d2c3b-0000-4000-8000-000000000099";

let db: PGlite;
const storage = { async replace() {} };

const run = (options: Record<string, unknown>) =>
  cloneTenantDemo(db, {
    apply: true,
    storage,
    storageBaseUrl: "https://project.storage.test",
    ...options,
  });

/** Every row of every public table that belongs to `tenantId` (and its tenants row). */
async function tenantSnapshot(tenantId: string) {
  const { rows: tables } = await db.query<{ t: string }>(
    `select c.table_name as t from information_schema.columns c
       join information_schema.tables x using (table_schema, table_name)
      where c.table_schema = 'public' and x.table_type = 'BASE TABLE' and c.column_name = 'tenant_id'
      order by 1`,
  );
  const out: Record<string, string[]> = {};
  for (const { t } of tables) {
    const { rows } = await db.query<{ j: string }>(
      `select to_jsonb(r)::text as j from public.${t} r where tenant_id = $1 order by 1`,
      [tenantId],
    );
    if (rows.length) out[t] = rows.map((r) => r.j);
  }
  const { rows } = await db.query<{ j: string }>(
    `select to_jsonb(t)::text as j from public.tenants t where id = $1`,
    [tenantId],
  );
  out.tenants = rows.map((r) => r.j);
  return out;
}

async function seedTenant(
  id: string,
  slug: string,
  nome: string,
  players: Array<[string, string, string]>,
) {
  await db.query(
    `insert into public.tenants (id, nome, slug, status, plano) values ($1, $2, $3, 'active', 'pro')`,
    [id, nome, slug],
  );
  for (const [playerId, playerName, phone] of players) {
    await db.query(
      `insert into public.players (id, tenant_id, nome, telefone, email, origem)
       values ($1, $2, $3, $4, lower(replace($3, ' ', '.')) || '@gmail.com', 'site')`,
      [playerId, id, playerName, phone],
    );
    await db.query(
      `insert into public.deposits (tenant_id, player_id, valor, status, external_id)
       values ($1, $2::uuid, 50, 'aprovado', 'tx-' || $2::text)`,
      [id, playerId],
    );
    await db.query(
      `insert into public.sms_send_logs (tenant_id, to_phone, content, status, provider, player_id, provider_message_id)
       values ($1, $2, 'Oi ' || $3::text || ', https://sortealta.link/Q' || right($4::text, 3), 'sent', 'shortcode',
               $4::uuid, 'msg-' || $4::text)`,
      [id, phone, playerName, playerId],
    );
  }
}

beforeAll(async () => {
  ({ db } = await createMigratedDb());
  await db.query(
    `update public.tenants set slug = slug || '-seed' where slug in ('pixpgf', 'outra')`,
  );
  await seedTenant(SOURCE, "pixpgf", "Sorte Alta", [
    [P1, "Maria Souza", "+5521987654321"],
    [P2, "Pedro Alves", "+5511912345678"],
  ]);
  await seedTenant(OTHER, "outra", "Outra Casa", [[OP, "Rita Prado", "+5541999998888"]]);
}, 180_000);

afterAll(async () => {
  await db?.close();
});

describe("clone-tenant-demo safety", () => {
  it("clone + reset leave the source and an unrelated tenant byte-identical", async () => {
    const sourceBefore = await tenantSnapshot(SOURCE);
    const otherBefore = await tenantSnapshot(OTHER);
    expect(Object.keys(sourceBefore)).toEqual(
      expect.arrayContaining(["players", "deposits", "sms_send_logs"]),
    );

    const first = await run({ sourceSlug: "pixpgf", targetSlug: "demo" });
    expect(first.ok).toBe(true);
    const second = await run({ sourceSlug: "pixpgf", targetSlug: "demo" });
    expect(second.ok).toBe(true);
    expect(second.demoTenantId).toBe(first.demoTenantId);

    expect(await tenantSnapshot(SOURCE)).toEqual(sourceBefore);
    expect(await tenantSnapshot(OTHER)).toEqual(otherBefore);
  }, 120_000);

  it("values derived from real values change with the run secret; ids do not (fix item 2)", async () => {
    const read = async () =>
      (
        await db.query<{ id: string; external_id: string; pmid: string }>(
          `select d.id, d.external_id, (select provider_message_id from public.sms_send_logs s
                                         where s.tenant_id = d.tenant_id and s.player_id = d.player_id) as pmid
             from public.deposits d where d.tenant_id = $1 order by d.player_id`,
          [remapId("tenants", SOURCE)],
        )
      ).rows;
    await run({ sourceSlug: "pixpgf", targetSlug: "demo", secret: "secret-a" });
    const a = await read();
    await run({ sourceSlug: "pixpgf", targetSlug: "demo", secret: "secret-b" });
    const b = await read();
    expect(b.map((r) => r.id)).toEqual(a.map((r) => r.id));
    for (let i = 0; i < a.length; i += 1) {
      expect(b[i].external_id).not.toBe(a[i].external_id);
      expect(b[i].pmid).not.toBe(a[i].pmid);
    }
  }, 120_000);

  it("refuses a non-demo target, source == target, a demo source and a non-demo row on the demo id", async () => {
    // A third source whose deterministic demo id is already taken by a normal tenant.
    await seedTenant(THIRD, "terceira", "Terceira", []);
    await db.query(
      `insert into public.tenants (id, nome, slug, status, plano) values ($1, 'Real', 'real-x', 'active', 'pro')`,
      [remapId("tenants", THIRD)],
    );
    const snapshots = async () => ({
      source: await tenantSnapshot(SOURCE),
      other: await tenantSnapshot(OTHER),
      demo: await tenantSnapshot(remapId("tenants", SOURCE)),
      real: await tenantSnapshot(remapId("tenants", THIRD)),
    });
    const before = await snapshots();

    await expect(run({ sourceSlug: "pixpgf", targetSlug: "outra" })).rejects.toThrow(
      /not a demo tenant/,
    );
    await expect(run({ sourceSlug: "pixpgf", targetSlug: "pixpgf" })).rejects.toThrow(
      /same tenant/,
    );
    await expect(run({ sourceSlug: "demo", targetSlug: "demo-2" })).rejects.toThrow(
      /is a demo tenant/,
    );
    await expect(run({ sourceSlug: "terceira", targetSlug: "demo-3" })).rejects.toThrow(
      /not a demo tenant/,
    );
    // Dry-run refuses the same way.
    await expect(run({ sourceSlug: "pixpgf", targetSlug: "outra", apply: false })).rejects.toThrow(
      /not a demo tenant/,
    );

    expect(await snapshots()).toEqual(before);
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from public.tenants where slug in ('demo-2', 'demo-3')`,
    );
    expect(rows[0].n).toBe(0);
  }, 120_000);
});
