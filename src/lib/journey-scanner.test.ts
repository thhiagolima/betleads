import { afterEach, describe, expect, it } from "vitest";
import { matchFinancialTrigger } from "./journeys.server";
import {
  CROSSING_TRIGGERS,
  crossingEnabled,
  crossingSpecFor,
  crossingTimeFor,
  eventEntryEnabled,
  eventEntryTriggers,
  isEventTrigger,
  journeyInWorkerScope,
  lateEntryPath,
  matchJourneyScanPlayer,
  runJourneyScanner,
  scannerRescanSeconds,
} from "./journey-scanner.server";

const journey = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "00000000-0000-0000-0000-000000000001",
    tenant_id: "00000000-0000-0000-0000-000000000002",
    version: 1,
    status: "active",
    trigger_type: "cadastrados_sem_deposito",
    trigger_config: {},
    entry_rules: { audience: "all_active", reentry: "once" },
    cooldown_hours: 24,
    ...overrides,
  }) as never;

const player = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "00000000-0000-0000-0000-000000000003",
    tenant_id: "00000000-0000-0000-0000-000000000002",
    status: "ativo",
    vip: false,
    ftd_em: null,
    created_at: "2026-01-01T00:00:00.000Z",
    total_depositado: 0,
    ...overrides,
  }) as never;

afterEach(() => {
  delete process.env.JOURNEYS_SCANNER_ENABLED;
  delete process.env.JOURNEYS_CANARY_TENANT_IDS;
  delete process.env.JOURNEYS_CANARY_JOURNEY_IDS;
  delete process.env.JOURNEYS_ALLOW_ALL_TENANTS;
  delete process.env.JOURNEYS_CROSSING_ENABLED;
  delete process.env.JOURNEYS_SCANNER_RESCAN_SECONDS;
});

describe("journey scanner eligibility", () => {
  it("accepts historical registrations when start_after is absent", () => {
    const result = matchJourneyScanPlayer(journey(), player(), new Map());
    expect(result).toEqual({
      matches: true,
      occurrence: "2026-01-01T00:00:00.000Z",
    });
  });

  it("respects start_after when it is explicitly configured", () => {
    const result = matchJourneyScanPlayer(
      journey({ trigger_config: { start_after: "2026-02-01T00:00:00.000Z" } }),
      player(),
      new Map(),
    );
    expect(result.matches).toBe(false);
  });

  it("accepts historical first deposits when start_after is absent", () => {
    const result = matchJourneyScanPlayer(
      journey({ trigger_type: "primeiro_deposito" }),
      player({ ftd_em: "2026-01-10T10:00:00.000Z" }),
      new Map(),
    );
    expect(result.matches).toBe(true);
    expect(result.occurrence).toBe("2026-01-10T10:00:00.000Z");
  });

  it("requires a financial occurrence for pending PIX journeys", () => {
    const pendingPix = journey({ trigger_type: "pix_gerado_nao_pago" });
    expect(matchJourneyScanPlayer(pendingPix, player(), new Map()).matches).toBe(false);
    expect(
      matchJourneyScanPlayer(
        pendingPix,
        player(),
        new Map([["00000000-0000-0000-0000-000000000003", "deposit-1"]]),
      ),
    ).toEqual({ matches: true, occurrence: "deposit-1" });
  });

  it("applies tenant audience rules before trigger rules", () => {
    const result = matchJourneyScanPlayer(journey(), player({ status: "inativo" }), new Map());
    expect(result.matches).toBe(false);
  });
});

describe("journey scanner kill switch", () => {
  it("fails closed without touching the queue", async () => {
    process.env.JOURNEYS_SCANNER_ENABLED = "false";
    await expect(runJourneyScanner()).resolves.toEqual({
      disabled: true,
      jobs: 0,
      scanned: 0,
      eligible: 0,
      enrolled: 0,
      failed: 0,
    });
  });

  it("fails closed when enabled without a canary scope", async () => {
    process.env.JOURNEYS_SCANNER_ENABLED = "true";
    await expect(runJourneyScanner()).resolves.toMatchObject({
      disabled: true,
      reason: "canary_scope_required",
      jobs: 0,
    });
  });
});

describe("journey dispatcher revalidation", () => {
  it("keeps historical first deposits eligible when start_after is absent", async () => {
    await expect(
      matchFinancialTrigger(
        {
          tenant_id: "00000000-0000-0000-0000-000000000002",
          trigger_type: "primeiro_deposito",
          trigger_config: {},
        },
        player({ ftd_em: "2026-01-10T10:00:00.000Z" }),
      ),
    ).resolves.toEqual({
      matches: true,
      occurrence: "2026-01-10T10:00:00.000Z",
    });
  });
});

