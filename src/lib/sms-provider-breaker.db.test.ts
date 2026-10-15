// SMS provider circuit breaker — real SQL of
// supabase/migrations/20261015123000_sms_provider_breaker.sql in PGlite, driven
// through the TS wrapper (src/lib/sms-provider-breaker.server.ts) with a thin
// supabase-js shim. PGlite has one connection, so "concurrent" calls are
// interleaved, not parallel; the row lock + conditions are what make the
// transitions single-winner, and that is what these tests pin down.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => ({ db: null as unknown as import("@electric-sql/pglite").PGlite }));
const obs = vi.hoisted(() => ({ pingHeartbeat: vi.fn(async () => undefined), captureServerMessage: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    async rpc(name: string, args: Record<string, unknown>) {
      const keys = Object.keys(args);
      const call = `select * from public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")})`;
      try {
        const r = await pg.db.query(call, keys.map((k) => args[k]));
        return { data: r.rows, error: null };
      } catch (error) {
        return { data: null, error: { message: (error as Error).message } };
      }
    },
    from(table: string) {
      return {
        select: (columns: string) => ({
          eq: (column: string, value: string) => ({
            async maybeSingle() {
              try {
                const r = await pg.db.query(
                  `select ${columns} from public.${table} where ${column} = $1`,
                  [value],
                );
                return { data: r.rows[0] ?? null, error: null };
              } catch (error) {
                return { data: null, error: { message: (error as Error).message } };
              }
            },
          }),
        }),
      };
    },
  },
}));
vi.mock("@/lib/observability/job-monitor.server", () => ({ pingHeartbeat: obs.pingHeartbeat }));
vi.mock("@/lib/observability/sentry.server", () => ({
  captureServerMessage: obs.captureServerMessage,
}));

import {
  SMS_PROVIDER_JOB,
  __resetSmsBreakerCacheForTests,
  acquireSmsSendGate,
  noteSmsProviderSuccess,
  readSmsBreaker,
  releaseSmsProbe,
  reportSmsProviderAccountFailure,
  smsSuspendedMessage,
} from "./sms-provider-breaker.server";

const MIGRATION = readFileSync(
  resolve(__dirname, "../../supabase/migrations/20261015123000_sms_provider_breaker.sql"),
  "utf8",
);

type Row = {
  state: string;
  open_count: number;
  backoff_until: Date | null;
  opened_at: Date | null;
  first_opened_at: Date | null;
  probe_holder: string | null;
  last_alert_at: Date | null;
};

async function row(): Promise<Row> {
  return (await pg.db.query<Row>("select * from public.provider_circuit_breakers where channel = 'sms'"))
    .rows[0];
}
/** Moves the breaker's clocks into the past instead of waiting. */
async function age(seconds: number) {
  await pg.db.query(
    `update public.provider_circuit_breakers set
       backoff_until = backoff_until - make_interval(secs => $1),
       opened_at = opened_at - make_interval(secs => $1),
       first_opened_at = first_opened_at - make_interval(secs => $1),
       probe_started_at = probe_started_at - make_interval(secs => $1),
       last_alert_at = last_alert_at - make_interval(secs => $1)
     where channel = 'sms'`,
    [seconds],
  );
}
const backoffMinutes = (r: Row) =>
  Math.round((new Date(r.backoff_until!).getTime() - new Date(r.opened_at!).getTime()) / 60_000);
const fail = (startedAt = new Date()) =>
  reportSmsProviderAccountFailure({
    reason: "auth",
    error: "Short Brasil: erro de autenticacao",
    sendStartedAt: startedAt,
  });

