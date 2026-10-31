// Detalhe do expert para o admin: abas "Rendimento" | "Campanhas" em
// /rendimento/equipe/$expertId (?aba=campanhas). A aba Campanhas mostra o
// modo de envio, o uso do mês × teto e a fila de campanhas do expert
// (pendentes primeiro) com Revisar (Aprovar/Recusar), Pausar e Retomar.
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { ExpertCampaignsQueue, ExpertUsageBar } from "@/components/experts/expert-campaigns-admin";
import { EXPERTS_QUERY_KEY } from "@/components/experts/experts-query";
import { useExpertUsageAdmin } from "@/components/experts/use-expert-campaigns-admin";
import { useActiveTenant } from "@/hooks/use-active-tenant";
import { listExperts } from "@/lib/experts-admin.functions";
import { brl } from "@/lib/format";
import { cn } from "@/lib/utils";

export type ExpertDetailTab = "rendimento" | "campanhas";

const tabClass = (active: boolean) =>
  cn(
    "inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
    active
      ? "border-primary text-foreground"
      : "border-transparent text-muted-foreground hover:text-foreground",
  );

/** Abas do detalhe do expert (só no modo admin). */
export function ExpertDetailTabs({
  expertId,
  active,
  pendentes = 0,
}: {
  expertId: string;
  active: ExpertDetailTab;
  pendentes?: number;
}) {
  return (
    <nav aria-label="Seções do expert" className="flex gap-1 border-b border-border/60">
      <Link
        to="/rendimento/equipe/$expertId"
        params={{ expertId }}
        search={{}}
        className={tabClass(active === "rendimento")}
        aria-current={active === "rendimento" ? "page" : undefined}
      >
        Rendimento
      </Link>
      <Link
        to="/rendimento/equipe/$expertId"
        params={{ expertId }}
        search={{ aba: "campanhas" }}
        className={tabClass(active === "campanhas")}
        aria-current={active === "campanhas" ? "page" : undefined}
      >
        Campanhas
        {pendentes > 0 && (
          <Badge
            className="h-5 border-transparent bg-warning/15 px-1.5 text-warning shadow-none"
            aria-label={`${pendentes} aguardando aprovação`}
          >
            {pendentes}
          </Badge>
        )}
      </Link>
    </nav>
  );
}

/** Abas com a contagem de pendentes do expert (usada também na aba Rendimento). */
export function ExpertDetailTabsWithCount({
  expertId,
  active,
}: {
  expertId: string;
  active: ExpertDetailTab;
}) {
  const usage = useExpertUsageAdmin(expertId);
  const pendentes = usage.data?.items[0]?.pendentes ?? 0;
  return <ExpertDetailTabs expertId={expertId} active={active} pendentes={pendentes} />;
}

export function ExpertCampaignsAdminView({ expertId }: { expertId: string }) {
  const { data: switcher } = useActiveTenant();
  const tenantId = switcher?.activeTenantId ?? null;
  const listExpertsFn = useServerFn(listExperts);
  const expertsQuery = useQuery({
    queryKey: [...EXPERTS_QUERY_KEY, tenantId],
    queryFn: () => listExpertsFn(),
    enabled: !!tenantId,
  });
  const expert = expertsQuery.data?.find((row) => row.id === expertId) ?? null;
  const usageQuery = useExpertUsageAdmin(expertId);
  const usage = usageQuery.data?.items[0] ?? null;
  const mes = usageQuery.data?.mes;
  const mesLabel = mes
    ? new Date(`${mes}-15T12:00:00Z`).toLocaleDateString("pt-BR", {
        month: "long",
        year: "numeric",
      })
    : null;

  return (
    <Page>
      <PageHeader
        title={expert?.nome ?? "Expert"}
        subtitle="Campanhas de SMS, e-mail e voz do expert, aprovação e teto mensal."
      />
      <ExpertDetailTabs expertId={expertId} active="campanhas" pendentes={usage?.pendentes ?? 0} />

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Envio de campanhas
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="text-lg font-semibold">
              {expert ? (expert.envioModo === "aprovacao" ? "Com aprovação" : "Livre") : "—"}
            </div>
            <p className="text-xs text-muted-foreground">
              {expert?.envioModo === "aprovacao"
                ? "Cada campanha fica pendente até você aprovar ou recusar."
                : "As campanhas do expert disparam direto."}{" "}
              Mude em Editar, na aba Rendimento ou na tela Experts.
            </p>
          </CardContent>
        </Card>
        <Card className="md:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Uso do teto{mesLabel ? ` · ${mesLabel}` : ""}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {usage ? (
              <ExpertUsageBar usage={usage} />
            ) : (
              <p className="text-sm text-muted-foreground">
                {usageQuery.isError ? "Não foi possível carregar o uso." : "Carregando…"}
              </p>
            )}
            {usage && usage.pendentes > 0 && (
              <p className="text-xs text-muted-foreground">
                {usage.pendentes === 1
                  ? "1 campanha aguardando"
                  : `${usage.pendentes} campanhas aguardando`}{" "}
                aprovação, estimadas em {brl(usage.pendentesEstimado)}.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Soma de SMS, e-mail e voz no mês, pelo preço cobrado da casa.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Campanhas do expert</CardTitle>
        </CardHeader>
        <CardContent>
          <ExpertCampaignsQueue
            expertId={expertId}
            emptyText="Nenhuma campanha deste expert nos últimos 90 dias."
          />
        </CardContent>
      </Card>
    </Page>
  );
}
