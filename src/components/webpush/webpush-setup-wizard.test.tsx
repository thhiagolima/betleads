import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// This repo's component tests render plain-HTML components with
// `renderToStaticMarkup` (no @testing-library/react, no jsdom — see
// domain-detail.test.tsx / link-domain-dialog.test.tsx). Interaction (a
// click moving the wizard to the next step) is tested against the pure
// functions the component wires its buttons to (`nextWizardStep`,
// `canAdvanceStep`), not a simulated DOM event. `WebpushSetupWizard` itself
// uses useQuery/useMutation (for the worker check, the recent-subscriptions
// list and the test send), so those two hooks are mocked the same way
// meta-connection-panel.test.tsx mocks them for a static render.
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined, isLoading: false }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false, data: undefined }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/webpush/webpush.functions", () => ({
  verifyWebpushWorkerFn: vi.fn(),
  listRecentWebpushSubscriptionsFn: vi.fn(),
  sendWebpushTestFn: vi.fn(),
}));

import {
  canAdvanceStep,
  initialWizardStep,
  nextWizardStep,
  PlayerStepView,
  WebpushNotActivatedView,
  WebpushSetupWizard,
  WORKER_VERIFY_MESSAGES,
  WorkerFileStepView,
  type AppProgress,
} from "./webpush-setup-wizard";

function progress(overrides: Partial<AppProgress> = {}): AppProgress {
  return {
    workerVerifiedAt: null,
    scriptSeenAt: null,
    playerLinkedAt: null,
    testSentAt: null,
    ...overrides,
  };
}

function findButtonOpenTag(html: string, label: string): string {
  const re = new RegExp(`<button([^>]*)>(?:(?!</button>)[\\s\\S])*?${label}`);
  const match = html.match(re);
  if (!match) throw new Error(`button not found for label: ${label}`);
  return match[1];
}

function isDisabled(buttonOpenTagAttrs: string): boolean {
  return /(^|\s)disabled(=|\s|$)/.test(buttonOpenTagAttrs);
}

describe("initialWizardStep", () => {
  it("sem worker_verified_at, abre na etapa 1", () => {
    expect(initialWizardStep(progress())).toBe(1);
  });

  it("com worker_verified_at e sem script_seen_at, abre na etapa 2", () => {
    expect(initialWizardStep(progress({ workerVerifiedAt: "2026-11-05T00:00:00.000Z" }))).toBe(2);
  });

  it("com worker_verified_at e script_seen_at, abre na etapa 3", () => {
    expect(
      initialWizardStep(
        progress({
          workerVerifiedAt: "2026-11-05T00:00:00.000Z",
          scriptSeenAt: "2026-11-05T00:00:00.000Z",
        }),
      ),
    ).toBe(3);
  });

  it("com tudo preenchido, abre na etapa 4", () => {
    expect(
      initialWizardStep(
        progress({
          workerVerifiedAt: "2026-11-05T00:00:00.000Z",
          scriptSeenAt: "2026-11-05T00:00:00.000Z",
          playerLinkedAt: "2026-11-05T00:00:00.000Z",
        }),
      ),
    ).toBe(4);
  });
});

describe("canAdvanceStep", () => {
  it("etapa 1 só avança com worker_verified_at", () => {
    expect(canAdvanceStep(1, progress())).toBe(false);
    expect(canAdvanceStep(1, progress({ workerVerifiedAt: "2026-11-05T00:00:00.000Z" }))).toBe(true);
  });

  it("etapa 2 só avança com script_seen_at", () => {
    expect(canAdvanceStep(2, progress())).toBe(false);
    expect(canAdvanceStep(2, progress({ scriptSeenAt: "2026-11-05T00:00:00.000Z" }))).toBe(true);
  });

  it("etapa 3 só avança com player_linked_at (fora do 'Pular por enquanto')", () => {
    expect(canAdvanceStep(3, progress())).toBe(false);
    expect(canAdvanceStep(3, progress({ playerLinkedAt: "2026-11-05T00:00:00.000Z" }))).toBe(true);
  });

  it("etapa 4 é a última — nunca tem 'Próxima etapa'", () => {
    expect(canAdvanceStep(4, progress({ testSentAt: "2026-11-05T00:00:00.000Z" }))).toBe(false);
  });
});

describe("nextWizardStep (wired a 'Pular por enquanto' na etapa 3)", () => {
  it("'Pular por enquanto' na etapa 3 leva à etapa 4", () => {
    expect(nextWizardStep(3)).toBe(4);
  });

  it("não passa da etapa 4", () => {
    expect(nextWizardStep(4)).toBe(4);
  });
});

