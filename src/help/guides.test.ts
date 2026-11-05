import { describe, expect, it } from "vitest";
import { computeGuideView, EMPTY_SIGNALS, GUIDES, type GuideSignals } from "./guides";

const none = Object.fromEntries(Object.keys(EMPTY_SIGNALS).map((k) => [k, false])) as GuideSignals;

describe("computeGuideView", () => {
  const email = GUIDES.find((g) => g.id === "primeiro-email")!;

  it("nothing done", () => {
    expect(computeGuideView(email, none).doneCount).toBe(0);
  });

  it("a later signal marks the earlier steps done too", () => {
    expect(computeGuideView(email, { ...none, verifiedSender: true }).stepDone).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  it("the last step done marks the whole guide done", () => {
    expect(computeGuideView(email, { ...none, emailCampaignSent: true }).doneCount).toBe(5);
  });

  it("total matches the step count", () => {
    expect(computeGuideView(email, none).total).toBe(email.steps.length);
  });

  it("EMPTY_SIGNALS has every GuideSignals key false", () => {
    expect(EMPTY_SIGNALS).toEqual(none);
  });
});

describe("GUIDES", () => {
  it("has the three guides with requiresRole admin where expected", () => {
    const byId = Object.fromEntries(GUIDES.map((g) => [g.id, g]));
    expect(Object.keys(byId).sort()).toEqual(["encurtador", "primeiro-email", "primeira-jornada"].sort());
    expect(byId.encurtador.requiresRole).toBe("admin");
    expect(byId["primeiro-email"].requiresRole).toBe("admin");
    expect(byId["primeira-jornada"].requiresRole).toBeUndefined();
  });

  it("encurtador has the three shortener steps in order", () => {
    const encurtador = GUIDES.find((g) => g.id === "encurtador")!;
    expect(encurtador.steps.map((s) => s.signal)).toEqual([
      "shortenerAdded",
      "shortenerVerified",
      "shortenerDefault",
    ]);
  });

  it("primeiro-email's verification step has the DNS substeps", () => {
    const email = GUIDES.find((g) => g.id === "primeiro-email")!;
    const verifyStep = email.steps.find((s) => s.signal === "emailDomainVerified")!;
    expect(verifyStep.substeps).toEqual([
      "Copiar os registros DNS",
      "Colar no site onde o domínio foi comprado",
      "Aguardar a verificação automática",
    ]);
    const campaignStep = email.steps.find((s) => s.signal === "emailCampaignSent")!;
    expect(campaignStep.substeps).toEqual(["Mandar um envio de teste antes"]);
  });

  it("primeira-jornada has the saved/active/entries steps with the right substeps", () => {
    const jornada = GUIDES.find((g) => g.id === "primeira-jornada")!;
    expect(jornada.steps.map((s) => s.signal)).toEqual([
      "journeySaved",
      "journeyActive",
      "journeyHasEntries",
    ]);
    expect(jornada.steps[0].substeps).toEqual(["gatilho", "público e reentrada", "etapas", "saída", "limites"]);
    expect(jornada.steps[2].substeps).toEqual(["Acompanhar no relatório"]);
  });

  it("every step has a non-empty title and route", () => {
    for (const guide of GUIDES) {
      for (const step of guide.steps) {
        expect(step.title.length).toBeGreaterThan(0);
        expect(step.route.length).toBeGreaterThan(0);
      }
    }
  });
});
