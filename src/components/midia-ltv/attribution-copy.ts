import type { OrphanReason, OrphanReasonRow } from "@/lib/marketing-overview";

// Textos dos motivos de "cadastro sem anúncio" (F1-03/F1-04) e da nota de gasto sem
// cadastro ligado (F1-05). Fora do .tsx para o fast refresh e para os testes.

export const ORPHAN_REASON_COPY: Record<OrphanReason, { label: string; action: string }> = {
  live: {
    label: "vieram de link de live",
    action:
      "O link da live não diz qual campanha pagou por ela. Para o gasto contar, coloque o ID da campanha que impulsiona a live em utm_campaign.",
  },
  other_source: {
    label: "vieram de outra origem (Kwai, Google, afiliado…)",
    action: "Não são da Meta, então não têm gasto nesta tela.",
  },
  id_not_found: {
    label: "trazem o ID de um anúncio fora das contas marcadas",
    action: "Conecte ou marque a conta dona desse anúncio em Contas da Meta.",
  },
  macro: {
    label: "chegaram com {{…}} sem preencher",
    action:
      "Os parâmetros foram colados direto no link. Use o campo Parâmetros de URL do anúncio, que a Meta preenche sozinha.",
  },
  source_only: {
    label: "chegaram só com a origem, sem campanha nem anúncio",
    action: "Peça à casa para repassar utm_campaign e utm_content no cadastro.",
  },
  ambiguous: {
    label: "usam um nome repetido em mais de um anúncio",
    action: "Use o ID do anúncio em utm_content em vez do nome.",
  },
  name_not_found: {
    label: "usam um nome que não existe nas contas marcadas",
    action:
      "O nome da campanha ou do anúncio no link não bate com nenhum anúncio. Use IDs em vez de nomes.",
  },
  pending: {
    label: "ainda não foram conferidos",
    action: "São comparados com os anúncios na próxima sincronização.",
  },
};

/** Rótulo curto para a coluna "Motivo" do diagnóstico. */
export const ORPHAN_REASON_SHORT: Record<OrphanReason, string> = {
  live: "Live",
  other_source: "Outra origem",
  id_not_found: "Conta não conectada",
  macro: "{{…}} sem preencher",
  source_only: "Só a origem",
  ambiguous: "Nome repetido",
  name_not_found: "Nome não encontrado",
  pending: "Aguardando",
};

export function orphanReasonLabel(reason: string | null | undefined) {
  return reason && reason in ORPHAN_REASON_SHORT
    ? ORPHAN_REASON_SHORT[reason as OrphanReason]
    : "Sem anúncio";
}

/** Totais do aviso, somando todos os motivos (não só as 50 linhas do diagnóstico). */
export function orphanTotals(reasons: OrphanReasonRow[]) {
  return reasons.reduce(
    (acc, row) => ({
      players: acc.players + row.players,
      ftd: acc.ftd + row.ftd,
      revenue: acc.revenue + row.revenue,
    }),
    { players: 0, ftd: 0, revenue: 0 },
  );
}

/** Motivos em ordem de cadastros, sem os zerados. */
export function sortedReasons(reasons: OrphanReasonRow[]) {
  return reasons
    .filter((row) => row.players > 0)
    .sort((a, b) => b.players - a.players || b.revenue - a.revenue);
}

/** Parte do investido que foi para campanhas sem cadastro ligado (0–100), ou null. */
export function unlinkedShare(spendUnlinked: number, spend: number) {
  if (spend <= 0 || spendUnlinked <= 0) return null;
  return Math.min(100, Math.round((spendUnlinked / spend) * 100));
}

export function cadastros(count: number) {
  return count === 1 ? "1 cadastro" : `${new Intl.NumberFormat("pt-BR").format(count)} cadastros`;
}
