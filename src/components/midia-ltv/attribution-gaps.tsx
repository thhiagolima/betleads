import { Info, ListChecks } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { OrphanReasonRow, UnlinkedCampaignRow } from "@/lib/marketing-overview";
import { tourAnchor } from "@/help/anchor";
import {
  ORPHAN_REASON_COPY,
  cadastros,
  orphanTotals,
  sortedReasons,
  unlinkedShare,
} from "./attribution-copy";

// F1-04: aviso de cadastros com marcação que não viraram anúncio, separado por motivo.
export function OrphanReasonsNotice({
  reasons,
  formatHouse,
  onOpenDiagnostics,
}: {
  reasons: OrphanReasonRow[];
  formatHouse: (value: number) => string;
  onOpenDiagnostics: () => void;
}) {
  const rows = sortedReasons(reasons);
  if (rows.length === 0) return null;
  const total = orphanTotals(rows);
  return (
    <section
      aria-label="Cadastros sem anúncio ligado"
      className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm"
      {...tourAnchor("midia.aviso.sem-anuncio")}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-warning">
            {cadastros(total.players)} do período chegaram com marcação, mas não foram ligados a
            nenhum anúncio
          </p>
          <p className="mt-1 text-muted-foreground">
            Eles somam {formatHouse(total.revenue)} em depósitos e {total.ftd} primeiros depósitos,
            que ficam fora do ROAS. Por motivo:
          </p>
        </div>
        <Button variant="outline" size="sm" className="gap-2" onClick={onOpenDiagnostics}>
          <ListChecks aria-hidden className="h-3.5 w-3.5" />
          Ver no Diagnóstico
        </Button>
      </div>
      <ul className="mt-3 space-y-2">
        {rows.map((row) => (
          <li key={row.reason} className="rounded-md bg-background/40 px-3 py-2">
            <p>
              <strong className="text-foreground">{cadastros(row.players)}</strong>{" "}
              {ORPHAN_REASON_COPY[row.reason].label}
              <span className="text-muted-foreground">
                {" "}
                · {formatHouse(row.revenue)} em depósitos
              </span>
            </p>
            <p className="mt-0.5 text-meta text-muted-foreground">
              {ORPHAN_REASON_COPY[row.reason].action}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

// F1-05: quanto do investido foi para campanhas sem nenhum cadastro ligado no período.
export function UnlinkedSpendNote({
  spend,
  spendUnlinked,
  campaigns,
  formatSpend,
}: {
  spend: number;
  spendUnlinked: number;
  campaigns: UnlinkedCampaignRow[];
  formatSpend: (value: number) => string;
}) {
  const share = unlinkedShare(spendUnlinked, spend);
  if (share == null) return null;
  return (
    <section
      aria-label="Gasto sem cadastro ligado"
      className="rounded-lg border border-border/70 bg-muted/30 px-4 py-3 text-sm"
      {...tourAnchor("midia.aviso.gasto-sem-cadastro")}
    >
      <p className="flex items-center gap-2 font-semibold">
        <Info aria-hidden className="h-4 w-4 text-muted-foreground" />
        {formatSpend(spendUnlinked)} do investido ({share}%) foram para campanhas sem nenhum
        cadastro ligado neste período
      </p>
      {campaigns.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {campaigns.map((row) => (
            <li
              key={row.campaign_id ?? row.campaign}
              className="rounded-full border border-border/70 px-2.5 py-0.5 text-meta"
            >
              {row.campaign} · {formatSpend(row.spend)}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-muted-foreground">
        Esse gasto entra no investido, mas nenhum jogador foi ligado a ele. Por isso o custo por
        cadastro e o ROAS acima ficam piores. Campanha que leva a uma live ou ao perfil precisa do
        ID dela em utm_campaign nos links para os cadastros contarem. Campanhas de engajamento e
        aquecimento também aparecem aqui.
      </p>
    </section>
  );
}
