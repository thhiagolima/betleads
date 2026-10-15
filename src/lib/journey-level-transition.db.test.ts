// CON-06 / WHK-01 — regression test for the journey level transition.
//
// Runs the real migration SQL inside an in-memory Postgres (PGlite, WASM):
//   1. supabase/tests/journey-level/schema.sql — minimal tables/FKs touched;
//   2. 20261008231000_add_journey_level_transitions.sql — journey_level_for_total(),
//      the original (buggy) trigger function and the trigger on players;
//   3. 20261014200000_fix_journey_level_transition_event_order.sql — the CON-06 fix;
//   4. 20261015130000_level_transition_outbox.sql — WHK-01: the trigger only
//      enqueues into journey_level_outbox; process_journey_level_outbox()
//      applies the same transition outside the deposit transaction.
// The original function inserted (enrollment.id, enrollment.journey_id) into
// (journey_id, enrollment_id), aborting the deposit with
// journey_events_journey_id_fkey. A negative control re-installs it inside a
// rolled-back transaction to prove this test detects that bug, and that the
// outbox design no longer couples journey failures to the deposit.
//
// PGlite has a single connection, so true two-session concurrency (SKIP LOCKED)
// is not exercised here; it was verified against a real Postgres 17 with two
// connections (embedded Postgres 17: claims never overlap, every row applied once).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const sql = (path: string) => readFileSync(resolve(root, path), "utf8");

const SCHEMA = sql("supabase/tests/journey-level/schema.sql");
const ORIGINAL = sql("supabase/migrations/20261008231000_add_journey_level_transitions.sql");
const FIX = sql("supabase/migrations/20261014200000_fix_journey_level_transition_event_order.sql");
const OUTBOX = sql("supabase/migrations/20261015130000_level_transition_outbox.sql");

const TENANT = "00000000-0000-4000-8000-000000000001";
const PLAYER = "00000000-0000-4000-8000-000000000101";
const PLAYER_2 = "00000000-0000-4000-8000-000000000102";
const BRONZE_JOURNEY = "00000000-0000-4000-8000-0000000000b1";
const SILVER_JOURNEY = "00000000-0000-4000-8000-0000000000c1";
const GOLD_JOURNEY = "00000000-0000-4000-8000-0000000000c2";
const OTHER_JOURNEY = "00000000-0000-4000-8000-0000000000d1";
const BRONZE_ENROLLMENT = "00000000-0000-4000-8000-0000000000e1";
const OTHER_ENROLLMENT = "00000000-0000-4000-8000-0000000000e2";
const BRONZE_ENROLLMENT_2 = "00000000-0000-4000-8000-0000000000e3";
const DEPOSIT = "00000000-0000-4000-8000-0000000000f1";
const DEPOSIT_2 = "00000000-0000-4000-8000-0000000000f2";

type EventRow = {
  journey_id: string;
  enrollment_id: string | null;
  event_type: string;
  detail: Record<string, unknown>;
};
type EnrollmentRow = {
  id: string;
  journey_id: string;
  player_id: string;
  journey_version: number;
  status: string;
  exit_reason: string | null;
  entry_key: string;
  metadata: Record<string, unknown>;
};
type OutboxRow = {
  id: number;
  tenant_id: string;
  player_id: string;
  previous_total: string;
  current_total: string;
  previous_level: string;
  current_level: string;
  deposit_id: string | null;
  processed_at: Date | null;
  attempts: number;
  last_error: string | null;
  dead_at: Date | null;
  result: string | null;
};
type ProcessResult = {
  claimed: number;
  applied: number;
  failed: number;
  dead: number;
  purged: number;
};

let db: PGlite;

async function events(player = PLAYER) {
  const { rows } = await db.query<EventRow>(
    `select e.journey_id, e.enrollment_id, e.event_type, e.detail
       from public.journey_events e
       join public.journey_enrollments en on en.id = e.enrollment_id
      where en.player_id = $1
      order by e.created_at, e.event_type`,
    [player],
  );
  return rows;
}

