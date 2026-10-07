import { describe, expect, it } from "vitest";

import { tenantSafeChannelError } from "./channel-error";

describe("tenantSafeChannelError", () => {
  it("preserves actionable product validation", () => {
    expect(tenantSafeChannelError(new Error("Informe o nome da campanha."))).toBe(
      "Informe o nome da campanha.",
    );
  });

  it("redacts vendor, endpoint and credential details", () => {
    const safe = tenantSafeChannelError(
      new Error("Infobip HTTP 401: INFOBIP_API_KEY inválida no endpoint https://example.test"),
    );
    expect(safe).toBe(
      "Não foi possível concluir a operação do canal. Tente novamente ou contate o suporte.",
    );
    expect(safe).not.toMatch(/infobip|api_key|https/i);
  });
});
