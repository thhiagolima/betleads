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
  buildDownloadUrl,
  buildSupportTicketText,
  canAdvanceStep,
  initialWizardStep,
  InstallationStepView,
  isWizardComplete,
  nextWizardStep,
  WebpushNotActivatedView,
  WebpushSetupWizard,
  WORKER_VERIFY_MESSAGES,
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

  it("com worker_verified_at e sem script_seen_at, abre na etapa 1", () => {
    expect(initialWizardStep(progress({ workerVerifiedAt: "2026-11-05T00:00:00.000Z" }))).toBe(1);
  });

  it("com worker_verified_at e script_seen_at, abre direto na etapa 2 (Teste)", () => {
    expect(
      initialWizardStep(
        progress({
          workerVerifiedAt: "2026-11-05T00:00:00.000Z",
          scriptSeenAt: "2026-11-05T00:00:00.000Z",
        }),
      ),
    ).toBe(2);
  });
});

describe("canAdvanceStep", () => {
  it("etapa 1 só avança com worker_verified_at e script_seen_at juntos", () => {
    expect(canAdvanceStep(1, progress())).toBe(false);
    expect(canAdvanceStep(1, progress({ workerVerifiedAt: "2026-11-05T00:00:00.000Z" }))).toBe(
      false,
    );
    expect(canAdvanceStep(1, progress({ scriptSeenAt: "2026-11-05T00:00:00.000Z" }))).toBe(false);
    expect(
      canAdvanceStep(
        1,
        progress({
          workerVerifiedAt: "2026-11-05T00:00:00.000Z",
          scriptSeenAt: "2026-11-05T00:00:00.000Z",
        }),
      ),
    ).toBe(true);
  });

  it("etapa 2 é a última — nunca tem 'Próxima etapa'", () => {
    expect(canAdvanceStep(2, progress({ testSentAt: "2026-11-05T00:00:00.000Z" }))).toBe(false);
  });
});

describe("nextWizardStep", () => {
  it("avança da etapa 1 para a 2", () => {
    expect(nextWizardStep(1)).toBe(2);
  });

  it("não passa da etapa 2", () => {
    expect(nextWizardStep(2)).toBe(2);
  });
});

describe("isWizardComplete", () => {
  it("precisa de worker + script + teste enviado — jogador não é obrigatório", () => {
    expect(
      isWizardComplete(
        progress({
          workerVerifiedAt: "2026-11-05T00:00:00.000Z",
          scriptSeenAt: "2026-11-05T00:00:00.000Z",
          testSentAt: "2026-11-05T00:00:00.000Z",
        }),
      ),
    ).toBe(true);
  });

  it("sem teste enviado, não está completo mesmo com o resto preenchido", () => {
    expect(
      isWizardComplete(
        progress({
          workerVerifiedAt: "2026-11-05T00:00:00.000Z",
          scriptSeenAt: "2026-11-05T00:00:00.000Z",
          playerLinkedAt: "2026-11-05T00:00:00.000Z",
        }),
      ),
    ).toBe(false);
  });
});

describe("buildDownloadUrl", () => {
  it("deriva a origem do CRM a partir do src do loaderSnippet", () => {
    expect(
      buildDownloadUrl(
        '<script src="https://betleads.io/loader.js" async></script>',
        "https://fallback.example",
      ),
    ).toBe("https://betleads.io/api/public/push/worker.js");
  });

  it("sem um src reconhecível, usa a origem de fallback (window.location.origin)", () => {
    expect(buildDownloadUrl("<script>window.foo=1;</script>", "https://crm.betleads.io")).toBe(
      "https://crm.betleads.io/api/public/push/worker.js",
    );
  });
});

describe("buildSupportTicketText", () => {
  const text = buildSupportTicketText({
    origin: "https://casa.bet.br",
    workerUrl: "https://casa.bet.br/push/onesignal/OneSignalSDKWorker.js",
    downloadUrl: "https://crm.betleads.io/api/public/push/worker.js",
    loaderSnippet: '<script src="https://betleads.io/loader.js" async></script>',
    playerSnippet: '<script>window.betleads = { playerId: "ID_DO_JOGADOR" };</script>',
  });

  it("contém a origem, a url do worker, a url de download e os dois snippets", () => {
    expect(text).toContain("https://casa.bet.br");
    expect(text).toContain("https://casa.bet.br/push/onesignal/OneSignalSDKWorker.js");
    expect(text).toContain("https://crm.betleads.io/api/public/push/worker.js");
    expect(text).toContain('<script src="https://betleads.io/loader.js" async></script>');
    expect(text).toContain('<script>window.betleads = { playerId: "ID_DO_JOGADOR" };</script>');
  });

  it("segue o template exato pt-BR com os 3 passos", () => {
    expect(text).toBe(
      `Olá! Precisamos ativar as notificações (web push) no site https://casa.bet.br. São 2 passos obrigatórios e 1 opcional:

1) Arquivo do service worker
Baixe o arquivo em: https://crm.betleads.io/api/public/push/worker.js
Coloque-o, sem renomear nem editar, na pasta push/onesignal na raiz do site.
Ele deve abrir neste endereço (mostrando uma linha de texto): https://casa.bet.br/push/onesignal/OneSignalSDKWorker.js
O servidor precisa entregar o arquivo como JavaScript (Content-Type application/javascript).

2) Script
Cole este código no <head> de todas as páginas do site:
<script src="https://betleads.io/loader.js" async></script>

3) Jogador logado (opcional, recomendado)
Quando o jogador estiver logado, defina antes do script acima, com o mesmo ID de jogador enviado nos webhooks:
<script>window.betleads = { playerId: "ID_DO_JOGADOR" };</script>

Obrigado!`,
    );
  });
});

