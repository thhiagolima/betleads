import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

import {
  isProviderAccountExitReason,
  recoverySkipReason,
  type RecoveryCandidate,
} from "./sms-provider-recovery.server";

const SINCE = "2026-10-15T14:38:00.000Z";
const ENTERED = "2026-10-15T10:00:00.000Z";

function candidate(over: {
  enrollment?: Partial<RecoveryCandidate["enrollment"]>;
  journey?: RecoveryCandidate["journey"];
  step?: RecoveryCandidate["step"];
  player?: Partial<NonNullable<RecoveryCandidate["player"]>> | null;
  consentRevoked?: boolean;
  hasLiveSibling?: boolean;
  stepAlreadySent?: boolean;
} = {}): RecoveryCandidate {
  return {
    enrollment: {
      id: "e1",
      tenant_id: "t1",
      journey_id: "j1",
      player_id: "p1",
      status: "failed",
      current_position: 1,
      loop_iteration: 0,
      entered_at: ENTERED,
      exit_reason: "Short Brasil: erro de autenticacao",
      updated_at: "2026-10-15T15:00:00.000Z",
      ...over.enrollment,
    },
    journey: over.journey === undefined ? { status: "active", exit_rules: { deposit: true } } : over.journey,
    step: over.step === undefined ? { step_type: "sms", is_enabled: true } : over.step,
    player:
      over.player === null
        ? null
        : {
            telefone: "+5511999990000",
            ultimo_deposito: "2026-10-01T00:00:00.000Z",
            ftd_em: "2026-09-01T00:00:00.000Z",
            ultimo_login: null,
            ultimo_jogo: null,
            ...over.player,
          },
    consentRevoked: over.consentRevoked ?? false,
    hasLiveSibling: over.hasLiveSibling ?? false,
    stepAlreadySent: over.stepAlreadySent ?? false,
  };
}

describe("provider outage recovery selection", () => {
  it("requeues an SMS failure caused by the account refusal", () => {
    expect(recoverySkipReason(candidate(), SINCE)).toBeNull();
    expect(
      recoverySkipReason(candidate({ enrollment: { exit_reason: "Short Brasil: saldo insuficiente" } }), SINCE),
    ).toBeNull();
  });

  it("recognises only account-level exit reasons", () => {
    expect(isProviderAccountExitReason("Short Brasil: erro de autenticacao")).toBe(true);
    expect(isProviderAccountExitReason("Provedor SMS recusou as credenciais (HTTP 401: x)")).toBe(true);
    expect(isProviderAccountExitReason("HTTP 400: numero invalido")).toBe(false);
    expect(recoverySkipReason(candidate({ enrollment: { exit_reason: "HTTP 400: numero invalido" } }), SINCE)).toBe(
      "not_provider_account",
    );
  });

  it("excludes leads that deposited (or made the FTD) after entering, even without an exit rule", () => {
    expect(
      recoverySkipReason(candidate({ player: { ultimo_deposito: "2026-10-15T12:00:00.000Z" } }), SINCE),
    ).toBe("deposited");
    expect(
      recoverySkipReason(
        candidate({ journey: { status: "active", exit_rules: {} }, player: { ftd_em: "2026-10-15T11:00:00.000Z" } }),
        SINCE,
      ),
    ).toBe("deposited");
  });

  it("respects the journey's login / voltou_jogar exit rules", () => {
    const loggedIn = { ultimo_login: "2026-10-15T13:00:00.000Z" };
    expect(
      recoverySkipReason(candidate({ journey: { status: "active", exit_rules: { login: true } }, player: loggedIn }), SINCE),
    ).toBe("exit_rule");
    expect(
      recoverySkipReason(candidate({ journey: { status: "active", exit_rules: {} }, player: loggedIn }), SINCE),
    ).toBeNull();
  });

  it("excludes opt-outs, inactive journeys, non-SMS steps, re-entries and already-sent steps", () => {
    expect(recoverySkipReason(candidate({ consentRevoked: true }), SINCE)).toBe("consent_revoked");
    expect(recoverySkipReason(candidate({ journey: { status: "paused", exit_rules: {} } }), SINCE)).toBe(
      "journey_inactive",
    );
    expect(recoverySkipReason(candidate({ step: { step_type: "email", is_enabled: true } }), SINCE)).toBe(
      "step_not_sms",
    );
    expect(recoverySkipReason(candidate({ step: { step_type: "sms", is_enabled: false } }), SINCE)).toBe(
      "step_not_sms",
    );
    expect(recoverySkipReason(candidate({ hasLiveSibling: true }), SINCE)).toBe("reentered");
    expect(recoverySkipReason(candidate({ stepAlreadySent: true }), SINCE)).toBe("already_sent");
    expect(recoverySkipReason(candidate({ player: null }), SINCE)).toBe("no_player");
  });

  it("ignores failures before the incident window and items that are no longer failed", () => {
    expect(
      recoverySkipReason(candidate({ enrollment: { updated_at: "2026-10-15T14:00:00.000Z" } }), SINCE),
    ).toBe("before_since");
    expect(recoverySkipReason(candidate({ enrollment: { status: "waiting" } }), SINCE)).toBe("not_failed");
  });
});
