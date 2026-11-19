// Admin "Experts" screen (Área do Expert, Fase 1, Task 8): lists the house's
// experts, lets the admin create/edit, invite, remove access, deactivate and
// delete them, and surfaces affiliate ids with no expert yet. Everything
// goes through the Task 6 server functions — no direct Supabase writes from
// the browser.
//
// Fase 3, Task 7: a profile without user can be linked to someone of the
// house team ("Vincular a alguém da equipe") as a performance profile; such
// rows show "Equipe (Gestor)" etc. and "Desvincular" instead of "Remover
// acesso" (the person keeps their own role).
//
// Relatório de rendimento, Task 7: this screen went back to cadastro e
// configuração only — the period picker and the ranking metrics columns
// (`listExpertsRanking`, Fase 3 Task 6) moved to "Rendimento da equipe"
// (/rendimento/equipe), which also shows the "Regras de crédito" shortcut.
// The expert's name now links to the person's report
// (/rendimento/equipe/$expertId) instead of the old /experts/$expertId
// (kept only as a redirect to there). Like `expert.leads.tsx`, this route
// renders only its own list at the exact "/experts" path and defers to
// <Outlet /> under the child path so the list doesn't render underneath the
// detail.
//
// Área do Expert §8: columns Envio (Livre / Com aprovação), Teto and Uso do
// mês (listExpertUsageForAdmin), and an "Aprovações pendentes" card with the
// campaigns waiting for approval across experts (Revisar → Aprovar/Recusar).
// The per-expert queue lives in the expert's "Campanhas" tab
// (/rendimento/equipe/$expertId?aba=campanhas).
import { useState } from "react";
import { Link, Outlet, createFileRoute, useRouterState } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { MoreHorizontal, Plus, Settings, UserPlus } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { firstIndexWhere, tourAnchor } from "@/help/anchor";
import { requestConfirmation } from "@/components/system-dialog-host";
import { DemoDisabledTooltip } from "@/components/demo-disabled-tooltip";
import { useIsDemoTenant } from "@/hooks/use-is-demo-tenant";
import {
  deleteExpert,
  listExperts,
  listUnassignedAffiliates,
  removeExpertAccess,
  setExpertActive,
} from "@/lib/experts-admin.functions";
import type { ExpertAdminRow } from "@/lib/experts-admin.functions";
import { getExpertClickWindowHours } from "@/lib/expert-metrics.functions";
import { acessoBadge, RESTRITO_EQUIPE_AVISO, TIPO_LABEL } from "@/components/experts/expert-badges";
import {
  EXPERT_CLICK_WINDOW_QUERY_KEY,
  EXPERTS_QUERY_KEY,
  UNASSIGNED_AFFILIATES_QUERY_KEY,
} from "@/components/experts/experts-query";
import { ExpertFormDialog } from "@/components/experts/expert-form-dialog";
import { ExpertInviteDialog } from "@/components/experts/expert-invite-dialog";
import { ExpertSettingsDialog } from "@/components/experts/expert-settings-dialog";
import { ExpertTeamLinkDialog } from "@/components/experts/expert-team-link-dialog";
import {
  ExpertEnvioCell,
  ExpertTetoCell,
  ExpertUsageCell,
} from "@/components/experts/expert-list-columns";
import { ExpertCampaignsQueue } from "@/components/experts/expert-campaigns-admin";
import { InfoTip } from "@/components/crm-results/shared";
import { LoadError } from "@/components/rendimento/load-states";
import { useExpertUsageAdmin } from "@/components/experts/use-expert-campaigns-admin";

type RowAction = {
  key: string;
  label: string;
  /** Tour anchor props, only on the first row that shows the action. */
  anchor?: ReturnType<typeof tourAnchor>;
  destructive?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

export const Route = createFileRoute("/experts")({
  component: ExpertsRoute,
});

/** A detalhe é rota filha: nela só o <Outlet />, sem montar (nem buscar) a lista. */
function ExpertsRoute() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isDetailRoute = pathname.replace(/\/+$/, "") !== "/experts";
  return isDetailRoute ? <Outlet /> : <ExpertsPage />;
}

