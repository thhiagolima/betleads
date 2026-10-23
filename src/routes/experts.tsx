// Admin "Experts" screen (Área do Expert, Fase 1, Task 8): lists the house's
// experts, lets the admin create/edit, invite, remove access, deactivate and
// delete them, and surfaces affiliate ids with no expert yet. Everything
// goes through the Task 6 server functions — no direct Supabase writes from
// the browser.
import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Plus, UserPlus } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
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
import type { ExpertAcesso, ExpertAdminRow } from "@/lib/experts-admin.functions";
import {
  EXPERTS_QUERY_KEY,
  UNASSIGNED_AFFILIATES_QUERY_KEY,
} from "@/components/experts/experts-query";
import { ExpertFormDialog } from "@/components/experts/expert-form-dialog";
import { ExpertInviteDialog } from "@/components/experts/expert-invite-dialog";

export const Route = createFileRoute("/experts")({
  component: ExpertsPage,
});

const TIPO_LABEL: Record<ExpertAdminRow["tipo"], string> = {
  restrito: "Restrito",
  total: "Acesso total",
};

function acessoBadge(acesso: ExpertAcesso) {
  switch (acesso) {
    case "sem_acesso":
      return <Badge variant="outline">Sem acesso</Badge>;
    case "convite_pendente":
      return <Badge className="bg-info/15 text-info">Convite pendente</Badge>;
    case "ativo":
      return <Badge className="bg-success/15 text-success">Ativo</Badge>;
    case "inativo":
      return <Badge variant="destructive">Inativo</Badge>;
  }
}

function ExpertsPage() {
  const isDemo = useIsDemoTenant();
  const qc = useQueryClient();

  const listExpertsFn = useServerFn(listExperts);
  const listUnassignedFn = useServerFn(listUnassignedAffiliates);
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

  const experts = expertsQuery.data ?? [];
  const unassigned = unassignedQuery.data ?? [];

  const [formOpen, setFormOpen] = useState(false);
  const [editingExpert, setEditingExpert] = useState<ExpertAdminRow | null>(null);
  const [prefillAffiliateId, setPrefillAffiliateId] = useState<string | null>(null);
  const [inviteExpertRow, setInviteExpertRow] = useState<ExpertAdminRow | null>(null);

  function refresh() {
    qc.invalidateQueries({ queryKey: EXPERTS_QUERY_KEY });
    qc.invalidateQueries({ queryKey: UNASSIGNED_AFFILIATES_QUERY_KEY });
  }

  const removeAccess = useMutation({
    mutationFn: (expertId: string) => removeAccessFn({ data: { expertId } }),
    onSuccess: () => {
      toast.success("Acesso removido");
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

  return (
    <Page>
      <PageHeader
        subtitle="Cadastre quem acompanha os leads da casa, por ID de afiliado ou com acesso total."
        actions={
          <DemoDisabledTooltip active={isDemo}>
            <Button className="gap-2" disabled={isDemo} onClick={() => openCreate()}>
              <Plus className="h-4 w-4" />
              Novo expert
            </Button>
          </DemoDisabledTooltip>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Experts ({experts.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Expert</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>IDs de afiliado</TableHead>
                <TableHead>Leads</TableHead>
                <TableHead>Acesso</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {experts.map((expert) => (
                <TableRow key={expert.id}>
                  <TableCell className="font-medium">{expert.nome}</TableCell>
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
                  <TableCell>{acessoBadge(expert.acesso)}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <DemoDisabledTooltip active={isDemo}>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={isDemo}
                          onClick={() => openEdit(expert)}
                        >
                          Editar
                        </Button>
                      </DemoDisabledTooltip>

                      {expert.acesso === "sem_acesso" && (
                        <DemoDisabledTooltip active={isDemo}>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={isDemo}
                            onClick={() => setInviteExpertRow(expert)}
                          >
                            Convidar
                          </Button>
                        </DemoDisabledTooltip>
                      )}

                      {expert.acesso !== "sem_acesso" && (
                        <DemoDisabledTooltip active={isDemo}>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={isDemo || removeAccess.isPending}
                            onClick={async () => {
                              const confirmed = await requestConfirmation({
                                title: `Remover o acesso de ${expert.nome}?`,
                                description:
                                  "A pessoa perde o acesso a esta casa imediatamente. O cadastro do expert continua existindo.",
                                confirmLabel: "Remover acesso",
                                destructive: true,
                              });
                              if (confirmed) removeAccess.mutate(expert.id);
                            }}
                          >
                            Remover acesso
                          </Button>
                        </DemoDisabledTooltip>
                      )}

                      <DemoDisabledTooltip active={isDemo}>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={isDemo || toggleActive.isPending}
                          onClick={() =>
                            toggleActive.mutate({ expertId: expert.id, ativo: !expert.ativo })
                          }
                        >
                          {expert.ativo ? "Desativar" : "Ativar"}
                        </Button>
                      </DemoDisabledTooltip>

                      {expert.acesso === "sem_acesso" && (
                        <DemoDisabledTooltip active={isDemo}>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            disabled={isDemo || remove.isPending}
                            onClick={async () => {
                              const confirmed = await requestConfirmation({
                                title: `Excluir o expert ${expert.nome}?`,
                                description:
                                  "O cadastro e os IDs de afiliado vinculados a ele deixam de existir. Esta ação não pode ser desfeita.",
                                confirmLabel: "Excluir expert",
                                destructive: true,
                              });
                              if (confirmed) remove.mutate(expert.id);
                            }}
                          >
                            Excluir
                          </Button>
                        </DemoDisabledTooltip>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {experts.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    Nenhum expert cadastrado.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>IDs de afiliado sem expert</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {unassigned.map((row) => (
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
                    onClick={() => openCreate(row.affiliateId)}
                  >
                    <UserPlus className="h-3.5 w-3.5" />
                    Criar expert
                  </Button>
                </DemoDisabledTooltip>
              </div>
            ))}
            {unassigned.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Nenhum ID de afiliado sem expert.
              </p>
            )}
          </div>
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
    </Page>
  );
}
