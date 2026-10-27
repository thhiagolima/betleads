// Área do Expert (Fase 2, Task 7): ficha do lead — à esquerda o cabeçalho,
// os números, os benefícios e a linha do tempo; à direita as ações (link,
// mensagem, IA, contato, retorno e assumir). No mobile vira uma coluna só,
// com as ações primeiro. Depois de cada ação, a ficha é recarregada.
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { Card, CardContent } from "@/components/ui/card";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { LeadActions } from "@/components/expert/lead-actions";
import { LeadContactPanel } from "@/components/expert/lead-contact-panel";
import {
  LeadBenefits,
  LeadSheetHeader,
  LeadSheetStats,
} from "@/components/expert/lead-sheet-header";
import { LeadTimeline } from "@/components/expert/lead-timeline";
import { expertAccessErrorMessage } from "@/lib/expert-access-message";
import { getExpertLeadSheet } from "@/lib/expert-lead-sheet.functions";

export const Route = createFileRoute("/expert/leads/$playerId")({
  component: ExpertLeadSheetPage,
});

function ExpertLeadSheetPage() {
  const { playerId } = Route.useParams();
  const queryClient = useQueryClient();
  const queryKey = ["expert-lead-sheet", playerId];

  const getSheetFn = useServerFn(getExpertLeadSheet);
  const sheetQuery = useQuery({
    queryKey,
    queryFn: () => getSheetFn({ data: { playerId } }),
    staleTime: 15_000,
  });

  const refreshSheet = () => {
    void queryClient.invalidateQueries({ queryKey });
  };

  if (sheetQuery.isError) {
    return (
      <Page>
        <PageHeader />
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {expertAccessErrorMessage(sheetQuery.error)}
          </CardContent>
        </Card>
      </Page>
    );
  }

  if (sheetQuery.isLoading || !sheetQuery.data) {
    return (
      <Page>
        <PageHeader />
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">Carregando…</CardContent>
        </Card>
      </Page>
    );
  }

  const sheet = sheetQuery.data;

  return (
    <Page>
      <LeadSheetHeader sheet={sheet} />

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,400px)]">
        <div className="min-w-0 space-y-3 lg:col-start-1 lg:row-start-1">
          <LeadSheetStats lead={sheet.lead} />
          <LeadBenefits beneficios={sheet.beneficios} />
          <LeadTimeline items={sheet.timeline} />
        </div>
        <div className="order-first min-w-0 space-y-3 lg:order-none lg:col-start-2 lg:row-start-1">
          <LeadActions key={sheet.lead.id} sheet={sheet} onChanged={refreshSheet} />
          <LeadContactPanel key={sheet.lead.id} sheet={sheet} onChanged={refreshSheet} />
        </div>
      </div>
    </Page>
  );
}
