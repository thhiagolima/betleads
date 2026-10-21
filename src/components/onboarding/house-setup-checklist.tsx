// Home checklist: "Configure sua casa" — shows for any house member while
// setup is incomplete (`complete:false`). Non-admins see it read-only: the
// link still goes to /configuracoes/casa, where writes are already gated by
// `canEdit`. Hidden entirely the moment every item reads "done".
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Check, ChevronRight, CircleDashed, Clock } from "lucide-react";

import { HomeCard } from "@/components/home/home-cards";
import { HOUSE_SETUP_STATUS_QUERY_KEY } from "@/components/house-config/house-config-query";
import { getHouseSetupStatus } from "@/lib/house-config.functions";
import type { SetupItemState } from "@/lib/house-config";
import { cn } from "@/lib/utils";

export type ChecklistItemId = "house" | "shortener" | "email";
export type ChecklistItem = { id: ChecklistItemId; state: SetupItemState };
export type SetupChecklist = { items: ChecklistItem[]; complete: boolean };

const ITEM_LABEL: Record<ChecklistItemId, string> = {
  house: "URL da casa e URLs rápidas",
  shortener: "Domínio do encurtador",
  email: "Domínio e remetente de e-mail",
};

/** The label shown for one checklist item: the "aguardando DNS" suffix is
 * appended only while a domain is mid-verification — "done" and "todo" read
 * the plain label. */
export function checklistItemLabel(item: ChecklistItem): string {
  const base = ITEM_LABEL[item.id];
  return item.state === "pending_dns" ? `${base} · aguardando DNS` : base;
}

/** "N de M" progress text: how many items are already done. */
export function checklistProgressLabel(items: ChecklistItem[]): string {
  const done = items.filter((i) => i.state === "done").length;
  return `${done} de ${items.length}`;
}

function ItemIcon({ state }: { state: SetupItemState }) {
  if (state === "done") return <Check className="size-4 shrink-0 text-emerald-400" aria-hidden="true" />;
  if (state === "pending_dns") return <Clock className="size-4 shrink-0 text-amber-400" aria-hidden="true" />;
  return <CircleDashed className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
}

/** The `<ul>` of checklist items, shared by the home checklist card and the
 * wizard's "Pronto" step summary. Pure presentational — no data fetching. */
export function ChecklistItemsList({
  items,
  className,
}: {
  items: ChecklistItem[];
  className?: string;
}) {
  return (
    <ul className={cn("space-y-2", className)}>
      {items.map((item) => (
        <li key={item.id} className="flex items-center gap-2 text-[13.5px]">
          <ItemIcon state={item.state} />
          <span className={cn(item.state === "done" && "text-muted-foreground line-through")}>
            {checklistItemLabel(item)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Presentational, data-free view — kept separate from `HouseSetupChecklist`
 * so it can be exercised with `renderToStaticMarkup` in tests (no jsdom in
 * this repo, no react-query context needed). */
export function HouseSetupChecklistView({ checklist }: { checklist: SetupChecklist }) {
  if (checklist.complete) return null;

  return (
    <HomeCard className="p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Configure sua casa</h3>
        <span className="text-xs tabular-nums text-muted-foreground">
          {checklistProgressLabel(checklist.items)}
        </span>
      </div>
      <ChecklistItemsList items={checklist.items} className="mt-3" />
      <a
        href="/configuracoes/casa"
        className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
      >
        Continuar configuração
        <ChevronRight className="size-3.5" aria-hidden="true" />
      </a>
    </HomeCard>
  );
}

export function HouseSetupChecklist() {
  const fetchStatus = useServerFn(getHouseSetupStatus);
  const query = useQuery({
    queryKey: HOUSE_SETUP_STATUS_QUERY_KEY,
    queryFn: () => fetchStatus(),
  });

  if (!query.data) return null;
  return <HouseSetupChecklistView checklist={query.data.checklist} />;
}
