import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

import { countEligible, smsPassSegments } from "./journey-activation-preview.server";
import type { Journey, Player } from "./journey-scanner.server";

const DAY = 86400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();

const journey = (overrides: Partial<Journey> = {}): Journey => ({
  id: "j1",
  tenant_id: "t1",
  version: 1,
  status: "active",
  trigger_type: "cadastrados_sem_deposito",
  trigger_config: { start_after: "1970-01-01T00:00:00.000Z" },
  entry_rules: { audience: "system:all-leads" },
  cooldown_hours: 0,
  ...overrides,
});

const player = (id: string, overrides: Record<string, unknown> = {}): Player =>
  ({
    id,
    tenant_id: "t1",
    status: "ativo",
    vip: false,
    ftd_em: null,
    total_depositado: 0,
    created_at: daysAgo(1),
    telefone: "(11) 99999-0000",
    ...overrides,
  }) as Player;

describe("countEligible (P1.2: the same matcher as the real entry)", () => {
  it("applies the entry max age: an imported base does not count as new sign-ups", () => {
    const players = [player("new"), player("old", { created_at: daysAgo(40) })];
    expect(
      countEligible({
        journey: journey(),
        players,
        occurrences: new Map(),
        openPlayerIds: new Set(),
        needsPhone: true,
      }),
    ).toBe(1);
  });

  it("applies the entry filters, skips players already in the journey and without a phone", () => {
    const dormant = journey({
      trigger_type: "inactivity",
      trigger_config: { field: "ultimo_deposito", hours: 168 },
      entry_rules: { audience: "system:all-leads", filters: { min_total_deposited: 200 } },
    });
    const lastDeposit = { ultimo_deposito: daysAgo(10) };
    const players = [
      player("rich", { ...lastDeposit, total_depositado: 500 }),
      player("small", { ...lastDeposit, total_depositado: 50 }),
      player("enrolled", { ...lastDeposit, total_depositado: 500 }),
      player("nophone", { ...lastDeposit, total_depositado: 500, telefone: "" }),
    ];
    expect(
      countEligible({
        journey: dormant,
        players,
        occurrences: new Map(),
        openPlayerIds: new Set(["enrolled"]),
        needsPhone: true,
      }),
    ).toBe(1);
  });

  it("financial triggers need an occurrence", () => {
    const pix = journey({ trigger_type: "pix_gerado_nao_pago" });
    expect(
      countEligible({
        journey: pix,
        players: [player("a"), player("b")],
        occurrences: new Map([["a", "deposit-1"]]),
        openPlayerIds: new Set(),
        needsPhone: false,
      }),
    ).toBe(1);
  });
});

describe("smsPassSegments", () => {
  it("counts SMS steps and segments, using the longest variant", () => {
    const long = "x".repeat(200); // 2 GSM-7 segments
    expect(
      smsPassSegments([
        { step_type: "sms", config: { content: "oi" } },
        { step_type: "wait", config: { delay_seconds: 86400 } },
        { step_type: "sms", config: { content: "curto", variants: ["curto", long] } },
        { step_type: "email", config: {} },
      ]),
    ).toEqual({ smsSteps: 2, segmentsPerPass: 3, firstSmsSegments: 1 });
  });

  it("no SMS steps: no SMS cost", () => {
    expect(smsPassSegments([{ step_type: "email", config: {} }])).toEqual({
      smsSteps: 0,
      segmentsPerPass: 0,
      firstSmsSegments: 0,
    });
  });
});
