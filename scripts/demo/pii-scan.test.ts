// Task 12 — the PII scan finds real identities anywhere in a tenant's text and
// jsonb, including inside free text and nested jsonb (Review Focus 5).
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { collectNeedles, scanTenant } from "./pii-scan.mjs";

const SOURCE = "03b73a96-aef7-414d-94fc-93a996f8256b";
const DEMO = "11111111-2222-4333-8444-555555555555";
const SOURCE_PLAYER = "6f1d2c3b-0000-4000-8000-000000000001";
const DEMO_PLAYER = "7a2e3d4c-0000-4000-8000-000000000001";

// Column lists from supabase/migrations (players, sms_send_logs, events, tracked_links).
const SCHEMA = [
  `create table public.tenants (id uuid primary key, nome text not null, slug text not null,
     status text not null default 'active', metadata jsonb not null default '{}')`,
  `create table public.players (id uuid primary key, tenant_id uuid not null, nome text not null,
     telefone text, email text, cpf text, player_external_id text, affiliate_id text, expert text,
     origem text, tags text[] not null default '{}')`,
  `create table public.sms_send_logs (id uuid primary key, tenant_id uuid not null, to_phone text not null,
     content text not null, status text not null, provider text not null,
     provider_response jsonb not null default '{}', error text, idempotency_key text, player_id uuid,
     provider_message_id text, last_callback jsonb, trigger_name text)`,
  `create table public.events (id uuid primary key, tenant_id uuid not null, player_id uuid,
     tipo text not null, metadata jsonb not null default '{}', provider_event_id text)`,
  `create table public.tracked_links (id uuid primary key, tenant_id uuid not null, shortio_link_id text not null,
     short_url text not null, original_url text not null, status text not null default 'active')`,
];

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  for (const sql of SCHEMA) await db.query(sql);
  await db.query(
    `insert into public.tenants (id, nome, slug) values ($1, 'Sorte Alta', 'pixpgf'), ($2, 'Casa Betleads', 'demo')`,
    [SOURCE, DEMO],
  );
  await db.query(
    `insert into public.players (id, tenant_id, nome, telefone, email, cpf, player_external_id, affiliate_id)
     values ($1, $2, 'Maria Souza', '+5521987654321', 'Maria.Souza@gmail.com', '529.982.247-25', 'EXT884512', 'AFF77SORTE'),
            ($3, $4, 'Ana Lima', '+5511900123456', 'ana.lima1@example.com', '11144477735', 'DEMO12345678', null)`,
    [SOURCE_PLAYER, SOURCE, DEMO_PLAYER, DEMO],
  );
  await db.query(
    `insert into public.sms_send_logs (id, tenant_id, to_phone, content, status, provider, provider_message_id)
     values ('6f1d2c3b-0000-4000-8000-0000000000a1', $1, '+5521987654321', 'Oi Maria', 'sent', 'shortcode', 'msg-real-001')`,
    [SOURCE],
  );
  await db.query(
    `insert into public.tracked_links (id, tenant_id, shortio_link_id, short_url, original_url)
     values ('6f1d2c3b-0000-4000-8000-0000000000b1', $1, 'lnk_RealShort01', 'https://sortealta.link/Ab1', 'https://sortealta.bet/promo')`,
    [SOURCE],
  );
});

afterAll(async () => {
  await db?.close();
});

