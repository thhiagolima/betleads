import { describe, expect, it } from "vitest";

import { describePlayerJourneys, type PlayerEnrollment } from "./player-journeys";

const base: PlayerEnrollment = {
  id: "e1",
  journey_id: "j-dormindo",
  status: "waiting",
  current_position: 4,
  next_run_at: "2026-10-17T11:00:00.000Z",
  entered_at: "2026-10-14T10:00:00.000Z",
  exited_at: null,
  completed_at: null,
  exit_reason: null,
  is_holdout: false,
  priority_paused_by_journey_id: null,
  loop_iteration: 0,
};

const journeys = {
  "j-dormindo": { name: "Dormindo 7d", sendPositions: [0, 2, 4, 6, 8] },
  "j-pix": { name: "PIX não pago", sendPositions: [0, 2, 4] },
  "j-esfriando": { name: "Esfriando 2d", sendPositions: [0, 2, 4] },
};

describe("describePlayerJourneys", () => {
  const views = describePlayerJourneys(
    [
      {
        ...base,
        id: "old",
        journey_id: "j-esfriando",
        status: "exited",
        exit_reason: "inactivity_threshold",
        exited_at: "2026-10-14T09:59:00.000Z",
      },
      base,
      {
        ...base,
        id: "paused",
        journey_id: "j-esfriando",
        status: "paused_by_priority",
        priority_paused_by_journey_id: "j-pix",
        current_position: 0,
      },
    ],
    journeys,
  );

  it("lists open journeys first, then the most recent ended ones", () => {
    expect(views.map((view) => view.id)).toEqual(["e1", "paused", "old"]);
  });

  it("shows the step reached among the send steps and the next run", () => {
    expect(views[0]).toMatchObject({
      journeyName: "Dormindo 7d",
      stepLabel: "Etapa 3 de 5",
      statusLabel: "aguardando a próxima etapa",
      nextRunAt: "2026-10-17T11:00:00.000Z",
    });
  });

  it("names the journey that paused it", () => {
    expect(views[1]).toMatchObject({ pausedBy: "PIX não pago", stepLabel: "Etapa 1 de 3" });
  });

  it("explains why a journey ended", () => {
    expect(views[2]).toMatchObject({
      open: false,
      stepLabel: null,
      nextRunAt: null,
      exitLabel: "passou para a próxima faixa de inatividade",
    });
  });

  it("flags control-group players", () => {
    const [view] = describePlayerJourneys([{ ...base, is_holdout: true }], journeys);
    expect(view.holdout).toBe(true);
  });
});
