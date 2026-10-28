// Relatório de rendimento de uma pessoa (spec §4), compartilhado pelas três
// rotas: /expert/rendimento e /rendimento (o próprio usuário, sem
// `expertId`) e /rendimento/equipe/$expertId (o admin, com `expertId`).
// Cabeçalho (nome, tipo, casa, período, CSV do extrato, "Atualizado às"),
// bloco 1 (cartões), 2 (funil), 3 (gráfico), 4 (top leads), 5 (extrato) e 6
// (carteira), mais o histórico do lead num painel lateral.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Download, Pencil, Power } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { CentralPeriodPicker } from "@/components/crm-results/shared";
import { DemoDisabledTooltip } from "@/components/demo-disabled-tooltip";
import { actionErrorMessage } from "@/components/expert/sheet-format";
import { ExpertFormDialog } from "@/components/experts/expert-form-dialog";
import {
  EXPERTS_QUERY_KEY,
  UNASSIGNED_AFFILIATES_QUERY_KEY,
} from "@/components/experts/experts-query";
import { CreditStatement } from "@/components/rendimento/credit-statement";
import { downloadCsv } from "@/components/rendimento/download-csv";
import { LeadHistorySheet } from "@/components/rendimento/lead-history-sheet";
import {
  PortfolioTable,
  TopLeadsCard,
  type LeadRef,
} from "@/components/rendimento/portfolio-table";
import { ReportCards } from "@/components/rendimento/report-cards";
import { ReportChart } from "@/components/rendimento/report-chart";
import { ReportFunnel } from "@/components/rendimento/report-funnel";
import { useActiveTenant } from "@/hooks/use-active-tenant";
import { useIsDemoTenant } from "@/hooks/use-is-demo-tenant";
import { exportExpertCreditsCsv } from "@/lib/expert-metrics.functions";
import { DEFAULT_REPORT_PERIOD, EXPERT_PERIODS, type PeriodKey } from "@/lib/expert-period";
import { getExpertReport } from "@/lib/expert-report.functions";
import {
  listExperts,
  listUnassignedAffiliates,
  setExpertActive,
} from "@/lib/experts-admin.functions";

// Exportada para a "Regras de crédito" dialog (expert-settings-dialog.tsx)
// invalidar o relatório depois de salvar a janela de clique.
export const REPORT_QUERY_KEY = "rendimento-report";

