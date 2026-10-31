import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  useBlocker: () => ({ status: "idle" }),
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: [], isLoading: false, isError: false }),
  useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/meta.functions", () => ({
  connectMetaSystemUserToken: vi.fn(),
  disconnectMetaConnection: vi.fn(),
  enqueueMetaSync: vi.fn(),
  getMetaSyncRunJobs: vi.fn(),
  getMetaSyncRuns: vi.fn(),
  renameMetaConnection: vi.fn(),
  updateMetaAccountSelection: vi.fn(),
  validateMetaConnection: vi.fn(),
}));

import { META_TEXTS, buildAccountRows } from "@/components/integrations/meta-connection-model";
import type { MetaSummary } from "@/components/integrations/meta-summary";
import { AccountSelection } from "./account-selection";
import { ReplaceCreatedNewNotice } from "./connect-key-sheet";
import {
  emptyAccountsHelp,
  firstReadFailedText,
  incrementalText,
  legacyBadge,
  replaceCreatedNewWarning,
  summaryError,
} from "./meta-copy";
import { MetaConnectionView, type MetaViewActions } from "./meta-connection-view";
import { NOW, account, backfill, connection, summary } from "./meta-test-fixtures";

const actions: MetaViewActions = {
  connect: vi.fn(),
  connectPending: false,
  saveSelection: vi.fn(),
  savePending: false,
  validate: vi.fn(),
  validatingConnectionId: null,
  rename: vi.fn(),
  renamePending: false,
  disconnect: vi.fn(),
  disconnectPending: false,
  sync: vi.fn(),
  syncPending: false,
};

function render(
  data: MetaSummary | undefined,
  opts: {
    readOnly?: boolean;
    isDemo?: boolean;
    initialFilter?: "all" | "selected" | "errors" | "new";
    loadError?: { retry: () => void; retrying: boolean } | null;
  } = {},
) {
  return renderToStaticMarkup(
    <MetaConnectionView
      summary={data}
      readOnly={opts.readOnly ?? false}
      isDemo={opts.isDemo ?? false}
      actions={actions}
      now={NOW}
      initialFilter={opts.initialFilter}
      loadError={opts.loadError}
    />,
  );
}

/** Os `<button role="checkbox">` das contas (não o da BM, que tem aria-label). */
function accountCheckboxes(html: string) {
  return html.match(/<button type="button" role="checkbox"(?![^>]*aria-label)[^>]*>/g) ?? [];
}

/** O `<li>` do passo marcado como atual. */
function currentStep(html: string) {
  return html.match(/<li aria-current="step"[^>]*>.*?<\/li>/)?.[0] ?? "";
}

