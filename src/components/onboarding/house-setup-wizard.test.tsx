import { describe, expect, it, vi } from "vitest";

import {
  applyWizardEffect,
  nextWizardStep,
  reduceWizard,
  WIZARD_STEPS,
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