describe("WorkerFileStepView", () => {
  it("mostra a etapa 1 com 'Próxima etapa' desabilitado quando não verificado", () => {
    const html = renderToStaticMarkup(
      <WorkerFileStepView
        workerUrl="https://casa.bet.br/push/onesignal/OneSignalSDKWorker.js"
        canAdvance={false}
        verifying={false}
        verifyResult={null}
        onVerify={() => {}}
        onNext={() => {}}
      />,
    );

    expect(html).toContain("push/onesignal");
    expect(html).toContain("Baixar OneSignalSDKWorker.js");
    expect(html).toContain("Verificar agora");
    expect(isDisabled(findButtonOpenTag(html, "Próxima etapa"))).toBe(true);
  });

  it("resposta 'html' mostra a mensagem de html", () => {
    const html = renderToStaticMarkup(
      <WorkerFileStepView
        workerUrl="https://casa.bet.br/push/onesignal/OneSignalSDKWorker.js"
        canAdvance={false}
        verifying={false}
        verifyResult={{ ok: false, reason: "html" }}
        onVerify={() => {}}
        onNext={() => {}}
      />,
    );

    expect(html).toContain(WORKER_VERIFY_MESSAGES.html);
  });

  it("cada motivo de falha tem sua própria mensagem em pt-BR", () => {
    expect(WORKER_VERIFY_MESSAGES.nao_encontrado).toContain("Não encontramos o arquivo");
    expect(WORKER_VERIFY_MESSAGES.tipo_errado).toContain("application/javascript");
    expect(WORKER_VERIFY_MESSAGES.conteudo_errado).toContain("Baixe de novo");
    expect(WORKER_VERIFY_MESSAGES.inacessivel).toContain("Tente de novo");
  });

  it("'Próxima etapa' habilitado quando canAdvance é true", () => {
    const html = renderToStaticMarkup(
      <WorkerFileStepView
        workerUrl="https://casa.bet.br/push/onesignal/OneSignalSDKWorker.js"
        canAdvance={true}
        verifying={false}
        verifyResult={{ ok: true }}
        onVerify={() => {}}
        onNext={() => {}}
      />,
    );

    expect(isDisabled(findButtonOpenTag(html, "Próxima etapa"))).toBe(false);
  });
});

describe("PlayerStepView (etapa 3 — Jogador)", () => {
  it("mostra o snippet do jogador e o botão 'Pular por enquanto'", () => {
    const html = renderToStaticMarkup(
      <PlayerStepView
        playerSnippet='<script>window.betleads = { playerId: "ID_DO_JOGADOR" };</script>'
        canAdvance={false}
        onCopy={() => {}}
        onSkip={() => {}}
        onNext={() => {}}
      />,
    );

    expect(html).toContain("ID_DO_JOGADOR");
    expect(html).toContain("Pular por enquanto");
    expect(isDisabled(findButtonOpenTag(html, "Próxima etapa"))).toBe(true);
  });
});

describe("WebpushNotActivatedView", () => {
  it("casa sem app e sem acesso de super admin vê a mensagem de não ativado e nenhum botão Ativar", () => {
    const html = renderToStaticMarkup(<WebpushNotActivatedView />);

    expect(html).toContain("O Web Push ainda não foi ativado para esta casa. Fale com a Betleads.");
    expect(html).not.toContain("Ativar");
  });
});

describe("WebpushSetupWizard (render inicial a partir do progresso do app)", () => {
  function app(overrides: Partial<AppProgress> = {}) {
    return {
      id: "app-1",
      origin: "https://casa.bet.br",
      workerUrl: "https://casa.bet.br/push/onesignal/OneSignalSDKWorker.js",
      ...progress(overrides),
    };
  }

  it("sem worker_verified_at, renderiza a etapa 1 com 'Próxima etapa' desabilitado", () => {
    const html = renderToStaticMarkup(
      <WebpushSetupWizard
        app={app()}
        loaderSnippet={'<script src="https://betleads.io/loader.js" async></script>'}
        playerSnippet='<script>window.betleads = { playerId: "ID_DO_JOGADOR" };</script>'
        onProgress={() => {}}
      />,
    );

    expect(html).toContain("Baixar OneSignalSDKWorker.js");
    expect(isDisabled(findButtonOpenTag(html, "Próxima etapa"))).toBe(true);
  });

  it("com worker_verified_at e script_seen_at, abre direto na etapa 3 (Jogador)", () => {
    const html = renderToStaticMarkup(
      <WebpushSetupWizard
        app={app({
          workerVerifiedAt: "2026-11-05T00:00:00.000Z",
          scriptSeenAt: "2026-11-05T00:00:00.000Z",
        })}
        loaderSnippet={'<script src="https://betleads.io/loader.js" async></script>'}
        playerSnippet='<script>window.betleads = { playerId: "ID_DO_JOGADOR" };</script>'
        onProgress={() => {}}
      />,
    );

    expect(html).toContain("ID_DO_JOGADOR");
    expect(html).toContain("Pular por enquanto");
    expect(html).not.toContain("Baixar OneSignalSDKWorker.js");
  });
});