function buttonWith(html: string, label: string) {
  return html.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}</button>`))?.[0] ?? "";
}

describe("MetaConnectionView", () => {
  it("shows the first-key form and the 'Conectar' step without a connection", () => {
    const html = render(summary());
    expect(html).toContain("Não conectada");
    expect(html).toContain("Conectar a primeira chave");
    expect(html).toContain("Validar acesso e buscar contas");
    expect(html).toContain("https://business.facebook.com/settings/system-users");
    expect(html).toContain("Tem mais de uma BM?");
    expect(currentStep(html)).toContain("Conectar");
    expect(html).not.toContain("meta-accounts-title");
  });

  it("lists the keys and the accounts with the 'Escolher contas' step when nothing is selected", () => {
    const html = render(summary({ connections: [connection()], accounts: [account()] }));
    expect(currentStep(html)).toContain("Escolher contas");
    expect(html).toContain("Chave “Mídia Interna”");
    expect(html).toContain("App Betleads Ads · chave EAAG••••a3f9");
    expect(html).toContain("Usuário do Sistema: Usuário Mídia");
    expect(html).toContain("Alcança 1 BM · 1 conta");
    expect(html).toContain("Não expira");
    expect(html).toContain("Adicionar Usuário do Sistema");
    expect(html).toContain("Testar acesso");
    expect(html).toContain("SA - Captação 01");
    expect(html).toContain("act_123");
    expect(html).toContain("America/Sao_Paulo");
    // Sem conta marcada, não há o que sincronizar.
    expect(buttonWith(html, "Sincronizar agora")).toContain('disabled=""');
    // Nada mudou ainda: sem a barra de alterações.
    expect(html).not.toContain("Salvar contas");
    // MB4-01: o histórico fica abaixo das contas.
    expect(html.indexOf("Histórico de sincronizações")).toBeGreaterThan(
      html.indexOf("meta-accounts-title"),
    );
    expect(html).toContain("Nenhuma sincronização ainda.");
  });

  it("shows the backfill percent on 'Primeira leitura' as a progressbar", () => {
    const html = render(
      summary({
        connections: [connection()],
        accounts: [account({ selected: true, sync_status: "syncing" })],
        latestBackfill: backfill({ processed_accounts: 2, total_accounts: 5 }),
      }),
    );
    const step = currentStep(html);
    expect(step).toContain("Primeira leitura");
    expect(step).toContain("40%");
    expect(step).toMatch(
      /role="progressbar"[^>]*aria-valuenow="40"|aria-valuenow="40"[^>]*role="progressbar"/,
    );
    expect(buttonWith(html, "Sincronizar agora")).not.toContain('disabled=""');
  });

  it("links 'Pronto' to Aquisição e LTV when the first read is over", () => {
    const html = render(
      summary({
        connections: [connection()],
        accounts: [
          account({
            selected: true,
            sync_status: "healthy",
            last_success_at: "2026-10-30T14:52:00.000Z",
          }),
        ],
        latestBackfill: backfill({ status: "completed", processed_accounts: 5 }),
      }),
    );
    expect(currentStep(html)).toContain("Pronto");
    expect(html).toContain('<a href="/midia-ltv"');
    expect(html).toContain("Ver Aquisição e LTV");
    expect(html).toContain("1 BM · 1 conta · atualizado há 8 min");
    expect(html).toContain("dados até 30/10, 11:52");
  });

  it("hides every mutating action in read-only mode and shows why", () => {
    const html = render(
      summary({ connections: [connection()], accounts: [account({ selected: true })] }),
      { readOnly: true },
    );
    expect(html).toContain(META_TEXTS.readOnly);
    expect(html).not.toContain("Adicionar Usuário do Sistema");
    expect(html).not.toContain("Sincronizar agora");
    expect(html).not.toContain("Testar acesso");
    expect(html).not.toContain("Mais ações da chave");
    expect(html).not.toContain("Validar acesso e buscar contas");
    // A lista continua visível, com os checkboxes desabilitados.
    expect(html).toContain("SA - Captação 01");
    expect(html).toMatch(/<button type="button" role="checkbox"[^>]*disabled=""/);
  });

  it("renders a mixed BM checkbox with role=group and the 'n de m marcadas' count", () => {
    const html = render(
      summary({
        connections: [connection()],
        accounts: [
          account({ id: "a1", name: "SA - Captação 01", selected: true }),
          account({ id: "a2", name: "SA - Retarget", meta_ad_account_id: "act_456" }),
        ],
      }),
    );
    expect(html).toContain('role="group" aria-label="BM Sorte Alta"');
    expect(html).toContain("(1 de 2 marcadas)");
    expect(html).toMatch(
      /aria-checked="mixed"[^>]*aria-label="Marcar todas as contas da BM Sorte Alta"|aria-label="Marcar todas as contas da BM Sorte Alta"[^>]*aria-checked="mixed"/,
    );
  });

  it("shows the USD warning, the 'nova' badge, 'via N chaves' and the reason as visible text", () => {
    const html = render(
      summary({
        connections: [
          connection(),
          connection({
            id: "conn-2",
            connection_label: "Agência X",
            status: "error",
            last_error: "A chave foi revogada na Meta.",
          }),
        ],
        accounts: [
          account({
            id: "usd",
            name: "SA - Retarget",
            currency: "USD",
            created_at: "2026-10-28T12:00:00.000Z",
            access_connection_ids: ["conn-1", "conn-2"],
          }),
          account({
            id: "blocked",
            name: "AX - Casa",
            business_id: "bm-2",
            business_name: "Agência X",
            connection_id: "conn-2",
            access_connection_ids: ["conn-2"],
          }),
        ],
      }),
    );
    expect(html).toContain(META_TEXTS.usdOutsideRoas);
    expect(html).toContain(">nova</div>");
    expect(html).toContain("via 2 chaves");
    expect(html).toContain(META_TEXTS.keyInError);
    expect(html).not.toContain(`title="${META_TEXTS.keyInError}"`);
    // A chave revogada aparece em texto claro, com "Trocar chave" no banner.
    expect(html).toContain("A chave foi revogada na Meta.");
    expect(html).toContain("A chave está com erro. Teste o acesso ou troque a chave.");
    expect(html).toContain("Trocar chave");
    expect(html).toContain("2 BMs · 1 chave com atenção");
  });

  it("keeps demo actions disabled behind the demo tooltip", () => {
    const html = render(
      summary({ connections: [connection()], accounts: [account({ selected: true })] }),
      { isDemo: true },
    );
    expect(buttonWith(html, "Adicionar Usuário do Sistema")).toContain('disabled=""');
    expect(buttonWith(html, "Testar acesso")).toContain('disabled=""');
  });
  it("shows the load error with 'Tentar novamente' instead of the first-key form", () => {
    const html = render(undefined, { loadError: { retry: vi.fn(), retrying: false } });
    expect(html).toContain(summaryError);
    expect(buttonWith(html, "Tentar novamente")).not.toContain('disabled=""');
    expect(html).not.toContain("Conectar a primeira chave");
    expect(html).not.toContain("Não conectada");
  });

  it("marks a legacy OAuth key with the legacy badge", () => {
    const html = render(
      summary({ connections: [connection({ auth_type: "legacy_oauth" })], accounts: [account()] }),
    );
    expect(html).toContain(`>${legacyBadge}</div>`);
    expect(render(summary({ connections: [connection()], accounts: [account()] }))).not.toContain(
      `>${legacyBadge}</div>`,
    );
  });

  it("warns on 'Pronto' when accounts failed in the first read", () => {
    const html = render(
      summary({
        connections: [connection()],
        accounts: [account({ selected: true, sync_status: "error" })],
        latestBackfill: backfill({ status: "partial", processed_accounts: 5, failed_accounts: 2 }),
      }),
    );
    const step = currentStep(html);
    expect(step).toContain("Pronto");
    expect(step).toContain(firstReadFailedText(2));
    expect(step).toContain("text-warning");
  });

  it("notes the incremental import on 'Pronto' when new accounts are being read", () => {
    const html = render(
      summary({
        connections: [connection()],
        accounts: [
          account({
            selected: true,
            sync_status: "healthy",
            last_success_at: "2026-10-30T14:52:00.000Z",
          }),
          account({ id: "a2", selected: true, meta_ad_account_id: "act_456" }),
        ],
        latestBackfill: backfill({ processed_accounts: 1, total_accounts: 4 }),
      }),
    );
    const step = currentStep(html);
    expect(step).toContain("Pronto");
    expect(step).toContain(incrementalText(25));
  });

  it("explains what to do when the key reaches no ad account", () => {
    const html = render(summary({ connections: [connection()], accounts: [] }));
    expect(html).toContain(emptyAccountsHelp);
  });

  it("says the BM checkbox and count refer to visible rows when filtered", () => {
    const html = render(
      summary({
        connections: [connection()],
        accounts: [
          account({ id: "a1", selected: true }),
          account({ id: "a2", name: "SA - Retarget", meta_ad_account_id: "act_456" }),
        ],
      }),
      { initialFilter: "selected" },
    );
    expect(html).toContain('aria-label="Marcar as contas visíveis da BM Sorte Alta"');
    expect(html).toContain("(1 de 1 visíveis marcadas)");
    expect(html).not.toContain("SA - Retarget");
  });

  it("disables the account checkboxes for the demo tenant", () => {
    const html = render(
      summary({
        connections: [connection()],
        accounts: [account({ id: "a1", selected: true }), account({ id: "a2" })],
      }),
      { isDemo: true },
    );
    const boxes = accountCheckboxes(html);
    expect(boxes).toHaveLength(2);
    for (const box of boxes) expect(box).toContain('disabled=""');
    expect(html).toMatch(
      /aria-label="Marcar todas as contas da BM Sorte Alta"[^>]*disabled=""|disabled=""[^>]*aria-label="Marcar todas as contas da BM Sorte Alta"/,
    );
  });

  it("offers 'Trocar chave' in the health strip only for key problems", () => {
    const html = render(
      summary({
        connections: [connection()],
        accounts: [account({ selected: true, sync_status: "error", last_error: "Falhou" })],
      }),
    );
    expect(html).toContain("1 conta com erro de sincronização.");
    // Só no menu "⋯" (fechado no markup estático), não no aviso.
    expect(html).not.toContain("Trocar chave");
  });
});

describe("AccountSelection", () => {
  it("keeps the unsaved-changes bar above the mobile tab bar", () => {
    const data = summary({ connections: [connection()], accounts: [account({ id: "a1" })] });
    const html = renderToStaticMarkup(
      <AccountSelection
        rows={buildAccountRows(data, NOW)}
        selection={{
          draft: new Set(["a1"]),
          persisted: new Set(),
          diff: { added: ["a1"], removed: [], dirty: true },
          setDraft: vi.fn(),
          discard: vi.fn(),
        }}
        readOnly={false}
        isDemo={false}
        savePending={false}
        onSave={vi.fn()}
        staleNotice={false}
      />,
    );
    expect(html).toContain("1 alteração não salva");
    const bar =
      html.match(/<div role="region" aria-label="Alterações não salvas"[^>]*>/)?.[0] ?? "";
    expect(bar).toContain("sticky");
    expect(bar).toContain("bottom-[calc(60px+env(safe-area-inset-bottom))]");
    expect(bar).toContain("md:bottom-0");
  });
});

describe("ReplaceCreatedNewNotice", () => {
  it("explains that the old key is still connected", () => {
    const html = renderToStaticMarkup(<ReplaceCreatedNewNotice />);
    expect(html).toContain('role="alert"');
    expect(html).toContain(replaceCreatedNewWarning);
  });
});
