// Full-screen first-access wizard: Casa → Encurtador → E-mail → Pronto. Each
// step reuses a Task 10 section with `variant="wizard"` (no card chrome).
// "Pular configuração" is always visible and calls `skipOnboarding`; "Fazer
// depois" just advances to the next step (no save call of its own — whatever
// the step's inputs already saved stays saved, nothing extra happens); the
// last step's "Concluir" calls `completeOnboarding`. The step-transition
// logic is pure (`reduceWizard`/`applyWizardEffect`) so it's testable without
// a DOM — the component below only wires it to the two mutations.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { HouseSiteSection } from "@/components/house-config/house-site-section";
import { DomainsSection } from "@/components/house-config/domains-section";
import { EmailSendersSection } from "@/components/house-config/email-senders-section";
import { HOUSE_SETUP_STATUS_QUERY_KEY } from "@/components/house-config/house-config-query";
import { completeOnboarding, skipOnboarding } from "@/lib/house-config.functions";

export type WizardStepId = "casa" | "encurtador" | "email" | "pronto";

export const WIZARD_STEPS: { id: WizardStepId; label: string }[] = [
  { id: "casa", label: "Casa" },
  { id: "encurtador", label: "Encurtador" },
  { id: "email", label: "E-mail" },
  { id: "pronto", label: "Pronto" },
];

/** One step forward; clamped — `pronto` is the last step. */
export function nextWizardStep(current: WizardStepId): WizardStepId {
  const idx = WIZARD_STEPS.findIndex((s) => s.id === current);
  const next = WIZARD_STEPS[Math.min(idx + 1, WIZARD_STEPS.length - 1)];
  return next.id;
}

/** Which buttons a step offers. "Pular configuração" is on every step;
 * "Fazer depois" on every step but the last (nothing left to defer once
 * you're on the summary); the primary action is "Avançar" until the last
 * step, where it becomes "Concluir". */
export function wizardStepButtons(step: WizardStepId): {
  skip: boolean;
  later: boolean;
  primary: "avancar" | "concluir";
} {
  const isLast = step === "pronto";
  return { skip: true, later: !isLast, primary: isLast ? "concluir" : "avancar" };
}

export type WizardAction = { type: "later" } | { type: "skip" } | { type: "complete" };
export type WizardEffect =
  | { kind: "advance"; step: WizardStepId }
  | { kind: "skip" }
  | { kind: "complete" };

/** Pure state transition for one wizard action — no I/O, no React. */
export function reduceWizard(current: WizardStepId, action: WizardAction): WizardEffect {
  if (action.type === "skip") return { kind: "skip" };
  if (action.type === "complete") return { kind: "complete" };
  return { kind: "advance", step: nextWizardStep(current) };
}

/** Wires a `WizardEffect` to its handler — the only place that touches the
 * outside world (step state, `skipOnboarding`, `completeOnboarding`). */
export function applyWizardEffect(
  effect: WizardEffect,
  handlers: {
    onAdvance: (step: WizardStepId) => void;
    onSkip: () => void;
    onComplete: () => void;
  },
): void {
  if (effect.kind === "advance") handlers.onAdvance(effect.step);
  else if (effect.kind === "skip") handlers.onSkip();
  else handlers.onComplete();
}

function WizardStepContent({ step }: { step: WizardStepId }) {
  if (step === "casa") return <HouseSiteSection variant="wizard" />;
  if (step === "encurtador") return <DomainsSection kind="shortener" variant="wizard" />;
  if (step === "email") {
    return (
      <div className="space-y-6">
        <DomainsSection kind="email" variant="wizard" />
        <EmailSendersSection variant="wizard" />
      </div>
    );
  }
  return (
    <p className="text-sm text-muted-foreground">
      Tudo pronto. Você pode ajustar qualquer coisa depois em Configurações → Casa.
    </p>
  );
}

export function HouseSetupWizard({ initialStep = "casa" }: { initialStep?: WizardStepId }) {
  const qc = useQueryClient();
  const [step, setStep] = useState<WizardStepId>(initialStep);

  const skipFn = useServerFn(skipOnboarding);
  const completeFn = useServerFn(completeOnboarding);

  const releaseGate = () => qc.invalidateQueries({ queryKey: HOUSE_SETUP_STATUS_QUERY_KEY });

  const skip = useMutation({
    mutationFn: () => skipFn(),
    onSuccess: releaseGate,
    onError: (error: Error) => toast.error(error.message),
  });

  const complete = useMutation({
    mutationFn: () => completeFn(),
    onSuccess: releaseGate,
    onError: (error: Error) => toast.error(error.message),
  });

  function dispatch(action: WizardAction) {
    applyWizardEffect(reduceWizard(step, action), {
      onAdvance: setStep,
      onSkip: () => skip.mutate(),
      onComplete: () => complete.mutate(),
    });
  }

  const buttons = wizardStepButtons(step);
  const pending = skip.isPending || complete.isPending;

  return (
    <div className="flex min-h-full flex-col">
      <nav aria-label="Passos da configuração" className="flex flex-wrap items-center gap-2 pb-6">
        {WIZARD_STEPS.map((s, i) => (
          <span
            key={s.id}
            className={
              s.id === step
                ? "rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground"
                : "rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground"
            }
          >
            {i + 1}. {s.label}
          </span>
        ))}
      </nav>

      <div className="flex-1">
        <WizardStepContent step={step} />
      </div>

      <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-border/40 pt-4">
        <Button type="button" variant="ghost" disabled={pending} onClick={() => dispatch({ type: "skip" })}>
          Pular configuração
        </Button>
        <div className="flex items-center gap-2">
          {buttons.later && (
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => dispatch({ type: "later" })}
            >
              Fazer depois
            </Button>
          )}
          <Button
            type="button"
            disabled={pending}
            onClick={() => dispatch({ type: buttons.primary === "concluir" ? "complete" : "later" })}
          >
            {buttons.primary === "concluir"
              ? complete.isPending
                ? "Concluindo…"
                : "Concluir"
              : "Avançar"}
          </Button>
        </div>
      </div>
    </div>
  );
}
