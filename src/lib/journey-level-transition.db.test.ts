// CON-06 — regression test for public.transition_journey_level_on_deposit().
//
// Runs the real migration SQL inside an in-memory Postgres (PGlite, WASM):
//   1. supabase/tests/journey-level/schema.sql — minimal tables/FKs the trigger touches;
//   2. 20261008231000_add_journey_level_transitions.sql — journey_level_for_total(),
//      the original (buggy) trigger function and the trigger on players;
//   3. 20261014200000_fix_journey_level_transition_event_order.sql — the fix.
// The original function inserted (enrollment.id, enrollment.journey_id) into
// (journey_id, enrollment_id), aborting the deposit with
// journey_events_journey_id_fkey. A negative control re-installs it inside a
// rolled-back transaction to prove this test detects that bug.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const sql = (path: string) => readFileSync(resolve(root, path), "utf8");

const SCHEMA = sql("supabase/tests/journey-level/schema.sql");
const ORIGINAL = sql("supabase/migrations/20261008231000_add_journey_level_transitions.sql");
const FIX = sql("supabase/migrations/20261014200000_fix_journey_level_transition_event_order.sql");

const TENANT = "00000000-0000-4000-8000-000000000001";
const PLAYER = "00000000-0000-4000-8000-000000000101";
const BRONZE_JOURNEY = "00000000-0000-4000-8000-0000000000b1";
const SILVER_JOURNEY = "00000000-0000-4000-8000-0000000000c1";
const OTHER_JOURNEY = "00000000-0000-4000-8000-0000000000d1";
const BRONZE_ENROLLMENT = "00000000-0000-4000-8000-0000000000e1";
const OTHER_ENROLLMENT = "00000000-0000-4000-8000-0000000000e2";
const DEPOSIT = "00000000-0000-4000-8000-0000000000f1";

type EventRow = {
  journey_id: string;
  enrollment_id: string | null;
  event_type: string;
  detail: Record<string, unknown>;
};
type EnrollmentRow = {
  id: string;
  journey_id: string;
  journey_version: number;
  status: string;
  exit_reason: string | null;
  entry_key: string;
  metadata: Record<string, unknown>;
};

let db: PGlite;

async function events() {
  const { rows } = await db.query<EventRow>(
    "select journey_id, enrollment_id, event_type, detail from public.journey_events order by event_type",
  );
  return rows;
}

async function enrollments() {
  const { rows } = await db.query<EnrollmentRow>(
    `select id, journey_id, journey_version, status::text as status, exit_reason, entry_key, metadata
       from public.journey_enrollments order by created_at, id`,
  );
  return rows;
}

async function setTotal(total: number) {
  await db.query("update public.players set total_depositado = $1 where id = $2", [total, PLAYER]);
}

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(SCHEMA);
  await db.exec(ORIGINAL);
  await db.exec(FIX);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec(`
    truncate public.tenants cascade;
    insert into public.tenants (id) values ('${TENANT}');
    insert into public.players (id, tenant_id, total_depositado) values ('${PLAYER}', '${TENANT}', 50);
    insert into public.deposits (id, tenant_id, player_id, status, completed_at)
      values ('${DEPOSIT}', '${TENANT}', '${PLAYER}', 'aprovado', now());
    insert into public.journeys
      (id, tenant_id, name, status, trigger_type, trigger_config, version, conflict_family, journey_priority)
    values
      ('${BRONZE_JOURNEY}', '${TENANT}', 'Bronze', 'active', 'nivel_alterado', '{"level":"bronze"}', 1, 'progressao_niveis', 4),
      ('${SILVER_JOURNEY}', '${TENANT}', 'Prata', 'active', 'nivel_alterado', '{"level":"silver"}', 3, 'progressao_niveis', 4),
      ('${OTHER_JOURNEY}', '${TENANT}', 'Boas-vindas', 'active', 'manual', '{}', 1, null, 4);
    insert into public.journey_enrollments (id, tenant_id, journey_id, journey_version, player_id, entry_key, status)
    values
      ('${BRONZE_ENROLLMENT}', '${TENANT}', '${BRONZE_JOURNEY}', 1, '${PLAYER}', 'level:bronze', 'active'),
      ('${OTHER_ENROLLMENT}', '${TENANT}', '${OTHER_JOURNEY}', 1, '${PLAYER}', 'default', 'waiting');
  `);
});

describe("transition_journey_level_on_deposit (PGlite)", () => {
  it("moves the player to the new level journey with correct journey/enrollment ids", async () => {
    await setTotal(250); // bronze (>=10) -> silver (>=200)

    const rows = await enrollments();
    const bronze = rows.find((row) => row.id === BRONZE_ENROLLMENT);
    const other = rows.find((row) => row.id === OTHER_ENROLLMENT);
    const silver = rows.find((row) => row.journey_id === SILVER_JOURNEY);

    expect(bronze).toMatchObject({ status: "exited", exit_reason: "level_changed" });
    expect(other).toMatchObject({ status: "waiting", exit_reason: null });
    expect(silver).toMatchObject({
      journey_version: 3,
      status: "active",
      entry_key: "level:silver",
      metadata: expect.objectContaining({
        trigger: "nivel_alterado",
        from_level: "bronze",
        to_level: "silver",
        deposit_id: DEPOSIT,
      }),
    });

    expect(await events()).toEqual([
      {
        journey_id: BRONZE_JOURNEY,
        enrollment_id: BRONZE_ENROLLMENT,
        event_type: "level_changed",
        detail: expect.objectContaining({ from_level: "bronze", to_level: "silver" }),
      },
      {
        journey_id: SILVER_JOURNEY,
        enrollment_id: silver!.id,
        event_type: "level_entered",
        detail: expect.objectContaining({ from_level: "bronze", to_level: "silver" }),
      },
    ]);
  });

  it("does nothing when the deposit does not change the level", async () => {
    await setTotal(150); // still bronze

    expect(await events()).toEqual([]);
    const rows = await enrollments();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === BRONZE_ENROLLMENT)).toMatchObject({
      status: "active",
      exit_reason: null,
    });
  });

  it("still exits the old level when no journey exists for the new level", async () => {
    await setTotal(600); // bronze -> gold, no gold journey configured

    expect(await events()).toEqual([
      expect.objectContaining({
        journey_id: BRONZE_JOURNEY,
        enrollment_id: BRONZE_ENROLLMENT,
        event_type: "level_changed",
      }),
    ]);
    expect((await enrollments()).map((row) => row.journey_id)).not.toContain(SILVER_JOURNEY);
  });

  it("negative control: the original function aborts the deposit with an FK error", async () => {
    // Re-install only the original function body inside a transaction that is
    // rolled back, so the fixed function stays in place for other tests.
    const original = ORIGINAL.slice(
      ORIGINAL.indexOf("CREATE OR REPLACE FUNCTION public.transition_journey_level_on_deposit()"),
      ORIGINAL.indexOf("DROP TRIGGER IF EXISTS trg_players_journey_level_transition"),
    );
    expect(original).toContain("SELECT NEW.tenant_id, id, journey_id, 'level_changed'");

    await db.exec("begin");
    try {
      await db.exec(original);
      await expect(setTotal(250)).rejects.toThrow(/journey_events_journey_id_fkey/);
    } finally {
      await db.exec("rollback");
    }

    await setTotal(250);
    expect(await events()).toHaveLength(2);
  });
});
