import { afterEach, describe, expect, it } from "vitest";
import { matchFinancialTrigger } from "./journeys.server";
import { matchJourneyScanPlayer, runJourneyScanner } from "./journey-scanner.server";

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
