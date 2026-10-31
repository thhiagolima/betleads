import {
  normalizeSearch,
  type ConnectionCard,
  type DisconnectImpact,
} from "@/components/integrations/meta-connection-model";
import { formatDate, plural } from "./meta-format";

// Textos montados da aba Meta Ads (fora dos .tsx para o fast refresh).

/** `add`: nova chave (soma uma BM); `replace`: troca a chave de uma conexão existente. */
export type ConnectKeyMode = { kind: "add" } | { kind: "replace"; connectionTitle: string };

export function connectKeyCopy(mode: ConnectKeyMode) {
  return mode.kind === "add"
    ? {
        title: "Adicionar Usuário do Sistema",
        description:
          "Conecte a chave de um Usuário do Sistema. As contas que ela alcança somam às que você já tem.",
      }
    : {
        title: `Trocar chave · ${mode.connectionTitle}`,
        description:
          "Cole a nova chave do mesmo Usuário do Sistema: ela substitui a chave desta conexão. As contas e a seleção continuam.",
      };
}

export function expiryLabel(expiry: ConnectionCard["expiry"]) {
  if (expiry.kind === "never") return "Não expira";
  if (expiry.kind === "unknown") return "Validade desconhecida";
  return `Expira em ${formatDate(expiry.date) ?? "data desconhecida"}`;
}

/** As frases do impacto (MB3-05), na ordem em que aparecem no diálogo. */
export function disconnectImpactLines(impact: DisconnectImpact): string[] {
  const lines = [
    `Esta chave alcança ${plural(impact.accountsReached, "conta", "contas")} em ${plural(
      impact.businesses,
      "BM",
      "BMs",
    )}.`,
  ];
  const keep = impact.keepVia.map(
    (item) =>
      `${item.count} ${item.count === 1 ? "continua" : "continuam"} pela chave “${item.connectionTitle}”`,
  );
  if (impact.stop > 0 || keep.length > 0) {
    const stop =
      impact.stop > 0
        ? `${impact.stop} ${impact.stop === 1 ? "vai parar" : "vão parar"} de sincronizar`
        : null;
    lines.push(`${[stop, ...keep].filter(Boolean).join("; ")}.`);
  } else {
    lines.push("Nenhuma conta marcada depende dela.");
  }
  lines.push("Os dados já importados ficam.");
  return lines;
}

function confirmationKey(value: string) {
  return normalizeSearch(value).replace(/\s+/g, " ");
}

/** O nome digitado vale sem diferença de acento, caixa ou espaços. */
export function canConfirmDisconnect(
  impact: DisconnectImpact,
  connectionTitle: string,
  confirmText: string,
) {
  if (!impact.requiresTypedConfirmation) return true;
  const expected = confirmationKey(connectionTitle);
  return expected !== "" && confirmationKey(confirmText) === expected;
}

export const replaceCreatedNewWarning =
  "Esta chave é de outro Usuário do Sistema ou de outro app: ela foi adicionada como uma nova conexão e a chave antiga continua conectada.";

export const emptyAccountsHelp =
  "Nenhuma conta de anúncio apareceu. No Business Manager, dê ao Usuário do Sistema acesso às contas de anúncio e depois clique em “Testar acesso”.";

export const summaryError = "Não foi possível carregar a conexão com a Meta.";

export const legacyBadge = "Conexão antiga";

export const unsavedLeaveConfirm =
  "Você tem alterações não salvas nas contas da Meta. Sair mesmo assim?";

/** Rótulo do checkbox da BM: com filtro/busca, só as contas visíveis. */
export function groupToggleVisibleLabel(name: string, filtered: boolean): string {
  return filtered
    ? `Marcar as contas visíveis da BM ${name}`
    : `Marcar todas as contas da BM ${name}`;
}

export function firstReadFailedText(n: number): string {
  return `Pronto · ${plural(n, "conta", "contas")} com erro na primeira leitura`;
}

export function incrementalText(percent: number): string {
  return `Importando contas novas (${percent}%)`;
}
