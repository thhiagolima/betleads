import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ExpertUsageCard } from "./expert-usage-card";

const base = {
  teto: 100,
  usado: 10,
  restante: 90,
  pendentes: 0,
  pendentesEstimado: 0,
  mes: "2026-10",
};
const html = (props: Parameters<typeof ExpertUsageCard>[0]) =>
  renderToStaticMarkup(<ExpertUsageCard {...props} />).replace(/\u00a0/g, " ");

describe("ExpertUsageCard", () => {
  it("shows used × cap with a progress bar", () => {
    const out = html({ usage: base });
    expect(out).toContain("Uso do mês: R$ 10,00 de R$ 100,00");
    expect(out).toContain('role="progressbar"');
    expect(out).toContain('aria-valuenow="10"');
    expect(out).toContain("bg-primary");
  });

  it("amber at 80% and red with the blocked text at 100%", () => {
    expect(html({ usage: { ...base, usado: 85, restante: 15 } })).toContain("bg-warning");
    const full = html({ usage: { ...base, usado: 100, restante: 0 } });
    expect(full).toContain("bg-danger");
    expect(full).toContain(
      "Teto atingido; novos envios voltam em 01/11 ou quando o admin aumentar o teto.",
    );
  });

  it("no cap and cap R$ 0", () => {
    const none = html({ usage: { ...base, teto: null, restante: null } });
    expect(none).toContain("Sem teto definido");
    expect(none).not.toContain('role="progressbar"');
    expect(html({ usage: { ...base, teto: 0, restante: 0, usado: 0 } })).toContain(
      "Envios bloqueados (teto R$ 0)",
    );
  });

  it("shows the campaigns waiting for approval", () => {
    expect(html({ usage: { ...base, pendentes: 1, pendentesEstimado: 4.5 } })).toContain(
      "1 campanha aguardando aprovação · R$ 4,50 estimados",
    );
  });

  it("loading and error states", () => {
    expect(html({ usage: undefined, loading: true })).toContain("Carregando consumo…");
    expect(html({ usage: undefined, failed: true })).toContain(
      "Não foi possível carregar o consumo do mês.",
    );
  });
});
