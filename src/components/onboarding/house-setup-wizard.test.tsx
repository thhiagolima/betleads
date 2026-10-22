import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { SetupChecklist } from "./house-setup-checklist";
import {
  applyWizardEffect,
  nextWizardStep,
  reduceWizard,
  runWizardPrimary,
  shouldSaveBeforeAdvance,
  WIZARD_STEPS,
  WizardReadyStepView,
  wizardStepButtons,
} from "./house-setup-wizard";

describe("WIZARD_STEPS", () => {
  it("is Casa → Encurtador → E-mail → Pronto, in that order", () => {
    expect(WIZARD_STEPS.map((s) => s.id)).toEqual(["casa", "encurtador", "email", "pronto"]);
  });
});

describe("nextWizardStep", () => {
  it("walks forward one step at a time", () => {
    expect(nextWizardStep("casa")).toBe("encurtador");
    expect(nextWizardStep("encurtador")).toBe("email");
    expect(nextWizardStep("email")).toBe("pronto");
  });

  it("stays on 'pronto' once there — it's the last step", () => {
    expect(nextWizardStep("pronto")).toBe("pronto");
  });
});

describe("wizardStepButtons", () => {
  it("shows 'Pular configuração' on every step", () => {
    for (const step of WIZARD_STEPS) {
      expect(wizardStepButtons(step.id).skip).toBe(true);
    }
  });

  it("the primary action is 'Avançar' on every step but the last, 'Concluir' on 'pronto'", () => {
    expect(wizardStepButtons("casa").primary).toBe("avancar");
    expect(wizardStepButtons("encurtador").primary).toBe("avancar");
    expect(wizardStepButtons("email").primary).toBe("avancar");
    expect(wizardStepButtons("pronto").primary).toBe("concluir");
  });

  it("'Fazer depois' is offered on every step except the last", () => {
    expect(wizardStepButtons("casa").later).toBe(true);
    expect(wizardStepButtons("encurtador").later).toBe(true);
    expect(wizardStepButtons("email").later).toBe(true);
    expect(wizardStepButtons("pronto").later).toBe(false);
  });
});

describe("WizardReadyStepView", () => {
  it("summarizes the checklist — progress and every item's label", () => {
    const checklist: SetupChecklist = {
      items: [
        { id: "house", state: "done" },
        { id: "shortener", state: "pending_dns" },
        { id: "email", state: "todo" },
      ],
      complete: false,
    };

    const html = renderToStaticMarkup(<WizardReadyStepView checklist={checklist} />);

    expect(html).toContain("1 de 3");
    expect(html).toContain("URL da casa e URLs rápidas");
    expect(html).toContain("Domínio do encurtador · aguardando DNS");
    expect(html).toContain("Domínio e remetente de e-mail");
  });

  it("renders no summary while the checklist hasn't loaded yet", () => {
    const html = renderToStaticMarkup(<WizardReadyStepView checklist={undefined} />);

    expect(html).not.toContain("de 3");
  });
});

describe("reduceWizard + applyWizardEffect", () => {
  it("'Fazer depois' advances to the next step without calling onComplete or onSkip", () => {
    const onAdvance = vi.fn();
    const onSkip = vi.fn();
    const onComplete = vi.fn();

    applyWizardEffect(reduceWizard("casa", { type: "later" }), { onAdvance, onSkip, onComplete });

    expect(onAdvance).toHaveBeenCalledWith("encurtador");
    expect(onSkip).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("'Concluir' on the last step calls onComplete (wired to completeOnboarding) and nothing else", () => {
    const onAdvance = vi.fn();
    const onSkip = vi.fn();
    const onComplete = vi.fn();

    applyWizardEffect(reduceWizard("pronto", { type: "complete" }), {
      onAdvance,
      onSkip,
      onComplete,
    });

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onAdvance).not.toHaveBeenCalled();
    expect(onSkip).not.toHaveBeenCalled();
  });

  it("'Pular configuração' calls onSkip (wired to skipOnboarding) regardless of the current step", () => {
    const onAdvance = vi.fn();
    const onSkip = vi.fn();
    const onComplete = vi.fn();

    applyWizardEffect(reduceWizard("email", { type: "skip" }), { onAdvance, onSkip, onComplete });

    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onAdvance).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });
});

describe("Avançar on the Casa step saves first (ruling R10)", () => {
  it("only the Casa step's Avançar requires a save", () => {
    expect(shouldSaveBeforeAdvance("casa", "later")).toBe(true);
    expect(shouldSaveBeforeAdvance("encurtador", "later")).toBe(false);
    expect(shouldSaveBeforeAdvance("email", "later")).toBe(false);
    expect(shouldSaveBeforeAdvance("casa", "skip")).toBe(false);
    expect(shouldSaveBeforeAdvance("pronto", "complete")).toBe(false);
  });

  it("saves, then advances when the save succeeds", async () => {
    const calls: string[] = [];
    const save = vi.fn(async () => {
      calls.push("save");
      return true;
    });
    const apply = vi.fn(() => {
      calls.push("apply");
    });

    const ok = await runWizardPrimary("casa", { type: "later" }, { save, apply });
    expect(ok).toBe(true);
    expect(calls).toEqual(["save", "apply"]);
    expect(apply).toHaveBeenCalledWith({ kind: "advance", step: "encurtador" });
  });

  it("stays on the step when the save fails", async () => {
    const save = vi.fn(async () => false);
    const apply = vi.fn();

    const ok = await runWizardPrimary("casa", { type: "later" }, { save, apply });
    expect(ok).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it("other steps advance without calling save", async () => {
    const save = vi.fn(async () => true);
    const apply = vi.fn();

    await runWizardPrimary("encurtador", { type: "later" }, { save, apply });
    await runWizardPrimary("pronto", { type: "complete" }, { save, apply });
    expect(save).not.toHaveBeenCalled();
    expect(apply).toHaveBeenNthCalledWith(1, { kind: "advance", step: "email" });
    expect(apply).toHaveBeenNthCalledWith(2, { kind: "complete" });
  });
});
