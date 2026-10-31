import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/meta.functions", () => ({
  connectMetaSystemUserToken: vi.fn(),
  disconnectMetaConnection: vi.fn(),
  enqueueMetaSync: vi.fn(),
  renameMetaConnection: vi.fn(),
  updateMetaAccountSelection: vi.fn(),
  validateMetaConnection: vi.fn(),
}));

import { disconnectImpact } from "@/components/integrations/meta-connection-model";
import { ConnectKeyForm } from "./connect-key-sheet";
import { DisconnectImpactBody } from "./disconnect-dialog";
import {
  canConfirmDisconnect,
  connectKeyCopy,
  disconnectImpactLines,
  expiryLabel,
} from "./meta-copy";
import { account, connection, summary } from "./meta-test-fixtures";
import { connectResultMessage, isStaleSelectionError } from "./use-meta-actions";

// Duas chaves: "Mídia Interna" (conn-1) e "Agência X" (conn-2). A conn-1 alcança 6
// contas em 2 BMs; 4 marcadas só por ela, 2 marcadas também pela conn-2.
function sharedSummary() {
  const accounts = [
    ...[1, 2, 3, 4].map((n) =>
      account({ id: `only-${n}`, selected: true, business_id: n <= 2 ? "bm-1" : "bm-2" }),
    ),
    ...[1, 2].map((n) =>
      account({ id: `shared-${n}`, selected: true, access_connection_ids: ["conn-1", "conn-2"] }),
    ),
  ];
  return summary({
    connections: [connection(), connection({ id: "conn-2", connection_label: "Agência X" })],
    accounts,
  });
}

describe("disconnect impact", () => {
  it("describes the shared case: some stop, some continue through the other key", () => {
    const impact = disconnectImpact(sharedSummary(), "conn-1");
    expect(disconnectImpactLines(impact)).toEqual([
      "Esta chave alcança 6 contas em 2 BMs.",
      "4 vão parar de sincronizar; 2 continuam pela chave “Agência X”.",
      "Os dados já importados ficam.",
    ]);
  });

  it("describes the exclusive case and asks for the key name", () => {
    const data = summary({
      connections: [connection()],
      accounts: [account({ selected: true })],
    });
    const impact = disconnectImpact(data, "conn-1");
    expect(disconnectImpactLines(impact)).toEqual([
      "Esta chave alcança 1 conta em 1 BM.",
      "1 vai parar de sincronizar.",
      "Os dados já importados ficam.",
    ]);
    const html = renderToStaticMarkup(
      <DisconnectImpactBody
        impact={impact}
        connectionTitle="Mídia Interna"
        confirmText=""
        onConfirmTextChange={() => {}}
      />,
    );
    expect(html).toContain(
      "Para confirmar, digite o nome da chave: <strong>Mídia Interna</strong>",
    );
    expect(html).toContain('id="meta-disconnect-confirm"');
    expect(canConfirmDisconnect(impact, "Mídia Interna", "")).toBe(false);
    expect(canConfirmDisconnect(impact, "Mídia Interna", " Mídia Interna ")).toBe(true);
  });

  it("needs no typed confirmation when every selected account keeps a key", () => {
    const data = summary({
      connections: [connection(), connection({ id: "conn-2", connection_label: "Agência X" })],
      accounts: [account({ selected: true, access_connection_ids: ["conn-1", "conn-2"] })],
    });
    const impact = disconnectImpact(data, "conn-1");
    expect(disconnectImpactLines(impact)[1]).toBe("1 continua pela chave “Agência X”.");
    const html = renderToStaticMarkup(
      <DisconnectImpactBody
        impact={impact}
        connectionTitle="Mídia Interna"
        confirmText=""
        onConfirmTextChange={() => {}}
      />,
    );
    expect(html).not.toContain("meta-disconnect-confirm");
    expect(canConfirmDisconnect(impact, "Mídia Interna", "")).toBe(true);
  });

  it("says nothing depends on a key without selected accounts", () => {
    const data = summary({ connections: [connection()], accounts: [account()] });
    expect(disconnectImpactLines(disconnectImpact(data, "conn-1"))[1]).toBe(
      "Nenhuma conta marcada depende dela.",
    );
  });
});

describe("texts", () => {
  it("announces the connection result with BMs and new accounts", () => {
    expect(
      connectResultMessage({
        created: true,
        businesses: 2,
        accountsTotal: 5,
        accountsNew: 3,
        userName: "Agência X",
        app: { name: "AgX" },
      }),
    ).toBe(
      "Chave “Agência X” conectada: 2 BMs, 5 contas (3 novas). Marque as que deseja acompanhar e salve.",
    );
  });

  it("recognises the stale-selection RPC error", () => {
    expect(
      isStaleSelectionError(new Error("Uma das contas selecionadas não pertence à sua operação.")),
    ).toBe(true);
    expect(isStaleSelectionError(new Error("outro"))).toBe(false);
  });

  it("labels the key validity", () => {
    expect(expiryLabel({ kind: "never", date: null, soon: false })).toBe("Não expira");
    expect(expiryLabel({ kind: "unknown", date: null, soon: false })).toBe("Validade desconhecida");
    expect(expiryLabel({ kind: "date", date: "2026-11-03T12:00:00.000Z", soon: true })).toBe(
      "Expira em 03/11/2026",
    );
  });

  it("uses the replace copy for 'Trocar chave'", () => {
    expect(connectKeyCopy({ kind: "replace", connectionTitle: "Agência X" }).description).toContain(
      "substitui a chave desta conexão",
    );
    expect(connectKeyCopy({ kind: "add" }).title).toBe("Adicionar Usuário do Sistema");
  });

  it("keeps the connect button disabled until a token is typed", () => {
    const html = renderToStaticMarkup(
      <ConnectKeyForm locked={false} isDemo={false} pending={false} onConnect={vi.fn()} />,
    );
    expect(html).toMatch(/<button[^>]*type="submit" disabled=""/);
    expect(html).toContain("A chave de um usuário comum expira");
  });
});