describe("InstallationStepView (etapa 1 — Instalação no site)", () => {
  function render(overrides: Partial<Parameters<typeof InstallationStepView>[0]> = {}) {
    return renderToStaticMarkup(
      <InstallationStepView
        origin="https://casa.bet.br"
        workerUrl="https://casa.bet.br/push/onesignal/OneSignalSDKWorker.js"
        downloadUrl="https://crm.betleads.io/api/public/push/worker.js"
        loaderSnippet='<script src="https://betleads.io/loader.js" async></script>'
        playerSnippet='<script>window.betleads = { playerId: "ID_DO_JOGADOR" };</script>'
        canAdvance={false}
        verifyingWorker={false}
        workerVerifyResult={null}
        onVerifyWorker={() => {}}
        scriptSeen={false}
        checkingScript={false}
        onCheckScript={() => {}}
        playerLinked={false}
        onNext={() => {}}
        {...overrides}
      />,
    );
  }

  it("mostra o botão de copiar instruções e os três blocos (arquivo, script, jogador)", () => {
    const html = render();

    expect(html).toContain("Copiar instruções para o suporte");
    expect(html).toContain("Envie as instruções abaixo para o suporte da plataforma do site em um único chamado.");
    expect(html).toContain("1. Arquivo");
    expect(html).toContain("Baixar OneSignalSDKWorker.js");
    expect(html).toContain("push/onesignal");
    expect(html).toContain("2. Script");
    expect(html).toContain("betleads.io/loader.js");
    expect(html).toContain("3. Jogador logado");
    expect(html).toContain("ID_DO_JOGADOR");
  });

  it("linha de status: arquivo com 'Verificar agora', script aguardando com botão 'Verificar', jogador informativo", () => {
    const html = render();

    expect(html).toContain("Verificar agora");
    expect(html).toContain("Aguardando o primeiro acesso ao site");
    expect(html).toContain("Verificar");
    expect(html).toContain("Ainda não identificado (opcional)");
  });

  it("resposta 'html' do worker ainda mostra a mensagem verbatim", () => {
    const html = render({ workerVerifyResult: { ok: false, reason: "html" } });

    expect(html).toContain(WORKER_VERIFY_MESSAGES.html);
  });

  it("worker verificado com sucesso mostra 'Arquivo encontrado'", () => {
    const html = render({ workerVerifyResult: { ok: true } });

    expect(html).toContain("Arquivo encontrado");
  });

  it("script detectado mostra 'Script detectado' e não mostra o botão 'Verificar' do script", () => {
    const html = render({ scriptSeen: true });

    expect(html).toContain("Script detectado");
    expect(html).not.toContain("Aguardando o primeiro acesso ao site");
  });

  it("jogador identificado mostra a mensagem de identificado", () => {
    const html = render({ playerLinked: true });

    expect(html).toContain("Jogador identificado");
  });

  it("'Próxima etapa' fica desabilitado até canAdvance ser true", () => {
    const html = render({ canAdvance: false });
    expect(isDisabled(findButtonOpenTag(html, "Próxima etapa"))).toBe(true);

    const htmlEnabled = render({ canAdvance: true });
    expect(isDisabled(findButtonOpenTag(htmlEnabled, "Próxima etapa"))).toBe(false);
  });

  it("botão 'Verificar' do script fica desabilitado enquanto checkingScript é true", () => {
    const html = render({ checkingScript: true });
    expect(isDisabled(findButtonOpenTag(html, "Verificando…"))).toBe(true);
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

  it("sem worker_verified_at nem script_seen_at, renderiza a etapa 1 (instalação) com 'Próxima etapa' desabilitado", () => {
    const html = renderToStaticMarkup(
      <WebpushSetupWizard
        app={app()}
        loaderSnippet={'<script src="https://betleads.io/loader.js" async></script>'}
        playerSnippet='<script>window.betleads = { playerId: "ID_DO_JOGADOR" };</script>'
        onProgress={() => {}}
        onCheckScript={() => Promise.resolve()}
      />,
    );

    expect(html).toContain("Baixar OneSignalSDKWorker.js");
    expect(html).toContain("Copiar instruções para o suporte");
    expect(isDisabled(findButtonOpenTag(html, "Próxima etapa"))).toBe(true);
  });

  it("com worker_verified_at e script_seen_at, abre direto na etapa 2 (Teste)", () => {
    const html = renderToStaticMarkup(
      <WebpushSetupWizard
        app={app({
          workerVerifiedAt: "2026-11-05T00:00:00.000Z",
          scriptSeenAt: "2026-11-05T00:00:00.000Z",
        })}
        loaderSnippet={'<script src="https://betleads.io/loader.js" async></script>'}
        playerSnippet='<script>window.betleads = { playerId: "ID_DO_JOGADOR" };</script>'
        onProgress={() => {}}
        onCheckScript={() => Promise.resolve()}
      />,
    );

    expect(html).not.toContain("Baixar OneSignalSDKWorker.js");
    expect(html).not.toContain("Copiar instruções para o suporte");
    expect(html).toContain("Abra o site da casa neste navegador e aceite as notificações.");
  });
});
