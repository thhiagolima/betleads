// One name per number (Financeiro redesign, task 5): every number shown
// anywhere in the painel maps to exactly one label and one "como
// calculamos" explanation, both defined once here instead of being retyped
// (and drifting) per component. `how` is shown by TermTooltip
// (./term-tooltip.tsx) on hover and tap.
import { GGR_COLUMN_LABEL } from "@/components/finance/format";

export type TermKey =
  | "cashResult"
  | "net"
  | "ggr"
  | "ggrFee"
  | "movementFee"
  | "sends"
  | "fee"
  | "otherCosts"
  | "roi"
  | "margin";

export const FINANCE_TERMS: Record<TermKey, { label: string; how: string }> = {
  cashResult: {
    label: "Lucro líquido",
    how: "Net menos taxa de GGR, taxa de movimentação, anúncios, envios, mensalidade (só no mês fechado) e outros custos.",
  },
  net: {
    label: "Net (depósitos − saques)",
    how: "Soma dos depósitos aprovados menos a soma dos saques aprovados.",
  },
  ggr: {
    // Reuses GGR_COLUMN_LABEL (format.ts) so the grid, the scoreboard and
    // this term never drift apart.
    label: GGR_COLUMN_LABEL,
    how: "Valor lançado a partir do painel de GGR da plataforma; quando o mês usa o total acumulado, cada dia recebe uma estimativa proporcional ao net.",
  },
  ggrFee: {
    label: "Taxa de GGR",
    how: "GGR × a taxa da casa.",
  },
  movementFee: {
    label: "Taxa de movimentação",
    how: "A taxa da casa aplicada três vezes: sobre os depósitos, sobre os saques e sobre o net.",
  },
  sends: {
    label: "Envios",
    how: "Custo de SMS, voz e e-mail do período. Em casa isenta é o custo do provedor.",
  },
  fee: {
    label: "Mensalidade",
    how: "Valor do plano do mês; entra só no mês fechado.",
  },
  otherCosts: {
    label: "Outros custos",
    how: "Custos lançados com data; entram em qualquer período que contenha a data.",
  },
  roi: {
    label: "Retorno (ROI)",
    how: "Lucro líquido ÷ anúncios.",
  },
  margin: {
    label: "Margem",
    how: "Lucro líquido ÷ net.",
  },
};
