import type { ReactNode } from "react";

import { HomeCard } from "@/components/home/home-cards";
import {
  expertPendingText,
  expertUsageView,
  type ExpertCampaignUsageData,
} from "@/lib/expert-campaign-usage";
import { cn } from "@/lib/utils";

/**
 * "Uso do mês" of the expert's sending cap: amount used × cap with a
 * progress bar (amber from 80%, red at 100%), the blocked/no-cap states and
 * the campaigns still waiting for approval.
 */
export function ExpertUsageCard({
  usage,
  loading = false,
  failed = false,
  title = "Uso do mês",
  action,
  className,
}: {
  usage: ExpertCampaignUsageData | null | undefined;
  loading?: boolean;
  failed?: boolean;
  title?: string;
  /** Optional link/button shown at the top right (e.g. "Ver campanhas"). */
  action?: ReactNode;
  className?: string;
}) {
  const view = usage ? expertUsageView(usage) : null;
  const pending = usage ? expertPendingText(usage) : null;
  return (
    <HomeCard className={cn("space-y-3 p-4 sm:p-5", className)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="text-[12.5px] font-normal text-muted-foreground">{title}</h2>
        {action}
      </div>
      {loading && !usage ? (
        <p className="text-body text-muted-foreground" role="status">
          Carregando consumo…
        </p>
      ) : failed && !usage ? (
        <p className="text-body text-destructive" role="status">
          Não foi possível carregar o consumo do mês.
        </p>
      ) : view ? (
        <>
          <p className="text-body font-semibold tabular-nums" data-usage-state={view.state}>
            {view.headline}
          </p>
          {view.percent !== null ? (
            <div
              role="progressbar"
              aria-label="Uso do teto mensal"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={view.percent}
              className="h-2 w-full overflow-hidden rounded-full bg-secondary"
            >
              <div
                className={cn("h-full rounded-full transition-all", view.barClass)}
                style={{ width: `${view.percent}%` }}
              />
            </div>
          ) : null}
          {view.detail ? (
            <p
              className={cn(
                "text-meta",
                view.state === "atingido" || view.state === "bloqueado"
                  ? "text-danger"
                  : "text-muted-foreground",
              )}
            >
              {view.detail}
            </p>
          ) : null}
          {pending ? <p className="text-meta text-muted-foreground">{pending}</p> : null}
        </>
      ) : null}
    </HomeCard>
  );
}