function ExpertsPage() {
  const isDemo = useIsDemoTenant();
  const qc = useQueryClient();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const listExpertsFn = useServerFn(listExperts);
  const listUnassignedFn = useServerFn(listUnassignedAffiliates);
  const clickWindowFn = useServerFn(getExpertClickWindowHours);
  const removeAccessFn = useServerFn(removeExpertAccess);
  const setActiveFn = useServerFn(setExpertActive);
  const deleteExpertFn = useServerFn(deleteExpert);

  const expertsQuery = useQuery({
    queryKey: EXPERTS_QUERY_KEY,
    queryFn: () => listExpertsFn(),
  });
  const unassignedQuery = useQuery({
    queryKey: UNASSIGNED_AFFILIATES_QUERY_KEY,
    queryFn: () => listUnassignedFn(),
  });
  const clickWindowQuery = useQuery({
    queryKey: EXPERT_CLICK_WINDOW_QUERY_KEY,
    queryFn: () => clickWindowFn(),
  });

  const usageQuery = useExpertUsageAdmin();
  const usageByExpert = new Map((usageQuery.data?.items ?? []).map((u) => [u.expertId, u]));
  const pendingTotal = (usageQuery.data?.items ?? []).reduce((sum, u) => sum + u.pendentes, 0);

  const experts = expertsQuery.data ?? [];
  // Per-row action anchors go on the first row that shows that action.
  const firstSemAcesso = firstIndexWhere(experts, (e) => e.acesso === "sem_acesso");
  const firstEquipe = firstIndexWhere(experts, (e) => e.acesso === "equipe");
  const firstComAcesso = firstIndexWhere(
    experts,
    (e) => e.acesso !== "sem_acesso" && e.acesso !== "equipe",
  );
  const unassigned = unassignedQuery.data ?? [];
  // null até carregar: o diálogo não salva um padrão por cima da janela real.
  const janelaHoras = clickWindowQuery.data?.janelaHoras ?? null;

  const [formOpen, setFormOpen] = useState(false);
  const [editingExpert, setEditingExpert] = useState<ExpertAdminRow | null>(null);
  const [prefillAffiliateId, setPrefillAffiliateId] = useState<string | null>(null);
  const [inviteExpertRow, setInviteExpertRow] = useState<ExpertAdminRow | null>(null);
  const [teamLinkExpertRow, setTeamLinkExpertRow] = useState<ExpertAdminRow | null>(null);

  function refresh() {
    qc.invalidateQueries({ queryKey: EXPERTS_QUERY_KEY });
    qc.invalidateQueries({ queryKey: UNASSIGNED_AFFILIATES_QUERY_KEY });
  }

  const removeAccess = useMutation({
    mutationFn: (vars: { expertId: string; equipe: boolean }) =>
      removeAccessFn({ data: { expertId: vars.expertId } }),
    onSuccess: (_data, vars) => {
      toast.success(vars.equipe ? "Perfil desvinculado" : "Acesso removido");
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const toggleActive = useMutation({
    mutationFn: (vars: { expertId: string; ativo: boolean }) => setActiveFn({ data: vars }),
    onSuccess: (_data, vars) => {
      toast.success(vars.ativo ? "Expert ativado" : "Expert desativado");
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const remove = useMutation({
    mutationFn: (expertId: string) => deleteExpertFn({ data: { expertId } }),
    onSuccess: () => {
      toast.success("Expert excluído");
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  function openCreate(affiliateId?: string) {
    setEditingExpert(null);
    setPrefillAffiliateId(affiliateId ?? null);
    setFormOpen(true);
  }

  function openEdit(expert: ExpertAdminRow) {
    setEditingExpert(expert);
    setPrefillAffiliateId(null);
    setFormOpen(true);
  }

  async function confirmUnlink(expert: ExpertAdminRow) {
    const confirmed = await requestConfirmation({
      title: `Desvincular o perfil ${expert.nome}?`,
      description:
        "O perfil deixa de medir o rendimento dessa pessoa. O acesso dela à casa não muda, e o histórico do perfil continua.",
      confirmLabel: "Desvincular",
      destructive: true,
    });
    if (confirmed) removeAccess.mutate({ expertId: expert.id, equipe: true });
  }

  async function confirmRemoveAccess(expert: ExpertAdminRow) {
    const confirmed = await requestConfirmation({
      title: `Remover o acesso de ${expert.nome}?`,
      description:
        "A pessoa perde o acesso a esta casa imediatamente. O cadastro do expert continua existindo.",
      confirmLabel: "Remover acesso",
      destructive: true,
    });
    if (confirmed) removeAccess.mutate({ expertId: expert.id, equipe: false });
  }

  async function confirmDelete(expert: ExpertAdminRow) {
    const confirmed = await requestConfirmation({
      title: `Excluir o expert ${expert.nome}?`,
      description:
        "O cadastro e os IDs de afiliado vinculados a ele deixam de existir. Esta ação não pode ser desfeita.",
      confirmLabel: "Excluir expert",
      destructive: true,
    });
    if (confirmed) remove.mutate(expert.id);
  }

  /** The row's actions, rendered as buttons (desktop) or a menu (phones). */
  function rowActions(expert: ExpertAdminRow, index: number): RowAction[] {
    const semAcesso = expert.acesso === "sem_acesso";
    const equipe = expert.acesso === "equipe";
    const actions: RowAction[] = [
      {
        key: "editar",
        label: "Editar",
        anchor: index === 0 ? tourAnchor("experts.linha.editar") : undefined,
        onSelect: () => openEdit(expert),
      },
    ];
    if (semAcesso) {
      actions.push(
        {
          key: "convidar",
          label: "Convidar",
          anchor: index === firstSemAcesso ? tourAnchor("experts.linha.convidar") : undefined,
          onSelect: () => setInviteExpertRow(expert),
        },
        {
          key: "vincular",
          label: "Vincular a alguém da equipe",
          anchor: index === firstSemAcesso ? tourAnchor("experts.linha.vincular") : undefined,
          onSelect: () => setTeamLinkExpertRow(expert),
        },
      );
    }
    if (equipe) {
      actions.push({
        key: "desvincular",
        label: "Desvincular",
        anchor: index === firstEquipe ? tourAnchor("experts.linha.desvincular") : undefined,
        disabled: removeAccess.isPending,
        onSelect: () => void confirmUnlink(expert),
      });
    }
    if (!semAcesso && !equipe) {
      actions.push({
        key: "remover-acesso",
        label: "Remover acesso",
        anchor: index === firstComAcesso ? tourAnchor("experts.linha.remover-acesso") : undefined,
        disabled: removeAccess.isPending,
        onSelect: () => void confirmRemoveAccess(expert),
      });
    }
    actions.push({
      key: "ativar",
      label: expert.ativo ? "Desativar" : "Ativar",
      anchor: index === 0 ? tourAnchor("experts.linha.ativar") : undefined,
      disabled: toggleActive.isPending,
      onSelect: () => toggleActive.mutate({ expertId: expert.id, ativo: !expert.ativo }),
    });
    if (semAcesso) {
      actions.push({
        key: "excluir",
        label: "Excluir",
        anchor: index === firstSemAcesso ? tourAnchor("experts.linha.excluir") : undefined,
        destructive: true,
        disabled: remove.isPending,
        onSelect: () => void confirmDelete(expert),
      });
    }
    return actions;
  }

  return (
    <Page>
      <PageHeader
        subtitle="Cadastre quem acompanha os leads da casa, por ID de afiliado ou com acesso total."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              className="gap-2"
              {...tourAnchor("experts.header.regras-credito")}
              onClick={() => setSettingsOpen(true)}
            >
              <Settings className="h-4 w-4" />
              Regras de crédito
            </Button>
            <DemoDisabledTooltip active={isDemo}>
              <Button
                className="gap-2"
                disabled={isDemo}
                {...tourAnchor("experts.header.novo")}
                onClick={() => openCreate()}
              >
                <Plus className="h-4 w-4" />
                Novo expert
              </Button>
            </DemoDisabledTooltip>
          </div>
        }
      />

      {pendingTotal > 0 && (
        <Card id="aprovacoes" {...tourAnchor("experts.aprovacoes.card")}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Aprovações pendentes
              <Badge
                className="border-transparent bg-warning/15 text-warning shadow-none"
                aria-label={`${pendingTotal} aguardando aprovação`}
              >
                {pendingTotal}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ExpertCampaignsQueue pendingOnly emptyText="Nenhuma campanha aguardando aprovação." />
          </CardContent>
        </Card>
      )}

      <Card {...tourAnchor("experts.tabela.card")}>
        <CardHeader>
          <CardTitle>Experts{expertsQuery.data ? ` (${experts.length})` : ""}</CardTitle>
        </CardHeader>
        <CardContent>
          {expertsQuery.isError ? (
            <LoadError
              message="Não foi possível carregar os experts."
              onRetry={() => void expertsQuery.refetch()}
            />
          ) : expertsQuery.isPending ? (
            <p className="py-8 text-center text-muted-foreground">Carregando experts…</p>
          ) : experts.length === 0 ? (
            <p className="py-8 text-center text-muted-foreground">Nenhum expert cadastrado.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {/* The name stays visible while the table scrolls sideways on phones. */}
                  <TableHead className="sticky left-0 z-10 bg-card">Expert</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>IDs de afiliado</TableHead>
                  <TableHead>Leads</TableHead>
                  <TableHead>Envio</TableHead>
                  <TableHead>Teto</TableHead>
                  <TableHead>Uso do mês</TableHead>
                  <TableHead>Acesso</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {experts.map((expert, index) => {
                  const actions = rowActions(expert, index);
                  return (
                    <TableRow key={expert.id}>
                      <TableCell className="sticky left-0 z-10 bg-card font-medium">
                        <Link
                          to="/rendimento/equipe/$expertId"
                          params={{ expertId: expert.id }}
                          className="inline-flex min-h-10 items-center hover:underline sm:min-h-0"
                        >
                          {expert.nome}
                        </Link>
                      </TableCell>
                      <TableCell>{TIPO_LABEL[expert.tipo]}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {expert.affiliateIds.map((id) => (
                            <span
                              key={id}
                              className="rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-xs"
                            >
                              {id}
                            </span>
                          ))}
                          {expert.affiliateIds.length === 0 && (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>{expert.leads}</TableCell>
                      <TableCell>
                        <ExpertEnvioCell
                          expertId={expert.id}
                          envioModo={expert.envioModo}
                          pendentes={usageByExpert.get(expert.id)?.pendentes ?? 0}
                        />
                      </TableCell>
                      <TableCell>
                        <ExpertTetoCell teto={expert.tetoMensal} />
                      </TableCell>
                      <TableCell>
                        <ExpertUsageCell usage={usageByExpert.get(expert.id) ?? null} />
                      </TableCell>
                      <TableCell>
                        {acessoBadge(expert.acesso, expert.papelEquipe, expert.ativo)}
                        {expert.tipo === "restrito" && expert.acesso === "equipe" && (
                          <p className="mt-1 flex max-w-56 items-start gap-1.5 text-label text-warning">
                            <span>Vê a casa inteira: Restrito não vale para a equipe.</span>
                            {/* Full explanation by tap or hover (a `title` never shows on a phone). */}
                            <InfoTip text={RESTRITO_EQUIPE_AVISO} />
                          </p>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {/* Desktop: every action as a button. */}
                        <div className="hidden flex-wrap items-center justify-end gap-2 md:flex">
                          {actions.map((action) => (
                            <DemoDisabledTooltip key={action.key} active={isDemo}>
                              <Button
                                size="sm"
                                variant={action.destructive ? "ghost" : "outline"}
                                className={
                                  action.destructive
                                    ? "text-destructive hover:text-destructive"
                                    : undefined
                                }
                                disabled={isDemo || action.disabled}
                                {...action.anchor}
                                onClick={action.onSelect}
                              >
                                {action.label}
                              </Button>
                            </DemoDisabledTooltip>
                          ))}
                        </div>
                        {/* Phones: up to 5 buttons don't fit, so they go into one menu. */}
                        <div className="md:hidden">
                          <DemoDisabledTooltip active={isDemo}>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  size="icon"
                                  variant="outline"
                                  className="size-11"
                                  disabled={isDemo}
                                  aria-label={`Ações de ${expert.nome}`}
                                >
                                  <MoreHorizontal className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                {actions.map((action) => (
                                  <DropdownMenuItem
                                    key={action.key}
                                    className={
                                      action.destructive
                                        ? "min-h-11 text-destructive focus:text-destructive"
                                        : "min-h-11"
                                    }
                                    disabled={action.disabled}
                                    onSelect={action.onSelect}
                                  >
                                    {action.label}
                                  </DropdownMenuItem>
                                ))}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </DemoDisabledTooltip>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card {...tourAnchor("experts.sem-expert.card")}>
        <CardHeader>
          <CardTitle>IDs de afiliado sem expert</CardTitle>
        </CardHeader>
        <CardContent>
          {unassignedQuery.isError ? (
            <LoadError
              message="Não foi possível carregar os IDs de afiliado sem expert."
              onRetry={() => void unassignedQuery.refetch()}
            />
          ) : unassignedQuery.isPending ? (
            <p className="text-body text-muted-foreground">Carregando…</p>
          ) : (
            <div className="space-y-2">
              {unassigned.map((row, index) => (
                <div
                  key={row.affiliateId}
                  className="flex items-center justify-between gap-3 rounded-md border border-border/60 p-3"
                >
                  <div className="min-w-0">
                    <div className="truncate font-mono text-xs">{row.affiliateId}</div>
                    <div className="text-xs text-muted-foreground">{row.leads} leads</div>
                  </div>
                  <DemoDisabledTooltip active={isDemo}>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      disabled={isDemo}
                      {...(index === 0 ? tourAnchor("experts.sem-expert.criar") : {})}
                      onClick={() => openCreate(row.affiliateId)}
                    >
                      <UserPlus className="h-3.5 w-3.5" />
                      Criar expert
                    </Button>
                  </DemoDisabledTooltip>
                </div>
              ))}
              {unassigned.length === 0 && (
                <p className="text-sm text-muted-foreground">Nenhum ID de afiliado sem expert.</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <ExpertFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        expert={editingExpert}
        initialAffiliateId={prefillAffiliateId}
        unassignedAffiliates={unassigned}
      />
      <ExpertInviteDialog
        open={!!inviteExpertRow}
        onOpenChange={(open) => !open && setInviteExpertRow(null)}
        expertId={inviteExpertRow?.id ?? null}
        expertNome={inviteExpertRow?.nome ?? ""}
      />
      <ExpertTeamLinkDialog
        open={!!teamLinkExpertRow}
        onOpenChange={(open) => !open && setTeamLinkExpertRow(null)}
        expertId={teamLinkExpertRow?.id ?? null}
        expertNome={teamLinkExpertRow?.nome ?? ""}
        expertTipo={teamLinkExpertRow?.tipo ?? null}
      />
      <ExpertSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        janelaHoras={janelaHoras}
      />
    </Page>
  );
}