async function allEventCount() {
  const { rows } = await db.query<{ n: number }>("select count(*)::int as n from public.journey_events");
  return rows[0].n;
}

async function enrollments(player = PLAYER) {
  const { rows } = await db.query<EnrollmentRow>(
    `select id, journey_id, player_id, journey_version, status::text as status, exit_reason, entry_key, metadata
       from public.journey_enrollments where player_id = $1 order by created_at, id`,
    [player],
  );
  return rows;
}

async function outbox() {
  const { rows } = await db.query<OutboxRow>(
    "select * from public.journey_level_outbox order by id",
  );
  return rows;
}

async function setTotal(total: number, player = PLAYER) {
  await db.query("update public.players set total_depositado = $1 where id = $2", [total, player]);
}

async function processOutbox(limit = 500) {
  const { rows } = await db.query<{ r: ProcessResult }>(
    "select public.process_journey_level_outbox($1) as r",
    [limit],
  );
  return rows[0].r;
}

async function makeReady() {
  await db.exec("update public.journey_level_outbox set next_attempt_at = now() - interval '1 second'");
}

// Simulated FK failure inside the journey side (level_entered insert).
async function installFailure() {
  await db.exec(`
    create or replace function public.test_fail_level_entered() returns trigger
    language plpgsql as $$
    begin
      if new.event_type = 'level_entered' and new.journey_id = '${SILVER_JOURNEY}' then
        raise exception 'insert or update on table "journey_events" violates foreign key constraint "journey_events_journey_id_fkey"'
          using errcode = '23503';
      end if;
      return new;
    end $$;
    create trigger test_fail_level_entered before insert on public.journey_events
      for each row execute function public.test_fail_level_entered();
  `);
}

async function removeFailure() {
  await db.exec("drop trigger if exists test_fail_level_entered on public.journey_events");
}

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(SCHEMA);
  await db.exec(ORIGINAL);
  await db.exec(FIX);
  await db.exec(OUTBOX);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await removeFailure();
  await db.exec(`
    truncate public.tenants cascade;
    truncate public.journey_level_outbox, public.dispatcher_runs;
    insert into public.tenants (id) values ('${TENANT}');
    insert into public.players (id, tenant_id, total_depositado) values
      ('${PLAYER}', '${TENANT}', 50),
      ('${PLAYER_2}', '${TENANT}', 50);
    insert into public.deposits (id, tenant_id, player_id, status, completed_at) values
      ('${DEPOSIT}', '${TENANT}', '${PLAYER}', 'aprovado', now()),
      ('${DEPOSIT_2}', '${TENANT}', '${PLAYER_2}', 'aprovado', now());
    insert into public.journeys
      (id, tenant_id, name, status, trigger_type, trigger_config, version, conflict_family, journey_priority)
    values
      ('${BRONZE_JOURNEY}', '${TENANT}', 'Bronze', 'active', 'nivel_alterado', '{"level":"bronze"}', 1, 'progressao_niveis', 4),
      ('${SILVER_JOURNEY}', '${TENANT}', 'Prata', 'active', 'nivel_alterado', '{"level":"silver"}', 3, 'progressao_niveis', 4),
      ('${OTHER_JOURNEY}', '${TENANT}', 'Boas-vindas', 'active', 'manual', '{}', 1, null, 4);
    insert into public.journey_enrollments (id, tenant_id, journey_id, journey_version, player_id, entry_key, status)
    values
      ('${BRONZE_ENROLLMENT}', '${TENANT}', '${BRONZE_JOURNEY}', 1, '${PLAYER}', 'level:bronze', 'active'),
      ('${OTHER_ENROLLMENT}', '${TENANT}', '${OTHER_JOURNEY}', 1, '${PLAYER}', 'default', 'waiting'),
      ('${BRONZE_ENROLLMENT_2}', '${TENANT}', '${BRONZE_JOURNEY}', 1, '${PLAYER_2}', 'level:bronze', 'active');
  `);
});