async function demoRow(table: string, values: Record<string, unknown>) {
  const cols = Object.keys(values);
  await db.query(
    `insert into public.${table} (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
    Object.values(values),
  );
}

async function clearDemo() {
  for (const table of ["sms_send_logs", "events", "tracked_links"])
    await db.query(`delete from public.${table} where tenant_id = $1`, [DEMO]);
}

describe("collectNeedles", () => {
  it("gathers phones, e-mails, CPFs, ids, hosts and brand of the source tenant", async () => {
    const needles = await collectNeedles(db, SOURCE);
    expect(needles.phones).toContain("+5521987654321");
    expect(needles.emails).toContain("maria.souza@gmail.com");
    expect(needles.cpfs).toContain("52998224725");
    expect(needles.externalIds).toEqual(expect.arrayContaining(["EXT884512", "AFF77SORTE"]));
    expect(needles.providerIds).toContain("msg-real-001");
    expect(needles.shortioLinkIds).toContain("lnk_RealShort01");
    expect(needles.shortLinks).toContainEqual({ host: "sortealta.link", path: "Ab1" });
    expect(needles.names).toContain("maria souza");
    expect(needles.uuids).toContain(SOURCE);
    expect(needles.domains).toEqual(expect.arrayContaining(["sortealta.link", "sortealta.bet"]));
    expect(needles.brands).toEqual(expect.arrayContaining(["sorte alta", "pixpgf"]));
  });
});

describe("scanTenant", () => {
  it("finds a real phone inside sms_send_logs.content and inside jsonb metadata", async () => {
    await clearDemo();
    const needles = await collectNeedles(db, SOURCE);
    await demoRow("sms_send_logs", {
      id: "7a2e3d4c-0000-4000-8000-0000000000a1",
      tenant_id: DEMO,
      to_phone: "+5511900123456",
      content: "Oi Ana, ligue (21) 98765-4321 hoje",
      status: "sent",
      provider: "shortcode",
    });
    await demoRow("events", {
      id: "7a2e3d4c-0000-4000-8000-0000000000e1",
      tenant_id: DEMO,
      tipo: "login",
      metadata: JSON.stringify({ deep: { contact: ["21987654321"] } }),
    });
    const hits = await scanTenant(db, DEMO, needles);
    expect(hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "sms_send_logs", column: "content", id: "7a2e3d4c-0000-4000-8000-0000000000a1" }),
        expect.objectContaining({ table: "events", column: "metadata", id: "7a2e3d4c-0000-4000-8000-0000000000e1" }),
      ]),
    );
  });

  it("finds e-mails, CPFs, external/provider/short.io ids, brand, domains and the source tenant uuid", async () => {
    await clearDemo();
    const needles = await collectNeedles(db, SOURCE);
    const cases: Array<[string, string]> = [
      ["e1", "write to MARIA.SOUZA@gmail.com"],
      ["e2", "cpf 529.982.247-25"],
      ["e3", "ext EXT884512 ok"],
      ["e4", "aff=AFF77SORTE"],
      ["e5", "id msg-real-001"],
      ["e6", "link lnk_RealShort01"],
      ["e7", "visit Sorte Alta now"],
      ["e8", "https://promo.sortealta.bet/x"],
      ["e9", `tenant ${SOURCE}`],
      // Fix round: a real short code left behind a rewritten host, and a full real name.
      ["ea", "https://demo.betleads.invalid/Ab1 (host swapped, path real)"],
      ["eb", "Falar com MARIA de Souza amanhã"],
    ];
    for (const [suffix, text] of cases)
      await demoRow("events", {
        id: `7a2e3d4c-0000-4000-8000-0000000000${suffix}`,
        tenant_id: DEMO,
        tipo: "x",
        metadata: JSON.stringify({ text }),
      });
    const hits = await scanTenant(db, DEMO, needles);
    const ids = new Set(hits.map((h: { id: string }) => h.id));
    for (const [suffix] of cases) expect(ids).toContain(`7a2e3d4c-0000-4000-8000-0000000000${suffix}`);
  });

  it("finds a source row uuid used by a demo row (column or text)", async () => {
    await clearDemo();
    const needles = await collectNeedles(db, SOURCE);
    await demoRow("events", {
      id: "7a2e3d4c-0000-4000-8000-0000000000f1",
      tenant_id: DEMO,
      player_id: SOURCE_PLAYER,
      tipo: "x",
    });
    await demoRow("events", {
      id: "7a2e3d4c-0000-4000-8000-0000000000f2",
      tenant_id: DEMO,
      tipo: "x",
      metadata: JSON.stringify({ ref: SOURCE_PLAYER }),
    });
    const hits = await scanTenant(db, DEMO, needles, { sourceTenantId: SOURCE });
    expect(hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "events", column: "player_id", id: "7a2e3d4c-0000-4000-8000-0000000000f1" }),
        expect.objectContaining({ table: "events", column: "metadata", id: "7a2e3d4c-0000-4000-8000-0000000000f2" }),
      ]),
    );
  });

  it("returns nothing for clean fake data", async () => {
    await clearDemo();
    const needles = await collectNeedles(db, SOURCE);
    await demoRow("sms_send_logs", {
      id: "7a2e3d4c-0000-4000-8000-0000000000a2",
      tenant_id: DEMO,
      to_phone: "+5511900123456",
      content: "Oi Ana Lima, acesse https://demo.betleads.invalid/dm1a2b3c4d — Casa Betleads, 2026-10-16 12:00, R$ 50,00",
      status: "sent",
      provider: "shortcode",
      provider_message_id: "demo0123456789abcdef012345",
    });
    expect(await scanTenant(db, DEMO, needles, { sourceTenantId: SOURCE })).toEqual([]);
  });
});
