import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Same approach as webpush-setup-wizard.test.tsx / meta-connection-panel.test.tsx:
// this repo has no @testing-library/react or jsdom (see domain-detail.test.tsx),
// so `WebpushIntegrationPanel` (which uses useQuery/useMutation/useServerFn
// across several child components) is rendered with those hooks mocked to a
// fixed, test-controlled state, via `renderToStaticMarkup`.
const state = vi.hoisted(() => ({
  isSuperAdmin: false as boolean,
  integration: undefined as unknown,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: state.integration, isLoading: false }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false, data: undefined }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/webpush/webpush.functions", () => ({
  getWebpushIntegrationFn: vi.fn(),
  verifyWebpushWorkerFn: vi.fn(),
  listRecentWebpushSubscriptionsFn: vi.fn(),
  sendWebpushTestFn: vi.fn(),
  activateWebpushOriginFn: vi.fn(),
  setWebpushAppStatusFn: vi.fn(),
  saveWebpushPromptFn: vi.fn(),
}));
vi.mock("@/hooks/use-is-super-admin", () => ({
  useIsSuperAdmin: () => ({ loading: false, isSuperAdmin: state.isSuperAdmin }),
}));

import { reduceRedoing, WebpushIntegrationPanel } from "./webpush-integration-panel";

type IntegrationFixture = {
  enabled: boolean;
  canEdit: boolean;
  isSuperAdmin: boolean;
  tenantId: string;
  siteUrl: string | null;
  loaderSnippet: string;
  playerSnippet: string;
  prompt: { promptText: string; acceptLabel: string; cancelLabel: string; iconUrl: string | null };
  apps: unknown[];
  current: unknown;
};

function integration(overrides: Partial<IntegrationFixture> = {}): IntegrationFixture {
  return {
    enabled: false,
    canEdit: true,
    isSuperAdmin: false,
    tenantId: "tenant-1",
    siteUrl: "https://casa.bet.br",
    loaderSnippet: "<script></script>",
    playerSnippet: "<script></script>",
    prompt: { promptText: "Quer receber promoções?", acceptLabel: "Permitir", cancelLabel: "Agora não", iconUrl: null },
    apps: [],
    current: null,
    ...overrides,
  };
}

describe("WebpushIntegrationPanel — permissão de super admin (sem app ativado)", () => {
  it("casa sem app e usuário não super admin: mostra a mensagem de não ativado e nenhum botão Ativar, sem o bloco de super admin", () => {
    state.isSuperAdmin = false;
    state.integration = integration();

    const html = renderToStaticMarkup(<WebpushIntegrationPanel />);

    expect(html).toContain("O Web Push ainda não foi ativado para esta casa. Fale com a Betleads.");
    expect(html).not.toContain("Ativar");
    expect(html).not.toContain("Super admin · Web Push");
  });

  it("casa sem app e usuário super admin: mostra o bloco de ativação do super admin, não a mensagem de não ativado", () => {
    state.isSuperAdmin = true;
    state.integration = integration();

    const html = renderToStaticMarkup(<WebpushIntegrationPanel />);

    expect(html).not.toContain("O Web Push ainda não foi ativado para esta casa. Fale com a Betleads.");
    expect(html).toContain("Super admin · Web Push");
    expect(html).toContain("Ativar");
    expect(html).toContain("Criar app automaticamente");
  });

  it("com app ativado, o bloco de super admin aparece mesmo para o super admin (gestão de origens)", () => {
    state.isSuperAdmin = true;
    state.integration = integration({
      current: {
        id: "app-1",
        origin: "https://casa.bet.br",
        status: "ativo",
        workerVerifiedAt: "2026-11-05T00:00:00.000Z",
        scriptSeenAt: "2026-11-05T00:00:00.000Z",
        playerLinkedAt: "2026-11-05T00:00:00.000Z",
        testSentAt: "2026-11-05T00:00:00.000Z",
      },
      apps: [
        {
          id: "app-1",
          origin: "https://casa.bet.br",
          status: "ativo",
          activeSubscriptions: 3,
          identifiedSubscriptions: 1,
        },
      ],
    });

    const html = renderToStaticMarkup(<WebpushIntegrationPanel />);

    expect(html).toContain("Super admin · Web Push");
  });
});

describe("reduceRedoing (botão 'Refazer verificação')", () => {
  it("'Refazer verificação' esconde o resumo (volta a true)", () => {
    expect(reduceRedoing(false, { type: "redo" })).toBe(true);
  });

  it("um novo teste enviado com sucesso faz o resumo voltar a aparecer (volta a false)", () => {
    expect(reduceRedoing(true, { type: "test-sent" })).toBe(false);
  });

  it("depois de 'Refazer verificação', só um teste enviado com sucesso traz o resumo de volta — não um progresso qualquer", () => {
    // Regression: `redoing` previously never reset, so the completed summary
    // never reappeared after "Refazer verificação" until a page reload.
    let redoing = reduceRedoing(false, { type: "redo" });
    expect(redoing).toBe(true);

    redoing = reduceRedoing(redoing, { type: "test-sent" });
    expect(redoing).toBe(false);
  });
});