function expectSilverTransition(rows: EnrollmentRow[], evts: EventRow[]) {
  const bronze = rows.find((row) => row.id === BRONZE_ENROLLMENT);
  const other = rows.find((row) => row.id === OTHER_ENROLLMENT);
  const silver = rows.find((row) => row.journey_id === SILVER_JOURNEY);

  expect(bronze).toMatchObject({ status: "exited", exit_reason: "level_changed" });
  expect(other).toMatchObject({ status: "waiting", exit_reason: null });
  expect(silver).toMatchObject({
    journey_version: 3,
    status: "active",
    entry_key: "level:silver",
    metadata: {
      trigger: "nivel_alterado",
      from_level: "bronze",
      to_level: "silver",
      previous_total_deposited: 50,
      current_total_deposited: 250,
      deposit_id: DEPOSIT,
    },
  });

  expect(evts).toEqual([
    {
      journey_id: BRONZE_JOURNEY,
      enrollment_id: BRONZE_ENROLLMENT,
      event_type: "level_changed",
      detail: {
        from_level: "bronze",
        to_level: "silver",
        previous_total_deposited: 50,
        current_total_deposited: 250,
      },
    },
    {
      journey_id: SILVER_JOURNEY,
      enrollment_id: silver!.id,
      event_type: "level_entered",
      detail: {
        from_level: "bronze",
        to_level: "silver",
        previous_total_deposited: 50,
        current_total_deposited: 250,
        deposit_id: DEPOSIT,
      },
    },
  ]);
}