describe("event-driven journey entry (ENV-09)", () => {
  it("maps webhook events to the triggers they can satisfy", () => {
    expect(eventEntryTriggers("cadastro")).toEqual(["cadastrados_sem_deposito"]);
    expect(eventEntryTriggers("deposito-pendente")).toEqual(["pix_gerado_nao_pago"]);
    expect(eventEntryTriggers("deposito-aprovado")).toContain("primeiro_deposito");
    expect(eventEntryTriggers("saque-concluido")).toEqual(["saque_pago"]);
    expect(eventEntryTriggers("login")).toEqual([]);
  });

  it("follows the scanner kill switch and has its own off switch", () => {
    expect(eventEntryEnabled({ JOURNEYS_SCANNER_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(eventEntryEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(
      eventEntryEnabled({
        JOURNEYS_SCANNER_ENABLED: "true",
        JOURNEYS_EVENT_ENTRY_ENABLED: "false",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("respects the same canary scope as the scanner", () => {
    const tenant = "11111111-1111-4111-8111-111111111111";
    const other = "22222222-2222-4222-8222-222222222222";
    const journey = { id: "33333333-3333-4333-8333-333333333333", tenant_id: tenant };
    expect(
      journeyInWorkerScope(journey, { tenantIds: [], journeyIds: [], allowAll: true, allowed: true }),
    ).toBe(true);
    expect(
      journeyInWorkerScope(journey, { tenantIds: [other], journeyIds: [], allowAll: false, allowed: true }),
    ).toBe(false);
    expect(
      journeyInWorkerScope(journey, { tenantIds: [], journeyIds: [], allowAll: false, allowed: false }),
    ).toBe(false);
  });
});

describe("threshold crossing (ENV-09 part 2)", () => {
  it("has its own off switch and follows the scanner kill switch", () => {
    expect(crossingEnabled({ JOURNEYS_SCANNER_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(crossingEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(
      crossingEnabled({
        JOURNEYS_SCANNER_ENABLED: "true",
        JOURNEYS_CROSSING_ENABLED: "false",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("derives the time field and threshold of each time-based trigger", () => {
    expect(
      crossingSpecFor({
        trigger_type: "inactivity",
        trigger_config: { field: "ultimo_deposito", hours: 48 },
      }),
    ).toEqual({ fields: ["ultimo_deposito"], hours: 48 });
    expect(crossingSpecFor({ trigger_type: "inactivity", trigger_config: { hours: 0 } })).toBeNull();
    expect(
      crossingSpecFor({ trigger_type: "inactivity", trigger_config: { field: "saldo", hours: 5 } }),
    ).toBeNull();
    expect(crossingSpecFor({ trigger_type: "sem_login_7_14", trigger_config: {} })).toEqual({
      fields: ["ultimo_login", "ultimo_jogo", "ultimo_deposito"],
      hours: 168,
    });
    expect(crossingSpecFor({ trigger_type: "vip_esfriando", trigger_config: {} })?.fields).toEqual([
      "ultimo_jogo",
    ]);
    expect(crossingSpecFor({ trigger_type: "primeiro_deposito", trigger_config: {} })).toBeNull();
    for (const trigger of CROSSING_TRIGGERS) expect(isEventTrigger(trigger)).toBe(false);
  });

  it("crosses sem_login segments at greatest(activity) + min days, matching the matcher", () => {
    const day = 86400_000;
    const lastActivity = Date.now() - 7 * day - 60_000;
    const p = player({
      ftd_em: "2026-01-01T00:00:00.000Z",
      ultimo_login: new Date(lastActivity - day).toISOString(),
      ultimo_deposito: new Date(lastActivity).toISOString(),
    });
    const j = journey({ trigger_type: "sem_login_7_14" });
    expect(crossingTimeFor(j, p)).toBe(lastActivity + 7 * day);
    expect(matchJourneyScanPlayer(j, p, new Map()).matches).toBe(true);
  });
});

describe("full scanner as safety net", () => {
  it("makes the rescan interval configurable with the old default", () => {
    expect(scannerRescanSeconds({} as NodeJS.ProcessEnv)).toBe(300);
    expect(
      scannerRescanSeconds({ JOURNEYS_SCANNER_RESCAN_SECONDS: "3600" } as NodeJS.ProcessEnv),
    ).toBe(3600);
    expect(
      scannerRescanSeconds({ JOURNEYS_SCANNER_RESCAN_SECONDS: "5" } as NodeJS.ProcessEnv),
    ).toBe(60);
    expect(
      scannerRescanSeconds({ JOURNEYS_SCANNER_RESCAN_SECONDS: "abc" } as NodeJS.ProcessEnv),
    ).toBe(300);
  });

  it("flags scanner inserts that a real-time path should have made", () => {
    const now = Date.parse("2026-10-15T12:00:00.000Z");
    const ctx = { eventEntry: true, crossing: true, crossingSince: now - 3600_000, now };
    const registration = journey();
    expect(lateEntryPath(registration, player(), new Date(now - 3600_000).toISOString(), ctx)).toBe(
      "event",
    );
    // History (backfill) and very recent events are not late.
    expect(lateEntryPath(registration, player(), "2026-01-01T00:00:00.000Z", ctx)).toBeNull();
    expect(lateEntryPath(registration, player(), new Date(now - 60_000).toISOString(), ctx)).toBeNull();
    expect(
      lateEntryPath(registration, player(), new Date(now - 3600_000).toISOString(), {
        ...ctx,
        eventEntry: false,
      }),
    ).toBeNull();

    const inactivity = journey({
      trigger_type: "inactivity",
      trigger_config: { field: "ultimo_deposito", hours: 48 },
    });
    const crossedAt = (ms: number) =>
      player({ ultimo_deposito: new Date(ms - 48 * 3600_000).toISOString() });
    expect(lateEntryPath(inactivity, crossedAt(now - 30 * 60_000), "x", ctx)).toBe("crossing");
    // Crossed before the crossing job covered the journey: backlog, not late.
    expect(lateEntryPath(inactivity, crossedAt(now - 2 * 3600_000), "x", ctx)).toBeNull();
    expect(lateEntryPath(inactivity, crossedAt(now - 60_000), "x", ctx)).toBeNull();
    expect(
      lateEntryPath(inactivity, crossedAt(now - 30 * 60_000), "x", { ...ctx, crossingSince: null }),
    ).toBeNull();
  });

  it("enters cashback journeys on the cashback webhook", () => {
    expect(eventEntryTriggers("cashback-pago")).toEqual(["cashback_pago"]);
  });
});
