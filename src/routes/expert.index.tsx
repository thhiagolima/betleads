// Área do Expert (Fase 1, Task 9; cartão "Para chamar hoje" na Fase 2, Task
// 8): tela "Início" do expert — saudação, tipo de acesso e casa, o total de
// leads visíveis por ele com um botão para a listagem (/expert/leads), e os
// retornos agendados que vencem hoje ou já venceram (`listExpertFollowupsDue`,
// Task 5), cada um levando à ficha do lead.
import { Link, createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowRight } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { actionErrorMessage, formatDueDate } from "@/components/expert/sheet-format";
import { expertAccessErrorMessage } from "@/lib/expert-access-message";
import { completeExpertFollowup, listExpertFollowupsDue } from "@/lib/expert-lead-actions.functions";
import { getExpertHome } from "@/lib/expert-leads.functions";

const FOLLOWUPS_DUE_QUERY_KEY = ["expert-followups-due"];

function FollowupsDueCard() {
  const qc = useQueryClient();
  const listFn = useServerFn(listExpertFollowupsDue);
  const followupsQuery = useQuery({
    queryKey: FOLLOWUPS_DUE_QUERY_KEY,
    queryFn: () => listFn(),
  });

  const completeFn = useServerFn(completeExpertFollowup);
  const complete = useMutation({
    mutationFn: (id: string) => completeFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Retorno concluído.");
      qc.invalidateQueries({ queryKey: FOLLOWUPS_DUE_QUERY_KEY });
    },
    onError: (error) => toast.error(actionErrorMessage(error)),
  });

  const followups = followupsQuery.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Para chamar hoje</CardTitle>
      </CardHeader>
      <CardContent>
        {followupsQuery.isLoading ? (
          <p className="py-6 text-center text-muted-foreground">Carregando…</p>
        ) : followups.length === 0 ? (
          <p className="py-6 text-center text-muted-foreground">Nenhum retorno para hoje.</p>
        ) : (
          <ul className="divide-y divide-border/70">
            {followups.map((followup) => (
              <li key={followup.id} className="flex items-center justify-between gap-3 py-2.5">
                <Link
                  to="/expert/leads/$playerId"
                  params={{ playerId: followup.playerId }}
                  className="min-w-0 hover:underline"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-body font-medium">{followup.nome}</span>
                    {followup.atrasado && (
                      <Badge variant="destructive">Atrasado · {formatDueDate(followup.dueDate)}</Badge>
                    )}
                  </span>
                  {followup.nota && (
                    <p className="mt-0.5 truncate text-label text-muted-foreground">
                      {followup.nota}
                    </p>
                  )}
                </Link>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  disabled={complete.isPending}
                  onClick={() => complete.mutate(followup.id)}
                >
                  Concluir
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export const Route = createFileRoute("/expert/")({
  component: ExpertHomePage,
});

const TIPO_LABEL: Record<"restrito" | "total", string> = {
  restrito: "Restrito",
  total: "Acesso total",
};

function ExpertHomePage() {
  const getExpertHomeFn = useServerFn(getExpertHome);
  const homeQuery = useQuery({
    queryKey: ["expert-home"],
    queryFn: () => getExpertHomeFn(),
  });

  if (homeQuery.isError) {
    return (
      <Page>
        <PageHeader />
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {expertAccessErrorMessage(homeQuery.error)}
          </CardContent>
        </Card>
      </Page>
    );
  }

  if (homeQuery.isLoading || !homeQuery.data) {
    return (
      <Page>
        <PageHeader />
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Carregando…
          </CardContent>
        </Card>
      </Page>
    );
  }

  const { nome, tipo, tenantNome, totalLeads } = homeQuery.data;

  return (
    <Page>
      <PageHeader
        title={`Olá, ${nome}`}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{TIPO_LABEL[tipo]}</Badge>
            <span>{tenantNome}</span>
          </span>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Seus leads: {totalLeads}</CardTitle>
        </CardHeader>
        <CardContent>
          <Button asChild className="gap-2">
            <Link to="/expert/leads">
              Ver leads
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </CardContent>
      </Card>

      <FollowupsDueCard />
    </Page>
  );
}