describe("journey level transition via outbox (PGlite)", () => {
  it("deposit only enqueues; processing moves the player to the new level journey", async () => {
    await setTotal(250); // bronze (>=10) -> silver (>=200)

    // Nothing journey-related happens inside the deposit transaction.
    expect(await allEventCount()).toBe(0);
    expect((await enrollments()).find((row) => row.id === BRONZE_ENROLLMENT)).toMatchObject({
      status: "active",
    });
    expect(await outbox()).toEqual([
      expect.objectContaining({
        tenant_id: TENANT,
        player_id: PLAYER,
        previous_level: "bronze",
        current_level: "silver",
        deposit_id: DEPOSIT,
        processed_at: null,
        attempts: 0,
      }),
    ]);
    expect(Number((await outbox())[0].previous_total)).toBe(50);
    expect(Number((await outbox())[0].current_total)).toBe(250);

    expect(await processOutbox()).toMatchObject({ claimed: 1, applied: 1, failed: 0 });

    expectSilverTransition(await enrollments(), await events());
    expect(await outbox()).toEqual([
      expect.objectContaining({ result: "entered", attempts: 1, last_error: null }),
    ]);
    expect((await outbox())[0].processed_at).not.toBeNull();

    const { rows: runs } = await db.query<{ job: string; status: string; claimed: number; sent: number }>(
      "select job, status, claimed, sent from public.dispatcher_runs",
    );
    expect(runs).toEqual([{ job: "journey_level_outbox", status: "succeeded", claimed: 1, sent: 1 }]);
  });

  it("does nothing when the deposit does not change the level", async () => {
    await setTotal(150); // still bronze

    expect(await outbox()).toEqual([]);
    expect(await processOutbox()).toMatchObject({ claimed: 0 });
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
    await processOutbox();

    expect(await events()).toEqual([
      expect.objectContaining({
        journey_id: BRONZE_JOURNEY,
        enrollment_id: BRONZE_ENROLLMENT,
        event_type: "level_changed",
      }),
    ]);
    expect((await enrollments()).map((row) => row.journey_id)).not.toContain(SILVER_JOURNEY);
    expect((await outbox())[0]).toMatchObject({ result: "no_target" });
  });

  it("negative control: the original in-transaction function aborts the deposit; the outbox does not", async () => {
    // Re-install only the original function body inside a transaction that is
    // rolled back, so the outbox function stays in place for other tests.
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
    await processOutbox();
    expect(await events()).toHaveLength(2);
  });

  it("a failure while applying does not roll back the deposit, does not block other players and is retried", async () => {
    await installFailure();

    // A deposit transaction: approve a deposit and bump the total, then commit.
    await db.exec(`
      begin;
      insert into public.deposits (tenant_id, player_id, status, completed_at)
        values ('${TENANT}', '${PLAYER}', 'aprovado', now() + interval '1 second');
      update public.players set total_depositado = 250 where id = '${PLAYER}';
      update public.players set total_depositado = 600 where id = '${PLAYER_2}';
      commit;
    `);
    const { rows: committed } = await db.query<{ total: string; deposits: number }>(
      `select p.total_depositado as total,
              (select count(*)::int from public.deposits d where d.player_id = p.id) as deposits
         from public.players p where p.id = $1`,
      [PLAYER],
    );
    expect(Number(committed[0].total)).toBe(250);
    expect(committed[0].deposits).toBe(2);

    expect(await processOutbox()).toMatchObject({ claimed: 2, applied: 1, failed: 1 });

    // Failing row: recorded, nothing partially applied (subtransaction rolled back
    // the exit of the bronze enrollment too).
    const failing = (await outbox()).find((row) => row.player_id === PLAYER)!;
    expect(failing).toMatchObject({ processed_at: null, attempts: 1, dead_at: null });
    expect(failing.last_error).toMatch(/^23503: .*journey_events_journey_id_fkey/);
    expect(await events()).toEqual([]);
    expect((await enrollments()).find((row) => row.id === BRONZE_ENROLLMENT)).toMatchObject({
      status: "active",
    });

    // The other player in the same batch was applied.
    expect((await outbox()).find((row) => row.player_id === PLAYER_2)).toMatchObject({
      result: "no_target",
    });
    expect((await enrollments(PLAYER_2))[0]).toMatchObject({ status: "exited", exit_reason: "level_changed" });

    const { rows: runs } = await db.query<{ status: string; errors: number }>(
      "select status, errors from public.dispatcher_runs",
    );
    expect(runs).toEqual([{ status: "partial", errors: 1 }]);

    // Backoff: not retried immediately.
    expect(await processOutbox()).toMatchObject({ claimed: 0 });

    const { rows: health } = await db.query<Record<string, unknown>>(
      "select * from public.observability_journey_level_outbox()",
    );
    expect(health[0]).toMatchObject({ pending: 1, ready: 0, retrying: 1, dead: 0 });
    expect(String(health[0].last_error)).toMatch(/23503/);

    // Cause removed and backoff elapsed: retried and applied with the original data.
    await removeFailure();
    await makeReady();
    expect(await processOutbox()).toMatchObject({ claimed: 1, applied: 1, failed: 0 });
    const [silverEnrollment] = (await enrollments()).filter((row) => row.journey_id === SILVER_JOURNEY);
    expect(silverEnrollment.metadata).toMatchObject({ from_level: "bronze", to_level: "silver" });
    expect((await outbox()).find((row) => row.player_id === PLAYER)).toMatchObject({
      attempts: 2,
      result: "entered",
    });
    expect(await events()).toHaveLength(2);
  });

  it("is idempotent: reprocessing never re-applies a processed row", async () => {
    await setTotal(250);
    await processOutbox();
    const before = { enrollments: await enrollments(), events: await events() };

    expect(await processOutbox()).toMatchObject({ claimed: 0, applied: 0 });
    expect(await processOutbox()).toMatchObject({ claimed: 0, applied: 0 });

    expect(await enrollments()).toEqual(before.enrollments);
    expect(await events()).toEqual(before.events);
    expectSilverTransition(await enrollments(), await events());
  });

  it("applies consecutive level changes of one player strictly in order", async () => {
    await db.exec(`
      insert into public.journeys
        (id, tenant_id, name, status, trigger_type, trigger_config, version, conflict_family, journey_priority)
      values ('${GOLD_JOURNEY}', '${TENANT}', 'Ouro', 'active', 'nivel_alterado', '{"level":"gold"}', 2, 'progressao_niveis', 4);
    `);
    await setTotal(250); // bronze -> silver
    await setTotal(700); // silver -> gold, before the worker ran

    const queued = await outbox();
    expect(queued.map((row) => [row.previous_level, row.current_level])).toEqual([
      ["bronze", "silver"],
      ["silver", "gold"],
    ]);

    expect(await processOutbox()).toMatchObject({ claimed: 2, applied: 2 });

    const rows = await enrollments();
    expect(rows.find((row) => row.journey_id === SILVER_JOURNEY)).toMatchObject({
      status: "exited",
      exit_reason: "level_changed",
    });
    expect(rows.find((row) => row.journey_id === GOLD_JOURNEY)).toMatchObject({
      status: "active",
      entry_key: "level:gold",
      journey_version: 2,
    });
  });

  it("a failing earlier row blocks only the later rows of the same player", async () => {
    await installFailure();
    await setTotal(250); // bronze -> silver (fails)
    await setTotal(700); // silver -> gold (must wait)
    await setTotal(250, PLAYER_2); // bronze -> silver for another player (fails too)

    await processOutbox();
    const rows = await outbox();
    expect(rows.map((row) => [row.player_id, row.attempts, row.processed_at === null])).toEqual([
      [PLAYER, 1, true],
      [PLAYER, 0, true],
      [PLAYER_2, 1, true],
    ]);
  });

  it("dead-letters a row after 10 attempts, after which later rows of the player proceed", async () => {
    await installFailure();
    await setTotal(250); // fails forever
    await setTotal(700); // gold: no journey, exit only

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await makeReady();
      await processOutbox();
    }

    const [dead, later] = await outbox();
    expect(dead).toMatchObject({ attempts: 10, processed_at: null });
    expect(dead.dead_at).not.toBeNull();
    expect(later).toMatchObject({ result: "no_target" });

    const { rows: health } = await db.query<Record<string, unknown>>(
      "select pending, dead, dead_last_24h from public.observability_journey_level_outbox()",
    );
    expect(health[0]).toEqual({ pending: 0, dead: 1, dead_last_24h: 1 });
  });

  it("skips rows of players deleted before processing", async () => {
    await setTotal(250);
    await db.exec(`delete from public.players where id = '${PLAYER}'`);

    expect(await processOutbox()).toMatchObject({ applied: 1, failed: 0 });
    expect((await outbox())[0]).toMatchObject({ result: "player_not_found" });
  });

  it("respects the limit and leaves the rest for the next run", async () => {
    await setTotal(250);
    await setTotal(250, PLAYER_2);

    expect(await processOutbox(1)).toMatchObject({ claimed: 1 });
    expect((await outbox()).filter((row) => row.processed_at === null)).toHaveLength(1);
    expect(await processOutbox(1)).toMatchObject({ claimed: 1 });
    expect((await outbox()).filter((row) => row.processed_at === null)).toHaveLength(0);
  });

  it("grants the worker and outbox only to service_role", async () => {
    const { rows } = await db.query<{ role: string; fn: boolean; tbl: boolean }>(
      `select r as role,
              has_function_privilege(r, 'public.process_journey_level_outbox(integer)', 'execute') as fn,
              has_table_privilege(r, 'public.journey_level_outbox', 'select') as tbl
         from unnest(array['anon', 'authenticated', 'service_role']) r`,
    );
    expect(rows).toEqual([
      { role: "anon", fn: false, tbl: false },
      { role: "authenticated", fn: false, tbl: false },
      { role: "service_role", fn: true, tbl: true },
    ]);
  });
});
