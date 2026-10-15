import { afterEach, describe, expect, it } from "vitest";
import { matchFinancialTrigger } from "./journeys.server";
import {
  eventEntryEnabled,
  eventEntryTriggers,
  journeyInWorkerScope,
  matchJourneyScanPlayer,
  runJourneyScanner,
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
