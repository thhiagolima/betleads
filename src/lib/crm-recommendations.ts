// Central de Resultados F5: rule-based recommendations from the period's
// results. Every recommendation states the number behind it; none is a guess.

import type { CrmResults, HoldoutComparison } from "./crm-results";

export type Recommendation = {
  severity: "acao" | "atencao" | "oportunidade";
  title: string;
  detail: string;
};

/** Below this spend a source is too small to judge. */
export const MIN_COST = 50;
/** Minimum recoveries before comparing efficiency. */
export const MIN_RECOVERED = 3;

const money = (value: number) =>
  value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const percent = (value: number) => `${Math.round(value * 100)}%`;
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const ORDER: Record<Recommendation["severity"], number> = { acao: 0, atencao: 1, oportunidade: 2 };

export function buildRecommendations(
  results: Pick<CrmResults, "sources">,
  holdout: Array<HoldoutComparison & { name: string }> = [],
): Recommendation[] {
  const items: Recommendation[] = [];
  const recovered = (source: { influencedPlayers: number; directConversions: number }) =>
    source.influencedPlayers + source.directConversions;

  for (const source of results.sources) {
    if (source.cost >= MIN_COST && recovered(source) === 0) {
      items.push({
        severity: "acao",
        title: `${source.name} gastou ${money(source.cost)} sem recuperar ninguém`,
        detail:
          source.type === "campaign"
            ? "Nenhum jogador parado voltou e ninguém depositou após clicar. Não use este formato para reativação; para relacionamento com ativos, reduza o volume."
            : "Revise os textos e a cadência, ou desligue a jornada até ajustar.",
      });
    } else if (source.type === "journey") {
      for (const step of source.steps) {
        if (step.position >= 0 && step.cost >= MIN_COST && recovered(step) === 0)
          items.push({
            severity: "atencao",
            title: `Etapa ${step.position + 1} de ${source.name} não recuperou ninguém`,
            detail: `Custou ${money(step.cost)} no período. Troque o texto ou remova a etapa; as demais etapas da jornada recuperaram jogadores.`,
          });
      }
    }
    if (source.cost >= MIN_COST && source.costOnActive / source.cost >= 0.5)
      items.push({
        severity: "atencao",
        title: `${percent(source.costOnActive / source.cost)} do custo de ${source.name} foi para jogadores ativos`,
        detail: `${money(source.costOnActive)} em mensagens para quem depositou há menos de 2 dias. Filtre a audiência para jogadores parados se o objetivo é recuperar.`,
      });
  }

  const comparable = results.sources.filter(
    (source) => source.influencedPlayers >= MIN_RECOVERED && source.costPerRecovered != null,
  );
  if (comparable.length >= 3) {
    const typical = median(comparable.map((source) => source.costPerRecovered as number));
    for (const source of comparable) {
      const cost = source.costPerRecovered as number;
      if (cost <= typical / 2)
        items.push({
          severity: "oportunidade",
          title: `${source.name} é a forma mais barata de recuperar jogadores`,
          detail: `${money(cost)} por jogador recuperado, contra ${money(typical)} na mediana das origens. Vale ampliar o alcance ou repetir o formato.`,
        });
      else if (cost >= typical * 3)
        items.push({
          severity: "atencao",
          title: `${source.name} recupera, mas caro`,
          detail: `${money(cost)} por jogador recuperado, ${Math.round(cost / typical)}x a mediana das origens (${money(typical)}).`,
        });
    }
  }

  for (const test of holdout) {
    if (!test.sufficient || test.lift == null) continue;
    if (test.significant && test.lift < 0)
      items.push({
        severity: "acao",
        title: `${test.name} está pior que não enviar`,
        detail: `Quem recebeu voltou ${percent(-test.lift)} menos que o grupo de controle. Pause a jornada e revise o conteúdo.`,
      });
    else if (test.significant)
      items.push({
        severity: "oportunidade",
        title: `${test.name} tem efeito comprovado`,
        detail: `Quem recebeu voltou ${percent(test.lift)} mais que o grupo de controle.`,
      });
    else
      items.push({
        severity: "atencao",
        title: `${test.name} ainda não mostrou efeito`,
        detail:
          "Com amostra suficiente, quem recebeu e quem não recebeu voltaram na mesma proporção. Teste outro texto ou cadência.",
      });
  }

  return items.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}
