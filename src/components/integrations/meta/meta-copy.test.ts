import { describe, expect, it } from "vitest";

import type { DisconnectImpact } from "@/components/integrations/meta-connection-model";
import {
  canConfirmDisconnect,
  emptyAccountsHelp,
  firstReadFailedText,
  groupToggleVisibleLabel,
  incrementalText,
  legacyBadge,
  replaceCreatedNewWarning,
  summaryError,
  unsavedLeaveConfirm,
} from "./meta-copy";

const impact = (requiresTypedConfirmation: boolean): DisconnectImpact => ({
  accountsReached: 1,
  businesses: 1,
  stop: requiresTypedConfirmation ? 1 : 0,
  keepVia: [],
  requiresTypedConfirmation,
});

describe("canConfirmDisconnect", () => {
  it("needs no typing when nothing stops", () => {
    expect(canConfirmDisconnect(impact(false), "Mídia Interna", "")).toBe(true);
  });

  it("accepts the title ignoring accents, case and spaces", () => {
    const typed = impact(true);
    expect(canConfirmDisconnect(typed, "Mídia Interna", "")).toBe(false);
    expect(canConfirmDisconnect(typed, "Mídia Interna", "Mídia Interna")).toBe(true);
    expect(canConfirmDisconnect(typed, "Mídia Interna", "  midia   INTERNA ")).toBe(true);
    expect(canConfirmDisconnect(typed, "  Agência  X", "agencia x")).toBe(true);
    expect(canConfirmDisconnect(typed, "Mídia Interna", "Mídia")).toBe(false);
  });

  it("never matches an empty title", () => {
    expect(canConfirmDisconnect(impact(true), "  ", "")).toBe(false);
  });
});

describe("texts", () => {
  it("exports the fixed copy", () => {
    expect(replaceCreatedNewWarning).toBe(
      "Esta chave é de outro Usuário do Sistema ou de outro app: ela foi adicionada como uma nova conexão e a chave antiga continua conectada.",
    );
    expect(emptyAccountsHelp).toBe(
      "Nenhuma conta de anúncio apareceu. No Business Manager, dê ao Usuário do Sistema acesso às contas de anúncio e depois clique em “Testar acesso”.",
    );
    expect(summaryError).toBe("Não foi possível carregar a conexão com a Meta.");
    expect(legacyBadge).toBe("Conexão antiga");
    expect(unsavedLeaveConfirm).toBe(
      "Você tem alterações não salvas nas contas da Meta. Sair mesmo assim?",
    );
  });

  it("labels the group toggle by filter state", () => {
    expect(groupToggleVisibleLabel("Sorte Alta", false)).toBe(
      "Marcar todas as contas da BM Sorte Alta",
    );
    expect(groupToggleVisibleLabel("Sorte Alta", true)).toBe(
      "Marcar as contas visíveis da BM Sorte Alta",
    );
  });

  it("pluralizes the first-read failures and shows the incremental %", () => {
    expect(firstReadFailedText(1)).toBe("Pronto · 1 conta com erro na primeira leitura");
    expect(firstReadFailedText(3)).toBe("Pronto · 3 contas com erro na primeira leitura");
    expect(incrementalText(42)).toBe("Importando contas novas (42%)");
  });
});