/** Instante ISO -> "hh:mm" no fuso de São Paulo. */
function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "Editar" e "Desativar"/"Ativar" do admin, com os diálogos da tela Experts. */
function AdminActions({ expertId }: { expertId: string }) {
  const qc = useQueryClient();
  const isDemo = useIsDemoTenant();
  const { data: switcher } = useActiveTenant();
  const tenantId = switcher?.activeTenantId ?? null;
  const [formOpen, setFormOpen] = useState(false);

  const listExpertsFn = useServerFn(listExperts);
  const expertsQuery = useQuery({
    queryKey: [...EXPERTS_QUERY_KEY, tenantId],
    queryFn: () => listExpertsFn(),
    enabled: !!tenantId,
  });
  const listUnassignedFn = useServerFn(listUnassignedAffiliates);
  const unassignedQuery = useQuery({
    queryKey: [...UNASSIGNED_AFFILIATES_QUERY_KEY, tenantId],
    queryFn: () => listUnassignedFn(),
    enabled: !!tenantId && formOpen,
  });
  const expert = expertsQuery.data?.find((row) => row.id === expertId) ?? null;

  const setActiveFn = useServerFn(setExpertActive);
  const toggleActive = useMutation({
    mutationFn: (ativo: boolean) => setActiveFn({ data: { expertId, ativo } }),
    onSuccess: (_data, ativo) => {
      toast.success(ativo ? "Expert ativado" : "Expert desativado");
      qc.invalidateQueries({ queryKey: EXPERTS_QUERY_KEY });
      qc.invalidateQueries({ queryKey: [REPORT_QUERY_KEY] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  function handleFormOpenChange(open: boolean) {
    setFormOpen(open);
    // O nome pode ter mudado: o cabeçalho do relatório vem de `getExpertReport`.
    if (!open) qc.invalidateQueries({ queryKey: [REPORT_QUERY_KEY] });
  }

  return (
    <>
      <DemoDisabledTooltip active={isDemo}>
        <Button
          variant="outline"
          className="gap-2"
          disabled={isDemo || !expert}
          onClick={() => setFormOpen(true)}
        >
          <Pencil className="h-4 w-4" />
          Editar
        </Button>
      </DemoDisabledTooltip>
      <DemoDisabledTooltip active={isDemo}>
        <Button
          variant="outline"
          className="gap-2"
          disabled={isDemo || !expert || toggleActive.isPending}
          onClick={() => expert && toggleActive.mutate(!expert.ativo)}
        >
          <Power className="h-4 w-4" />
          {expert && !expert.ativo ? "Ativar" : "Desativar"}
        </Button>
      </DemoDisabledTooltip>
      <ExpertFormDialog
        open={formOpen}
        onOpenChange={handleFormOpenChange}
        expert={expert}
        unassignedAffiliates={unassignedQuery.data ?? []}
      />
    </>
  );
}

function ExportStatementButton({ expertId, period }: { expertId?: string; period: PeriodKey }) {
  const exportFn = useServerFn(exportExpertCreditsCsv);
  const exportMutation = useMutation({
    mutationFn: () => exportFn({ data: { expertId, period } }),
    onSuccess: (result) => {
      downloadCsv(result.filename, result.csv);
      toast.success("CSV exportado.");
    },
    onError: (error: Error) => toast.error(error.message),
  });
  return (
    <Button
      variant="outline"
      className="gap-2"
      onClick={() => exportMutation.mutate()}
      disabled={exportMutation.isPending}
    >
      <Download className="h-4 w-4" />
      {exportMutation.isPending ? "Exportando…" : "Exportar CSV"}
    </Button>
  );
}

function MessageCard({ children }: { children: string }) {
  return (
    <Card>
      <CardContent className="py-12 text-center text-muted-foreground">{children}</CardContent>
    </Card>
  );
}

/**
 * Relatório de rendimento. Sem `expertId`, é o do próprio usuário (expert ou
 * perfil de equipe vinculado); com `expertId`, é o modo admin.
 */
export function ReportView({ expertId }: { expertId?: string }) {
  const [period, setPeriod] = useState<PeriodKey>(DEFAULT_REPORT_PERIOD);
  const [openLead, setOpenLead] = useState<LeadRef | null>(null);
  const { data: switcher, active } = useActiveTenant();
  const tenantId = switcher?.activeTenantId ?? null;

  const reportFn = useServerFn(getExpertReport);
  const reportQuery = useQuery({
    queryKey: [REPORT_QUERY_KEY, tenantId, expertId ?? "self", period],
    queryFn: () => reportFn({ data: { period, expertId } }),
    enabled: !!tenantId,
  });

  if (reportQuery.isError) {
    return (
      <Page>
        <PageHeader />
        <MessageCard>{actionErrorMessage(reportQuery.error)}</MessageCard>
      </Page>
    );
  }

  const report = reportQuery.data;
  return (
    <Page>
      <PageHeader
        title={report?.subject.nome}
        subtitle={
          report && (
            <span className="inline-flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{report.subject.tipoLabel}</Badge>
              {active?.nome && <span>{active.nome}</span>}
              <span aria-hidden="true">·</span>
              <span>
                {report.atualizadoEm
                  ? `Atualizado às ${timeLabel(report.atualizadoEm)}`
                  : "Os créditos são calculados a cada 10 minutos."}
              </span>
            </span>
          )
        }
        actions={
          <>
            <CentralPeriodPicker value={period} onChange={setPeriod} periods={EXPERT_PERIODS} />
            <ExportStatementButton expertId={expertId} period={period} />
            {expertId && <AdminActions expertId={expertId} />}
          </>
        }
      />

      {!report ? (
        <MessageCard>Carregando…</MessageCard>
      ) : (
        <>
          <section aria-labelledby="rendimento-resultado" className="space-y-3">
            <h2 id="rendimento-resultado" className="text-lg font-semibold">
              Resultado do período
            </h2>
            <ReportCards current={report.current} variacao={report.variacao} />
          </section>

          <div className="grid gap-4 lg:grid-cols-3">
            <ReportFunnel current={report.current} janelaHoras={report.janelaHoras} />
            <div className="min-w-0 lg:col-span-2">
              <ReportChart serie={report.serie} />
            </div>
          </div>

          <TopLeadsCard rows={report.topLeads} onOpenLead={setOpenLead} />
        </>
      )}

      {/* `key`: o extrato volta à primeira página quando o período muda. */}
      <CreditStatement key={period} expertId={expertId} period={period} showExport={false} />

      <PortfolioTable expertId={expertId} period={period} onOpenLead={setOpenLead} />

      <LeadHistorySheet lead={openLead} expertId={expertId} onClose={() => setOpenLead(null)} />
    </Page>
  );
}
