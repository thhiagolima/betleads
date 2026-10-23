import { describe, expect, it } from "vitest";

import { alreadySentSuffix, campaignPausedForBalanceMessage } from "./email-campaign-messages";

describe("email campaign run messages", () => {
  it("counts recipients already reached by earlier runs as sent", () => {
    expect(campaignPausedForBalanceMessage({ enviados: 1, total: 4, jaEnviados: 2 })).toBe(
      "Campanha pausada por saldo insuficiente: 3 de 4 e-mails enviados. Recarregue a carteira e envie novamente.",
    );
  });

  it("adds the already-received suffix only when a re-run skipped someone", () => {
    expect(alreadySentSuffix({ jaEnviados: 0 })).toBe("");
    expect(alreadySentSuffix({})).toBe("");
    expect(alreadySentSuffix({ jaEnviados: 2 })).toBe(
      " 2 já tinham recebido e não receberam de novo.",
    );
  });
});
