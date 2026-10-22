// Full-screen first-access wizard: Casa → Encurtador → E-mail → Pronto. Each
// step reuses a Task 10 section with `variant="wizard"` (no card chrome).
// "Pular configuração" is always visible and calls `skipOnboarding`; "Fazer
// depois" just advances to the next step (no save call of its own — whatever
// the step's inputs already saved stays saved, nothing extra happens);
// "Avançar" on the Casa step first saves the unsaved site URL / quick links
// (ruling R10 — on error it stays on the step with a toast); the last step's
// "Concluir" calls `completeOnboarding`. The step-transition
// logic is pure (`reduceWizard`/`applyWizardEffect`) so it's testable without
// a DOM — the component below only wires it to the two mutations.
import { useRef, useState, type Ref } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  HouseSiteSection,
  type HouseSiteSaveHandle,
} from "@/components/house-config/house-site-section";
import { DomainsSection } from "@/components/house-config/domains-section";
import { EmailSendersSection } from "@/components/house-config/email-senders-section";
import { HOUSE_SETUP_STATUS_QUERY_KEY } from "@/components/house-config/house-config-query";
import { completeOnboarding, getHouseSetupStatus, skipOnboarding } from "@/lib/house-config.functions";
import {
  ChecklistItemsList,
  checklistProgressLabel,
  type SetupChecklist,
} from "@/components/onboarding/house-setup-checklist";

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

/** Ruling R10: "Avançar" on the Casa step first saves the unsaved site URL /
 * quick links; "Fazer depois", "Pular" and the other steps never save. */
export function shouldSaveBeforeAdvance(step: WizardStepId, action: WizardAction["type"]): boolean {
  return step === "casa" && action === "later";
}

/** The primary button ("Avançar"/"Concluir"): runs the step's pending save
 * when required, and only then applies the transition; a failed save keeps
 * the wizard on the step. ("Fazer depois" dispatches directly, no save.) */
export async function runWizardPrimary(
  step: WizardStepId,
  action: WizardAction,
  opts: { save: () => Promise<boolean>; apply: (effect: WizardEffect) => void },
): Promise<boolean> {
  if (shouldSaveBeforeAdvance(step, action.type)) {
    const ok = await opts.save();
    if (!ok) return false;
  }
  opts.apply(reduceWizard(step, action));
  return true;
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

/** The "Pronto" step's content: a checklist summary (controller-mandated —
 * the wizard's last step must show where the house's setup actually stands,
 * not just a generic "all done" message) above the footer's "Concluir".
 * Presentational and data-free, like `HouseSetupChecklistView`, so it's
 * testable with `renderToStaticMarkup`; `checklist` is `undefined` only
 * while the status query hasn't resolved yet. */
export function WizardReadyStepView({ checklist }: { checklist: SetupChecklist | undefined }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Tudo pronto. Você pode ajustar qualquer coisa depois em Configurações → Casa.
      </p>
      {checklist && (
        <div className="rounded-lg border border-border/40 bg-background/30 p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">Resumo da configuração</h3>
            <span className="text-xs tabular-nums text-muted-foreground">
              {checklistProgressLabel(checklist.items)}
            </span>
          </div>
          <ChecklistItemsList items={checklist.items} className="mt-3" />
        </div>
      )}
    </div>
  );
}

function WizardStepContent({
  step,
  checklist,
  siteSaveRef,
}: {
  step: WizardStepId;
  checklist: SetupChecklist | undefined;
  siteSaveRef: Ref<HouseSiteSaveHandle>;
}) {
  if (step === "casa") return <HouseSiteSection variant="wizard" saveRef={siteSaveRef} />;
  if (step === "encurtador") return <DomainsSection kind="shortener" variant="wizard" />;
  if (step === "email") {
    return (
      <div className="space-y-6">
        <DomainsSection kind="email" variant="wizard" />
        <EmailSendersSection variant="wizard" />
      </div>
    );
  }
  return <WizardReadyStepView checklist={checklist} />;
}

export function HouseSetupWizard({ initialStep = "casa" }: { initialStep?: WizardStepId }) {
  const qc = useQueryClient();
  const [step, setStep] = useState<WizardStepId>(initialStep);
  const siteSaveRef = useRef<HouseSiteSaveHandle>(null);
  const [savingStep, setSavingStep] = useState(false);

  const fetchStatus = useServerFn(getHouseSetupStatus);
  const statusQuery = useQuery({
    queryKey: HOUSE_SETUP_STATUS_QUERY_KEY,
    queryFn: () => fetchStatus(),
  });

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

  const applyEffect = (effect: WizardEffect) =>
    applyWizardEffect(effect, {
      onAdvance: setStep,
      onSkip: () => skip.mutate(),
      onComplete: () => complete.mutate(),
    });

  function dispatch(action: WizardAction) {
    applyEffect(reduceWizard(step, action));
  }

  async function primary(action: WizardAction) {
    setSavingStep(true);
    try {
      await runWizardPrimary(step, action, {
        save: () => siteSaveRef.current?.saveIfDirty() ?? Promise.resolve(true),
        apply: applyEffect,
      });
    } finally {
      setSavingStep(false);
    }
  }

  const buttons = wizardStepButtons(step);
  const pending = skip.isPending || complete.isPending || savingStep;

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/40 px-4 py-4 sm:px-6">
        <nav aria-label="Passos da configuração" className="flex flex-wrap items-center gap-2">
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
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={() => dispatch({ type: "skip" })}
        >
          Pular configuração
        </Button>
      </header>

      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 sm:px-6 sm:py-10">
        <WizardStepContent
          step={step}
          checklist={statusQuery.data?.checklist}
          siteSaveRef={siteSaveRef}
        />
      </div>

      <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-end gap-2 border-t border-border/40 px-4 py-4 sm:px-6">
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
          onClick={() => void primary({ type: buttons.primary === "concluir" ? "complete" : "later" })}
        >
          {buttons.primary === "concluir"
            ? complete.isPending
              ? "Concluindo…"
              : "Concluir"
            : savingStep
              ? "Salvando…"
              : "Avançar"}
        </Button>
      </div>
    </div>
  );
}
