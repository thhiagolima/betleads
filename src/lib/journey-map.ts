// P3: journeys grouped as the operator thinks about them, and conflicts a
// journey being edited would create with the tenant's other journeys.

import { inactivityUpperBoundHours } from "./journey-policy";

export type MapJourney = {
  id: string;
  name: string;
  status: string;
  trigger_type: string;
  trigger_config?: Record<string, unknown> | null;
  exit_rules?: Record<string, unknown> | null;
  conflict_family?: string | null;
  journey_priority?: number | null;
  express?: boolean | null;
  holdout_percent?: number | null;
  inProgress?: number;
};

export type MapLane = {
  key: "acquisition" | "inactivity" | "levels" | "events";
  title: string;
  description: string;
  items: Array<MapJourney & { detail: string | null }>;
};

const LEVEL_ORDER = ["bronze", "silver", "gold", "diamond", "black"];
const ACQUISITION = new Set(["cadastrados_sem_deposito", "lead_cadastrado", "pix_gerado_nao_pago"]);

function hoursLabel(hours: number) {
  return hours % 24 === 0 ? `${hours / 24} dia(s)` : `${hours} h`;
}

/** Inactivity band as text: "2 dia(s) a 7 dia(s)" or "30 dia(s) ou mais". */
export function bandLabel(journey: MapJourney) {
  const from = Number(journey.trigger_config?.hours);
  if (!Number.isFinite(from) || from <= 0) return null;
  const to = inactivityUpperBoundHours(journey.trigger_config, journey.exit_rules);
  return to
    ? `${hoursLabel(from)} a ${hoursLabel(to)} sem depositar`
    : `${hoursLabel(from)} ou mais`;
}

/** Journeys in four lanes, each lane in the order a player goes through it. */
export function buildJourneyMap(journeys: MapJourney[]): MapLane[] {
  const live = journeys.filter((journey) => journey.status !== "archived");
  const lanes: MapLane[] = [
    {
      key: "acquisition",
      title: "Aquisição",
      description: "Do cadastro ao 1º depósito.",
      items: [],
    },
    {
      key: "inactivity",
      title: "Faixas de inatividade",
      description: "Uma faixa por vez: o jogador passa para a próxima ou sai ao depositar.",
      items: [],
    },
    {
      key: "levels",
      title: "Níveis",
      description: "Um nível por vez: muda junto com o total depositado.",
      items: [],
    },
    {
      key: "events",
      title: "Eventos",
      description: "Mensagens ligadas a um fato do jogador.",
      items: [],
    },
  ];
  const lane = (key: MapLane["key"]) => lanes.find((item) => item.key === key)!;
  for (const journey of live) {
    if (journey.trigger_type === "inactivity")
      lane("inactivity").items.push({ ...journey, detail: bandLabel(journey) });
    else if (journey.trigger_type === "nivel_alterado")
      lane("levels").items.push({ ...journey, detail: null });
    else if (ACQUISITION.has(journey.trigger_type))
      lane("acquisition").items.push({ ...journey, detail: null });
    else
      lane("events").items.push({ ...journey, detail: journey.express ? "envio imediato" : null });
  }
  lane("inactivity").items.sort(
    (a, b) => Number(a.trigger_config?.hours ?? 0) - Number(b.trigger_config?.hours ?? 0),
  );
  lane("levels").items.sort(
    (a, b) =>
      LEVEL_ORDER.indexOf(String(a.trigger_config?.level)) -
      LEVEL_ORDER.indexOf(String(b.trigger_config?.level)),
  );
  return lanes.filter((item) => item.items.length > 0);
}

/**
 * Conflicts the edited journey would have with the tenant's active journeys:
 * overlapping inactivity bands (a player would be in two at once) and the same
 * trigger at the same priority (no defined winner).
 */
export function journeyConflicts(draft: MapJourney, others: MapJourney[]): string[] {
  const warnings: string[] = [];
  const active = others.filter((other) => other.id !== draft.id && other.status === "active");
  if (draft.trigger_type === "inactivity") {
    const field = String(draft.trigger_config?.field ?? "ultimo_login");
    const from = Number(draft.trigger_config?.hours);
    const to = inactivityUpperBoundHours(draft.trigger_config, draft.exit_rules) ?? Infinity;
    if (Number.isFinite(from)) {
      for (const other of active) {
        if (other.trigger_type !== "inactivity") continue;
        if (String(other.trigger_config?.field ?? "ultimo_login") !== field) continue;
        const otherFrom = Number(other.trigger_config?.hours);
        const otherTo =
          inactivityUpperBoundHours(other.trigger_config, other.exit_rules) ?? Infinity;
        if (Number.isFinite(otherFrom) && from < otherTo && otherFrom < to)
          warnings.push(
            `A faixa desta jornada se sobrepõe a "${other.name}" (${bandLabel(other) ?? "sem faixa"}): o mesmo jogador estaria nas duas. Defina a saída por tempo para encerrar onde a outra começa.`,
          );
      }
    }
  }
  if (!draft.express) {
    for (const other of active) {
      if (other.express || other.trigger_type !== draft.trigger_type) continue;
      if (draft.trigger_type === "nivel_alterado") {
        if (String(other.trigger_config?.level) !== String(draft.trigger_config?.level)) continue;
        warnings.push(`Já existe uma jornada ativa para este nível: "${other.name}".`);
        continue;
      }
      if (draft.trigger_type === "inactivity") continue;
      if ((other.journey_priority ?? 4) === (draft.journey_priority ?? 4))
        warnings.push(
          `"${other.name}" usa o mesmo gatilho com a mesma prioridade: quando as duas tiverem mensagem no mesmo momento, não há uma vencedora definida.`,
        );
    }
  }
  return warnings;
}
