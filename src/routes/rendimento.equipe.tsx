// "Rendimento da equipe" (Relatório de rendimento, Task 7): topo com os
// totais da equipe (fatia da casa) + ranking, só para o admin. `getTeamReport`
// e `exportTeamReportCsv` (Task 4) fazem o trabalho; `TeamRanking`
// (components/rendimento/team-ranking.tsx) é a tabela ordenável do spec §5.
// `/rendimento/equipe/$expertId` é rota filha (relatório da pessoa) —
// renderiza só o próprio <Outlet />, no padrão de `experts.tsx`.
import { useState } from "react";
import { Outlet, createFileRoute, useRouterState } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Download, Settings } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { CentralPeriodPicker, Kpi } from "@/components/crm-results/shared";
import { actionErrorMessage } from "@/components/expert/sheet-format";
import { ExpertSettingsDialog } from "@/components/experts/expert-settings-dialog";
import { downloadCsv } from "@/components/rendimento/download-csv";
import { TeamRanking, TEAM_REPORT_QUERY_KEY } from "@/components/rendimento/team-ranking";
import { useActiveTenant } from "@/hooks/use-active-tenant";
import { exportTeamReportCsv, getTeamReport } from "@/lib/expert-report.functions";
import { DEFAULT_REPORT_PERIOD, EXPERT_PERIODS, type PeriodKey } from "@/lib/expert-period";
import { brl, num } from "@/lib/format";

export const Route = createFileRoute("/rendimento/equipe")({
  component: RendimentoEquipeRoute,
});

/** A detalhe é rota filha: nela só o <Outlet />, sem montar (nem buscar) o ranking. */
function RendimentoEquipeRoute() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isDetailRoute = pathname.replace(/\/+$/, "") !== "/rendimento/equipe";
  return isDetailRoute ? <Outlet /> : <RendimentoEquipePage />;
}

/** Instante ISO -> "hh:mm" no fuso de São Paulo. */
function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function pctLabel(fraction: number | null): string | null {
  if (fraction === null) return null;
  const value = (fraction * 100).toLocaleString("pt-BR", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return `${value}%`;
}

function ExportTeamCsvButton({ period }: { period: PeriodKey }) {
  const exportFn = useServerFn(exportTeamReportCsv);
  const exportMutation = useMutation({
    mutationFn: () => exportFn({ data: { period } }),
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

function RendimentoEquipePage() {
  const [period, setPeriod] = useState<PeriodKey>(DEFAULT_REPORT_PERIOD);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { data: switcher } = useActiveTenant();
  const tenantId = switcher?.activeTenantId ?? null;

  const teamReportFn = useServerFn(getTeamReport);
  const teamReportQuery = useQuery({
    queryKey: [TEAM_REPORT_QUERY_KEY, tenantId, period],
    queryFn: () => teamReportFn({ data: { period } }),
    enabled: !!tenantId,
  });

  const report = teamReportQuery.data;
  const janelaHoras = report?.janelaHoras ?? null;

  return (
    <Page>
      <PageHeader
        subtitle={
          report?.atualizadoEm
            ? `Atualizado às ${timeLabel(report.atualizadoEm)}`
            : "Os créditos são calculados a cada 10 minutos."
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <CentralPeriodPicker value={period} onChange={setPeriod} periods={EXPERT_PERIODS} />
            <Button variant="outline" className="gap-2" onClick={() => setSettingsOpen(true)}>
              <Settings className="h-4 w-4" />
              Regras de crédito
            </Button>
            <ExportTeamCsvButton period={period} />
          </div>
        }
      />

      {teamReportQuery.isError ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {actionErrorMessage(teamReportQuery.error)}
          </CardContent>
        </Card>
      ) : !report ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Carregando…
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi
              label="Total creditado à equipe"
              value={brl(report.totais.creditado)}
              detail={
                pctLabel(report.totais.pctCasaDepositado)
                  ? `· ${pctLabel(report.totais.pctCasaDepositado)} do depositado na casa`
                  : undefined
              }
            />
            <Kpi
              label="FTDs da equipe"
              value={num(report.totais.ftds)}
              detail={
                pctLabel(report.totais.pctCasaFtds)
                  ? `· ${pctLabel(report.totais.pctCasaFtds)} dos FTDs da casa`
                  : undefined
              }
            />
            <Kpi label="Redepósitos" value={num(report.totais.redepositos)} />
            <Kpi label="Reativados" value={num(report.totais.reativados)} />
          </div>

          <TeamRanking rows={report.rows} />
        </>
      )}

      <ExpertSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        janelaHoras={janelaHoras}
      />
    </Page>
  );
}
