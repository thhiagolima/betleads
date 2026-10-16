// Central de Resultados F5: rule-based recommendations from the period's
// results. Every recommendation states the number behind it; none is a guess.
// The click conversion is the criterion (client, 16/10); recovered players
// only keep a source out of the "spends without converting" alert.

import { MIN_CONVERSIONS, type CrmResults, type HoldoutComparison } from "./crm-results";

export type Recommendation = {
  severity: "acao" | "atencao" | "oportunidade";
  title: string;
  detail: string;
};

/** Below this spend a source is too small to judge. */
export const MIN_COST = 50;
/** Below this many SMS a click rate is too noisy to compare. */
export const MIN_SENT_FOR_CLICK_RATE = 1000;

const money = (value: number) =>
  value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const percent = (value: number) => `${Math.round(value * 100)}%`;
const percentFine = (value: number) =>
  `${(value * 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;
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

  for (const source of results.sources) {
    if (source.cost >= MIN_COST && source.directPlayers === 0) {
      items.push(
        source.influencedPlayers === 0
          ? {
              severity: "acao",
              title: `${source.name} gastou ${money(source.cost)} sem nenhuma conversão`,
              detail:
                source.type === "campaign"
                  ? "Ninguém depositou após clicar e nenhum jogador parado voltou. Não repita este formato; para relacionamento com ativos, reduza o volume."
                  : "Ninguém depositou após clicar e nenhum jogador parado voltou. Revise os textos e a cadência, ou desligue a jornada até ajustar.",
            }
          : {
              severity: "atencao",
              title: `${source.name} não converteu ninguém pelo link`,
              detail: `${money(source.cost)} sem depósito após clique, embora ${source.influencedPlayers} jogador(es) parado(s) tenham voltado. Reforce a chamada para o link no texto.`,
            },
      );
    } else if (source.type === "journey") {
      for (const step of source.steps) {
        if (
          step.position >= 0 &&
          step.cost >= MIN_COST &&
          step.directPlayers === 0 &&
          step.influencedPlayers === 0
        )
          items.push({
            severity: "atencao",
            title: `Etapa ${step.position + 1} de ${source.name} não converteu ninguém`,
            detail: `Custou ${money(step.cost)} no período sem depósito após clique nem jogador recuperado. Troque o texto ou remova a etapa.`,
          });
      }
    }
    if (source.cost >= MIN_COST && source.costOnActive / source.cost >= 0.5)
      items.push({
        severity: "atencao",
        title: `${percent(source.costOnActive / source.cost)} do custo de ${source.name} foi para jogadores ativos`,
        detail: `${money(source.costOnActive)} em mensagens para quem depositou há menos de 2 dias. Filtre a audiência para jogadores parados se o objetivo é trazer de volta.`,
      });
  }

  const comparable = results.sources.filter(
    (source) => source.directPlayers >= MIN_CONVERSIONS && source.costPerConversion != null,
  );
  if (comparable.length >= 3) {
    const typical = median(comparable.map((source) => source.costPerConversion as number));
    for (const source of comparable) {
      const cost = source.costPerConversion as number;
      if (cost <= typical / 2)
        items.push({
          severity: "oportunidade",
          title: `${source.name} é a forma mais barata de converter`,
          detail: `${money(cost)} por jogador convertido pelo link, contra ${money(typical)} na mediana das origens. Vale ampliar o alcance ou repetir o formato.`,
        });
      else if (cost >= typical * 3)
        items.push({
          severity: "atencao",
          title: `${source.name} converte, mas caro`,
          detail: `${money(cost)} por jogador convertido, ${Math.round(cost / typical)}x a mediana das origens (${money(typical)}).`,
        });
    }
  }

  const clickable = results.sources.filter(
    (source) => source.sent >= MIN_SENT_FOR_CLICK_RATE && source.clickRate != null,
  );
  if (clickable.length >= 3) {
    const typical = median(clickable.map((source) => source.clickRate as number));
    for (const source of clickable) {
      if (typical > 0 && (source.clickRate as number) <= typical / 3)
        items.push({
          severity: "atencao",
          title: `Pouca gente clica no link de ${source.name}`,
          detail: `${percentFine(source.clickRate as number)} dos SMS clicados, contra ${percentFine(typical)} na mediana. Revise a primeira frase e a chamada para o link.`,
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