beforeAll(async () => {
  pg.db = new PGlite();
  await pg.db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
  `);
  await pg.db.exec(MIGRATION);
});

afterAll(async () => {
  await pg.db.close();
});

beforeEach(async () => {
  await pg.db.query(
    `update public.provider_circuit_breakers set state = 'closed', open_count = 0, backoff_until = null,
       opened_at = null, first_opened_at = null, probe_holder = null, probe_started_at = null,
       last_alert_at = null, reason = null, last_error = null where channel = 'sms'`,
  );
  __resetSmsBreakerCacheForTests();
  obs.pingHeartbeat.mockClear();
  obs.captureServerMessage.mockClear();
});

describe("sms provider breaker (SQL + wrapper)", () => {
  it("starts closed: senders go ahead, heartbeat ok", async () => {
    expect(await acquireSmsSendGate("w1")).toEqual({ mode: "closed" });
    expect(obs.pingHeartbeat).toHaveBeenCalledWith(SMS_PROVIDER_JOB, true);
  });

  it("first account failure opens for 2 min and alerts once (Sentry error + heartbeat fail)", async () => {
    const snap = await fail();
    expect(snap.state).toBe("open");
    const r = await row();
    expect(r).toMatchObject({ state: "open", open_count: 1 });
    expect(backoffMinutes(r)).toBe(2);
    expect(obs.captureServerMessage).toHaveBeenCalledTimes(1);
    expect(obs.captureServerMessage.mock.calls[0][1]).toBe("error");
    expect(obs.pingHeartbeat).toHaveBeenCalledWith(SMS_PROVIDER_JOB, false);

    // While open (inside the backoff) senders are refused and nothing doubles.
    const gate = await acquireSmsSendGate("w1");
    expect(gate.mode).toBe("open");
    await fail();
    expect(await row()).toMatchObject({ state: "open", open_count: 1 });
    expect(obs.captureServerMessage).toHaveBeenCalledTimes(1);
  });

  it("concurrent failures from many workers open the breaker exactly once", async () => {
    const started = new Date();
    await Promise.all(Array.from({ length: 20 }, () => fail(started)));
    const r = await row();
    expect(r).toMatchObject({ state: "open", open_count: 1 });
    expect(backoffMinutes(r)).toBe(2);
    expect(obs.captureServerMessage).toHaveBeenCalledTimes(1);
  });

  it("half-open: exactly one holder gets the probe; others stay blocked", async () => {
    await fail();
    await age(150); // backoff (2 min) elapsed
    const gates = await Promise.all(["w1", "w2", "w3", "w4"].map((h) => acquireSmsSendGate(h)));
    expect(gates.filter((g) => g.mode === "probe")).toHaveLength(1);
    expect(gates.filter((g) => g.mode === "open")).toHaveLength(3);
    const holder = (await row()).probe_holder;
    expect(holder).toBe("w1");
    // The holder asking again keeps its probe (re-entrant).
    expect((await acquireSmsSendGate("w1")).mode).toBe("probe");
  });

  it("probe failure reopens with a doubled backoff, capped at 30 min", async () => {
    await fail();
    const expected = [4, 8, 16, 30, 30];
    for (const minutes of expected) {
      await age(31 * 60);
      expect((await acquireSmsSendGate("prober")).mode).toBe("probe");
      await fail();
      const r = await row();
      expect(r.state).toBe("open");
      expect(backoffMinutes(r)).toBe(minutes);
    }
    expect((await row()).open_count).toBe(6);
  });

  it("probe success closes and resets; heartbeat ok and an info event", async () => {
    await fail();
    await age(150);
    expect((await acquireSmsSendGate("w1")).mode).toBe("probe");
    obs.pingHeartbeat.mockClear();
    await noteSmsProviderSuccess(new Date());
    expect(await row()).toMatchObject({ state: "closed", open_count: 0, probe_holder: null, backoff_until: null });
    expect(obs.pingHeartbeat).toHaveBeenCalledWith(SMS_PROVIDER_JOB, true);
    expect(obs.captureServerMessage).toHaveBeenLastCalledWith(
      expect.stringContaining("normalizado"),
      "info",
      expect.anything(),
    );
    // A new failure after recovery starts again at 2 min.
    await fail();
    expect(backoffMinutes(await row())).toBe(2);
  });

  it("a success that started before the last (re)open does not close it", async () => {
    const before = new Date(Date.now() - 60_000);
    await fail();
    await noteSmsProviderSuccess(before);
    expect((await row()).state).toBe("open");
  });

  it("a stale failure (sent before the reopen) does not double the backoff of a half-open probe", async () => {
    const stale = new Date(Date.now() - 10 * 60_000);
    await fail();
    await age(150);
    expect((await acquireSmsSendGate("w1")).mode).toBe("probe");
    await fail(stale);
    expect(await row()).toMatchObject({ state: "half_open", open_count: 1, probe_holder: "w1" });
  });

  it("a probe without verdict is released and the next worker may probe at once", async () => {
    await fail();
    await age(150);
    expect((await acquireSmsSendGate("w1")).mode).toBe("probe");
    expect((await acquireSmsSendGate("w2")).mode).toBe("open");
    await releaseSmsProbe("w1");
    expect((await acquireSmsSendGate("w2")).mode).toBe("probe");
  });

  it("a vanished probe holder is replaced after the probe TTL", async () => {
    await fail();
    await age(150);
    expect((await acquireSmsSendGate("w1")).mode).toBe("probe");
    await age(301);
    expect((await acquireSmsSendGate("w2")).mode).toBe("probe");
    expect((await row()).probe_holder).toBe("w2");
  });

  it("reminds every 15 min while open (acquire), not on every tick", async () => {
    await fail();
    expect(obs.captureServerMessage).toHaveBeenCalledTimes(1);
    await acquireSmsSendGate("w1");
    expect(obs.captureServerMessage).toHaveBeenCalledTimes(1);
    await age(16 * 60);
    await acquireSmsSendGate("w1");
    await acquireSmsSendGate("w2");
    expect(obs.captureServerMessage).toHaveBeenCalledTimes(2);
  });

  it("banner text shows since / retry time in BRT", async () => {
    expect(
      smsSuspendedMessage({ since: "2026-10-15T14:38:00Z", retryAt: "2026-10-15T14:40:00Z" }),
    ).toBe(
      "Envio de SMS suspenso: provedor recusou (sem saldo/autenticação) desde 11:38 — tentando novamente às 11:40",
    );
  });

  it("fails open when the migration is missing", async () => {
    await pg.db.exec("alter table public.provider_circuit_breakers rename to provider_circuit_breakers_x");
    try {
      __resetSmsBreakerCacheForTests();
      expect(await acquireSmsSendGate("w1")).toEqual({ mode: "closed" });
      expect((await readSmsBreaker({ force: true })).state).toBe("closed");
    } finally {
      await pg.db.exec("alter table public.provider_circuit_breakers_x rename to provider_circuit_breakers");
    }
  });
});
