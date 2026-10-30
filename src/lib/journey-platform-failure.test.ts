import { describe, expect, it } from "vitest";
import { journeyPlatformFailure } from "./journey-platform-failure";

describe("journeyPlatformFailure", () => {
  it.each([
    ["SHORTIO_DOMAIN não configurado para este tenant", "shortio_not_configured"],
    ["Falha ao criar link Short.io: HTTP 503", "shortio_unavailable"],
    [
      "Falha ao registrar envio SMS: Could not find the 'provider_account_id' column of 'sms_send_logs' in the schema cache",
      "send_log_unavailable",
    ],
    ["Could not find the 'x' column of 'players' in the schema cache", "schema_mismatch"],
    ['relation "public.provider_accounts" does not exist', "schema_mismatch"],
    ["function public.reserve_journey_delivery_v3 does not exist", "schema_mismatch"],
  ])("%s -> %s", (message, reason) => {
    expect(journeyPlatformFailure(new Error(message), "permanent_error")).toBe(reason);
  });

  it("missing provider credentials are the platform's", () => {
    expect(journeyPlatformFailure(new Error("x"), "provider_misconfigured")).toBe(
      "provider_misconfigured",
    );
  });

  it.each([
    "Jogador da jornada não encontrado",
    "Telefone inválido",
    "HTTP 400 invalid destination",
  ])("player-side or unknown errors keep the normal policy: %s", (message) => {
    expect(journeyPlatformFailure(new Error(message), "permanent_error")).toBeNull();
  });
});
