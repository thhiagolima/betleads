// Linha do tempo da ficha do lead (Área do Expert, Fase 2, Task 7): itens já
// montados e ordenados por `buildExpertTimeline` (src/lib/expert-lead-sheet.ts).
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CalendarClock,
  Gift,
  Link2,
  Mail,
  MessageSquare,
  MousePointerClick,
  PhoneCall,
  type LucideIcon,
} from "lucide-react";

import { HomeCard } from "@/components/home/home-cards";
import type { ExpertTimelineItem, ExpertTimelineKind } from "@/lib/expert-lead-sheet";
import { brl } from "@/lib/format";

import { formatBrtDateTime } from "./sheet-format";

const KIND_ICON: Record<ExpertTimelineKind, LucideIcon> = {
  deposito: ArrowDownToLine,
  saque: ArrowUpFromLine,
  cashback: Gift,
  sms_casa: MessageSquare,
  email_casa: Mail,
  link_expert: Link2,
  clique: MousePointerClick,
  contato: PhoneCall,
  retorno: CalendarClock,
};

export function LeadTimeline({ items }: { items: ExpertTimelineItem[] }) {
  return (
    <HomeCard className="p-4 sm:p-5">
      <h2 className="text-section">Linha do tempo</h2>
      {items.length === 0 ? (
        <p className="mt-2 text-body text-muted-foreground">Nada por aqui ainda.</p>
      ) : (
        <ol className="mt-2 divide-y divide-border/70">
          {items.map((item) => {
            const Icon = KIND_ICON[item.kind];
            return (
              <li key={item.id} className="flex gap-3 py-2.5">
                <Icon
                  className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <p className="text-body font-medium">{item.titulo}</p>
                    {item.valor != null && (
                      <span className="text-body font-semibold tabular-nums">
                        {brl(item.valor)}
                      </span>
                    )}
                  </div>
                  {item.detalhe && (
                    <p className="mt-0.5 break-words text-label text-muted-foreground">
                      {item.detalhe}
                    </p>
                  )}
                  <p className="mt-0.5 text-meta text-muted-foreground">
                    {formatBrtDateTime(item.at)}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </HomeCard>
  );
}
