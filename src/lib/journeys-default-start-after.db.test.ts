// P0.4 — SQL test for
// supabase/migrations/20261115100100_journeys_default_start_after.sql: an event
// journey that becomes active without start_after only takes new events, from
// any path (app, API, revision or a script writing the table directly).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { INCLUDE_BASE_START_AFTER } from "./journey-policy";

const MIGRATION = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20261115100100_journeys_default_start_after.sql"),
  "utf8",
);

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create table public.journeys (
      id text primary key,
      status text not null default 'draft',
      trigger_type text not null,
      trigger_config jsonb not null default '{}'::jsonb
    );
  `);
  await db.exec(MIGRATION);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec("truncate public.journeys");
});

async function startAfter(id: string): Promise<string | null> {
  const { rows } = await db.query<{ v: string | null }>(
    "select trigger_config->>'start_after' v from public.journeys where id = $1",
    [id],
  );
  return rows[0].v;
}

async function activate(id: string, config?: Record<string, unknown>) {
  if (config === undefined) {
    await db.query("update public.journeys set status = 'active' where id = $1", [id]);
  } else {
    await db.query(
      "update public.journeys set status = 'active', trigger_config = $2 where id = $1",
      [id, JSON.stringify(config)],
    );
  }
}

describe("journeys_default_start_after", () => {
  it("stamps the activation time on an event journey activated without start_after", async () => {
    await db.exec(
      `insert into public.journeys (id, trigger_type) values ('cad', 'cadastrados_sem_deposito')`,
    );
    const before = Date.now();
    await activate("cad");
    const stamped = Date.parse(String(await startAfter("cad")));
    expect(stamped).toBeGreaterThanOrEqual(before - 5_000);
    expect(stamped).toBeLessThanOrEqual(Date.now() + 5_000);
  });

  it("also covers an event journey inserted already active (a script copying journeys)", async () => {
    await db.exec(
      `insert into public.journeys (id, status, trigger_type, trigger_config) values ('cb', 'active', 'cashback_pago', '{"x": 1}')`,
    );
    expect(await startAfter("cb")).not.toBeNull();
    const { rows } = await db.query<{ x: string }>(
      "select trigger_config->>'x' x from public.journeys where id = 'cb'",
    );
    expect(rows[0].x).toBe("1");
  });

  it("keeps an explicit start_after, including the include-base one", async () => {
    await db.exec(`
      insert into public.journeys (id, trigger_type) values ('pix', 'pix_gerado_nao_pago'), ('base', 'cadastrados_sem_deposito');
    `);
    await activate("pix", { start_after: "2026-10-26T16:31:34.842Z" });
    await activate("base", { start_after: INCLUDE_BASE_START_AFTER });
    expect(await startAfter("pix")).toBe("2026-10-26T16:31:34.842Z");
    expect(await startAfter("base")).toBe(INCLUDE_BASE_START_AFTER);
  });

  it("never touches state triggers, drafts, or a journey that was already active", async () => {
    await db.exec(`
      insert into public.journeys (id, trigger_type) values ('ina', 'inactivity'), ('lvl', 'nivel_alterado');
      insert into public.journeys (id, trigger_type) values ('draft', 'saque_pago');
    `);
    await activate("ina");
    await activate("lvl");
    expect(await startAfter("ina")).toBeNull();
    expect(await startAfter("lvl")).toBeNull();
    await db.exec(`update public.journeys set status = 'paused' where id = 'draft'`);
    expect(await startAfter("draft")).toBeNull();

    // Already active without start_after (before this migration): left alone.
    await db.exec("alter table public.journeys disable trigger journeys_default_start_after");
    await db.exec(
      `insert into public.journeys (id, status, trigger_type) values ('old', 'active', 'cadastrados_sem_deposito')`,
    );
    await db.exec("alter table public.journeys enable trigger journeys_default_start_after");
    await db.exec(`update public.journeys set status = 'active' where id = 'old'`);
    expect(await startAfter("old")).toBeNull();
  });
});
