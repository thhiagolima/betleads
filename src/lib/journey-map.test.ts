import { describe, expect, it } from "vitest";

import { bandLabel, buildJourneyMap, journeyConflicts, type MapJourney } from "./journey-map";

const journey = (overrides: Partial<MapJourney>): MapJourney => ({
  id: "x",
  name: "x",
  status: "active",
  trigger_type: "inactivity",
  ...overrides,
});

const cooling = journey({
  id: "esfriando",
  name: "Esfriando",
  trigger_config: { field: "ultimo_deposito", hours: 48 },
  exit_rules: { inactivity_over_hours: 168 },
});
const sleeping = journey({
  id: "dormindo",
  name: "Dormindo",
  trigger_config: { field: "ultimo_deposito", hours: 168 },
  exit_rules: { inactivity_over_hours: 720 },
});
const lost = journey({
  id: "perdido",
  name: "30 dias",
  trigger_config: { field: "ultimo_deposito", hours: 720 },
});

describe("buildJourneyMap", () => {
  const lanes = buildJourneyMap([
    lost,
    journey({
      id: "ouro",
      name: "Ouro",
      trigger_type: "nivel_alterado",
      trigger_config: { level: "gold" },
    }),
    cooling,
    journey({
      id: "bronze",
      name: "Bronze",
      trigger_type: "nivel_alterado",
      trigger_config: { level: "bronze" },
    }),
    sleeping,
    journey({ id: "pix", name: "PIX", trigger_type: "pix_gerado_nao_pago" }),
    journey({ id: "saque", name: "Saque", trigger_type: "saque_pago", express: true }),
    journey({
      id: "old",
      name: "Arquivada",
      trigger_type: "primeiro_deposito",
      status: "archived",
    }),
  ]);

  it("groups journeys in lanes, in the order a player goes through them", () => {
    expect(lanes.map((lane) => lane.key)).toEqual([
      "acquisition",
      "inactivity",
      "levels",
      "events",
    ]);
    expect(lanes[1].items.map((item) => item.name)).toEqual(["Esfriando", "Dormindo", "30 dias"]);
    expect(lanes[2].items.map((item) => item.name)).toEqual(["Bronze", "Ouro"]);
  });

  it("describes each inactivity band and leaves archived journeys out", () => {
    expect(lanes[1].items.map((item) => item.detail)).toEqual([
      "2 dia(s) a 7 dia(s) sem depositar",
      "7 dia(s) a 30 dia(s) sem depositar",
      "30 dia(s) ou mais",
    ]);
    expect(lanes.flatMap((lane) => lane.items).some((item) => item.id === "old")).toBe(false);
    expect(lanes[3].items[0].detail).toBe("envio imediato");
  });

  it("labels a band without end", () => {
    expect(bandLabel(lost)).toBe("30 dia(s) ou mais");
    expect(
      bandLabel({
        ...lost,
        trigger_config: { field: "ultimo_login", hours: 48, hours_max: 168 },
      } as MapJourney),
    ).toMatch(/sem login$/);
  });
});

describe("journeyConflicts", () => {
  it("finds no conflict between exclusive bands", () => {
    expect(journeyConflicts(cooling, [sleeping, lost])).toEqual([]);
  });

  it("warns when a band overlaps another", () => {
    const wide = journey({ id: "novo", trigger_config: { field: "ultimo_deposito", hours: 72 } });
    const warnings = journeyConflicts(wide, [cooling, sleeping, lost]);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain("Esfriando");
  });

  it("warns about a second journey for the same level", () => {
    const gold = journey({
      id: "a",
      name: "Ouro",
      trigger_type: "nivel_alterado",
      trigger_config: { level: "gold" },
    });
    const draft = journey({
      id: "b",
      trigger_type: "nivel_alterado",
      trigger_config: { level: "gold" },
    });
    expect(journeyConflicts(draft, [gold])).toEqual([
      'Já existe uma jornada ativa para este nível: "Ouro".',
    ]);
  });

  it("warns about the same trigger at the same priority, but not for express journeys", () => {
    const pix = journey({
      id: "a",
      name: "PIX",
      trigger_type: "pix_gerado_nao_pago",
      journey_priority: 1,
    });
    const draft = journey({ id: "b", trigger_type: "pix_gerado_nao_pago", journey_priority: 1 });
    expect(journeyConflicts(draft, [pix])).toHaveLength(1);
    expect(journeyConflicts({ ...draft, journey_priority: 2 }, [pix])).toEqual([]);
    expect(journeyConflicts({ ...draft, express: true }, [pix])).toEqual([]);
  });
});
