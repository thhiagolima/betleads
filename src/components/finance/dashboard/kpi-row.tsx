// The building blocks of the KPI blocks (Movimentação, Aquisição, GGR,
// Envios e CRM): the titled card with its one-line description, the rows
// (label + optional muted second line on the left; right-aligned value with
// an optional small line and the variation under it), the small uppercase
// subgroup heading and the muted footer.
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function KpiBlock({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section
      data-block={id}
      className="min-w-0 rounded-[14px] border border-border bg-card/80 px-5 pb-2 pt-5 sm:px-[22px]"
    >
      <h3 className="text-[15px] font-semibold leading-tight">{title}</h3>
      <p className="mb-3.5 mt-0.5 text-[12.5px] text-muted-foreground/80">{description}</p>
      {children}
    </section>
  );
}

export function KpiSubheading({ children }: { children: ReactNode }) {
  return (
    <h4 className="mb-1 mt-[18px] text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">
      {children}
    </h4>
  );
}

export function KpiRowShell({
  attrs,
  label,
  detail,
  value,
  sub,
  variation,
  total = false,
  muted = false,
}: {
  /** data-* attributes that name the row (tests, styling hooks). */
  attrs: Record<string, string>;
  label: ReactNode;
  /** Small muted second line under the label. */
  detail?: ReactNode;
  value: ReactNode;
  /** Small line under the value (a reason, a return…). */
  sub?: ReactNode;
  variation?: ReactNode;
  /** A total (Net, Total de envios): emphasized. */
  total?: boolean;
  /** The value is missing ("—"). */
  muted?: boolean;
}) {
  return (
    <div
      {...attrs}
      data-total={total ? "true" : undefined}
      className={cn(
        "flex items-center justify-between gap-3 border-t py-[13px]",
        total ? "border-border" : "border-border/50",
      )}
    >
      <div className="min-w-0">
        <p
          className={cn("text-sm", total ? "font-semibold text-foreground" : "text-foreground/80")}
        >
          {label}
        </p>
        {detail && <p className="mt-0.5 text-xs text-muted-foreground/80">{detail}</p>}
      </div>
      <div className="shrink-0 text-right tabular-nums">
        <p
          className={cn(
            "font-semibold",
            total ? "text-[17px]" : "text-[15.5px]",
            muted && "text-muted-foreground",
          )}
        >
          {value}
        </p>
        {sub && <p className="mt-0.5 text-[11.5px] font-medium text-muted-foreground">{sub}</p>}
        {variation}
      </div>
    </div>
  );
}

export function KpiFooter({ children }: { children: ReactNode }) {
  return (
    <div className="mt-2 border-t border-border/50 pb-3.5 pt-3 text-xs text-muted-foreground/80">
      {children}
    </div>
  );
}
