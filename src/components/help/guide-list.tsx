// "Guias passo a passo" list inside the help panel (brief, Task 6):
// presentational, renders with `renderToStaticMarkup` (no Sheet/portal).
// Progress comes from `GuideSignals` fetched by the caller (HelpProvider)
// through `getGuideSignals`; when that fetch fails or hasn't resolved yet,
// `signals` is null and guides render with no counts (brief, Step 3).
import { ArrowRight, ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";

import { roleCanSee } from "@/help/search";
import { computeGuideView, type Guide, type GuideSignals, type GuideStep } from "@/help/guides";
import type { HelpRole } from "@/help/types";
import { cn } from "@/lib/utils";

const ROLE_LABEL: Record<HelpRole, string> = {
  admin: "admin",
  gestor: "gestor",
  member: "membro",
  expert: "expert",
};

/** Expands a specific guide on request (a search result of kind "guide"
 * was selected) — same `{ id, nonce }` shape as `HelpPanelFocus`, so the
 * same guide can be requested again. */
export type GuideListFocus = { guideId: string; nonce: number };

export type GuideListProps = {
  guides: Guide[];
  role: HelpRole;
  /** null: `getGuideSignals` hasn't resolved or failed — guides show with no
   * progress count, but are still browsable. */
  signals: GuideSignals | null;
  onGoToStep: (step: GuideStep) => void;
  focus?: GuideListFocus | null;
};

function progressLabel(doneCount: number, total: number): string {
  return doneCount >= total ? "concluído ✓" : `${doneCount} de ${total} feitos`;
}

export function GuideList({ guides, role, signals, onGoToStep, focus }: GuideListProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(focus ? [focus.guideId] : []));

  // `focus.nonce` changes on every request (same guide can be opened twice).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!focus) return;
    setExpanded((prev) => new Set(prev).add(focus.guideId));
  }, [focus?.guideId, focus?.nonce]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="divide-y divide-border/60">
      {guides.map((guide) => {
        const locked = !roleCanSee(guide.requiresRole ? [guide.requiresRole] : undefined, role);
        const view = signals ? computeGuideView(guide, signals) : null;
        const isOpen = expanded.has(guide.id);
        return (
          <div key={guide.id} className="py-2">
            <button
              type="button"
              onClick={() => toggle(guide.id)}
              aria-expanded={isOpen}
              className="flex w-full items-center justify-between gap-3 rounded-lg px-1 py-1.5 text-left transition-colors hover:bg-foreground/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex items-center gap-2 text-[13px] font-medium">
                {isOpen ? (
                  <ChevronDown className="size-4 text-muted-foreground" aria-hidden="true" />
                ) : (
                  <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
                )}
                {guide.title}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {locked ? `só ${ROLE_LABEL[guide.requiresRole as HelpRole]}` : view ? progressLabel(view.doneCount, view.total) : null}
              </span>
            </button>
            {isOpen ? (
              <ol className="ml-6 mt-2 space-y-3">
                {guide.steps.map((step, i) => {
                  const done = view?.stepDone[i] ?? false;
                  return (
                    <li key={step.id} className="text-[13px]">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className={cn("font-medium", done && "text-muted-foreground line-through")}>
                          {step.title}
                        </span>
                        <button
                          type="button"
                          onClick={() => onGoToStep(step)}
                          className="inline-flex shrink-0 items-center gap-1 text-xs text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          Ir para esta etapa
                          <ArrowRight className="size-3" aria-hidden="true" />
                        </button>
                      </div>
                      {step.substeps.length > 0 ? (
                        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
                          {step.substeps.map((sub) => (
                            <li key={sub}>{sub}</li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
