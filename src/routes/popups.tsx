import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { BarChart3, Copy, MoreHorizontal, PanelTop, Pause, Pencil, Play, Plus, Square, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { PopupEditor } from "@/components/popups/popup-editor";
import { POPUPS_QUERY_KEY } from "@/components/popups/popups-query";
import { requestConfirmation } from "@/components/system-dialog-host";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DataCard } from "@/components/ui-premium/data-card";
import { EmptyState } from "@/components/ui-premium/empty-state";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { tourAnchor } from "@/help/anchor";
import { num } from "@/lib/format";
import {
  deletePopupFn,
  duplicatePopupFn,
  getPopupsOverviewFn,
  getPopupStatsFn,
  setPopupStatusFn,
} from "@/lib/popups/popups.functions";
import type { PopupListItem } from "@/lib/popups/popups.server";
import { POPUP_AUDIENCE_LABELS, POPUP_FORMAT_LABELS, POPUP_STATUS_LABELS, type PopupStatus } from "@/lib/popups/shared";

export const Route = createFileRoute("/popups")({ component: PopupsPage });

const STATUS_VARIANT: Record<PopupStatus, string> = {
  ativo: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  pausado: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  rascunho: "border-border bg-muted/40 text-muted-foreground",
  encerrado: "border-border bg-transparent text-muted-foreground",
};

const dateFmt = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function period(item: PopupListItem): string {
  if (!item.startsAt && !item.endsAt) return "Sem data de fim";
  if (item.startsAt && item.endsAt)
    return `${dateFmt.format(new Date(item.startsAt))} até ${dateFmt.format(new Date(item.endsAt))}`;
  if (item.startsAt) return `A partir de ${dateFmt.format(new Date(item.startsAt))}`;
  return `Até ${dateFmt.format(new Date(item.endsAt!))}`;
}

function rate(cliques: number, exibicoes: number): string {
  if (!exibicoes) return "—";
  return `${((cliques / exibicoes) * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
}

function audienceText(item: PopupListItem): string {
  if (item.audienceKind !== "filtro") return POPUP_AUDIENCE_LABELS[item.audienceKind];
  const base = item.audienceLabel ? `Público: ${item.audienceLabel}` : POPUP_AUDIENCE_LABELS.filtro;
  return item.audienceCount !== null ? `${base} (${num(item.audienceCount)})` : base;
}

function PopupsPage() {
  const queryClient = useQueryClient();
  const overviewFn = useServerFn(getPopupsOverviewFn);
  const setStatusFn = useServerFn(setPopupStatusFn);
  const duplicateFn = useServerFn(duplicatePopupFn);
  const deleteFn = useServerFn(deletePopupFn);

  const overview = useQuery({ queryKey: POPUPS_QUERY_KEY, queryFn: () => overviewFn() });
  const [editor, setEditor] = useState<{ open: boolean; id: string | null }>({ open: false, id: null });
  const [statsFor, setStatsFor] = useState<PopupListItem | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: POPUPS_QUERY_KEY });
  const onError = (error: unknown) =>
    toast.error(error instanceof Error ? error.message : "Não foi possível concluir a ação.");

  const changeStatus = useMutation({
    mutationFn: (input: { id: string; status: PopupStatus }) => setStatusFn({ data: input }),
    onSuccess: async (result) => {
      await refresh();
      toast.success(
        result.status === "ativo"
          ? "Popup ativo. Ele começa a aparecer no site em até 5 minutos."
          : result.status === "pausado"
            ? "Popup pausado. Ele some do site em até 5 minutos."
            : "Popup encerrado.",
      );
    },
    onError,
  });
  const duplicate = useMutation({
    mutationFn: (id: string) => duplicateFn({ data: { id } }),
    onSuccess: async (result) => {
      await refresh();
      toast.success("Cópia criada como rascunho.");
      setEditor({ open: true, id: result.id });
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { id } }),
    onSuccess: async () => {
      await refresh();
      toast.success("Rascunho apagado.");
    },
    onError,
  });

  const data = overview.data;
  const canEdit = Boolean(data?.canEdit);

  async function confirmEnd(item: PopupListItem) {
    const ok = await requestConfirmation({
      title: "Encerrar popup?",
      description: `“${item.nome}” sai do site e não pode mais ser alterado nem reativado. Os números ficam guardados. Para usar de novo, duplique.`,
      confirmLabel: "Encerrar",
      destructive: true,
    });
    if (ok) changeStatus.mutate({ id: item.id, status: "encerrado" });
  }

  async function confirmDelete(item: PopupListItem) {
    const ok = await requestConfirmation({
      title: "Apagar rascunho?",
      description: `“${item.nome}” será apagado.`,
      confirmLabel: "Apagar",
      destructive: true,
    });
    if (ok) remove.mutate(item.id);
  }

  return (
    <Page>
      <PageHeader
        subtitle="Avisos e promoções que aparecem dentro do site da casa. Você escolhe o conteúdo, quem vê, em quais páginas e com que frequência."
        actions={
          canEdit && data?.install.installed ? (
            <Button size="sm" onClick={() => setEditor({ open: true, id: null })} {...tourAnchor("popups.novo")}>
              <Plus className="h-4 w-4" /> Novo popup
            </Button>
          ) : null
        }
      />

      {overview.isLoading ? (
        <Skeleton className="h-48 w-full rounded-2xl" />
      ) : overview.isError || !data ? (
        <EmptyState title="Não foi possível carregar os popups" description="Tente de novo em instantes." />
      ) : !data.enabled ? (
        <EmptyState
          icon={<PanelTop className="h-6 w-6" />}
          title="Popups não estão liberados para esta casa"
          description="Fale com o suporte da Betleads para liberar."
        />
      ) : (
        <div className="space-y-4">
          <InstallCard install={data.install} />

          {data.popups.length === 0 ? (
            <EmptyState
              icon={<PanelTop className="h-6 w-6" />}
              title="Nenhum popup ainda"
              description={
                data.install.installed
                  ? "Crie o primeiro: ele começa como rascunho e só aparece no site quando você ativar."
                  : "Assim que o script estiver no site, você poderá criar popups."
              }
              action={
                canEdit && data.install.installed ? (
                  <Button size="sm" onClick={() => setEditor({ open: true, id: null })}>
                    <Plus className="h-4 w-4" /> Novo popup
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <DataCard
              title="Popups da casa"
              description="Números dos últimos 7 dias. Exibição = o popup apareceu na tela de alguém; clique = a pessoa clicou no botão."
            >
              <div className="overflow-x-auto" {...tourAnchor("popups.lista")}>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Popup</TableHead>
                      <TableHead>Situação</TableHead>
                      <TableHead className="hidden md:table-cell">Quem vê</TableHead>
                      <TableHead className="hidden lg:table-cell">Período</TableHead>
                      <TableHead className="text-right">Exibições</TableHead>
                      <TableHead className="text-right">Cliques</TableHead>
                      <TableHead className="hidden text-right sm:table-cell">Taxa de clique</TableHead>
                      <TableHead className="w-10">
                        <span className="sr-only">Ações</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.popups.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell>
                          <button
                            type="button"
                            className="text-left font-medium text-foreground hover:underline"
                            onClick={() => setEditor({ open: true, id: item.id })}
                          >
                            {item.nome}
                          </button>
                          <p className="text-meta text-muted-foreground">
                            {POPUP_FORMAT_LABELS[item.formato]} · prioridade {item.prioridade}
                          </p>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={STATUS_VARIANT[item.status]}>
                            {item.aguardandoInicio ? "Agendado" : POPUP_STATUS_LABELS[item.status]}
                          </Badge>
                        </TableCell>
                        <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                          {audienceText(item)}
                        </TableCell>
                        <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">
                          {period(item)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{num(item.ultimos7Dias.exibicoes)}</TableCell>
                        <TableCell className="text-right tabular-nums">{num(item.ultimos7Dias.cliques)}</TableCell>
                        <TableCell className="hidden text-right tabular-nums sm:table-cell">
                          {rate(item.ultimos7Dias.cliques, item.ultimos7Dias.exibicoes)}
                        </TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" aria-label={`Ações de ${item.nome}`}>
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => setEditor({ open: true, id: item.id })}>
                                <Pencil className="h-4 w-4" /> {item.status === "encerrado" || !canEdit ? "Ver" : "Editar"}
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => setStatsFor(item)}>
                                <BarChart3 className="h-4 w-4" /> Números por dia
                              </DropdownMenuItem>
                              {canEdit ? (
                                <>
                                  {item.status === "rascunho" || item.status === "pausado" ? (
                                    <DropdownMenuItem
                                      onClick={() => changeStatus.mutate({ id: item.id, status: "ativo" })}
                                    >
                                      <Play className="h-4 w-4" /> Ativar
                                    </DropdownMenuItem>
                                  ) : null}
                                  {item.status === "ativo" ? (
                                    <DropdownMenuItem
                                      onClick={() => changeStatus.mutate({ id: item.id, status: "pausado" })}
                                    >
                                      <Pause className="h-4 w-4" /> Pausar
                                    </DropdownMenuItem>
                                  ) : null}
                                  <DropdownMenuItem onClick={() => duplicate.mutate(item.id)}>
                                    <Copy className="h-4 w-4" /> Duplicar
                                  </DropdownMenuItem>
                                  {item.status !== "encerrado" ? <DropdownMenuSeparator /> : null}
                                  {item.status === "rascunho" ? (
                                    <DropdownMenuItem className="text-destructive" onClick={() => void confirmDelete(item)}>
                                      <Trash2 className="h-4 w-4" /> Apagar
                                    </DropdownMenuItem>
                                  ) : item.status !== "encerrado" ? (
                                    <DropdownMenuItem className="text-destructive" onClick={() => void confirmEnd(item)}>
                                      <Square className="h-4 w-4" /> Encerrar
                                    </DropdownMenuItem>
                                  ) : null}
                                </>
                              ) : null}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </DataCard>
          )}
        </div>
      )}

      <PopupEditor
        open={editor.open}
        popupId={editor.id}
        playerIdSeen={Boolean(data?.install.playerIdSeen)}
        canEdit={canEdit}
        onOpenChange={(open) => setEditor((current) => ({ ...current, open }))}
      />
      <PopupStatsDialog item={statsFor} onClose={() => setStatsFor(null)} />
    </Page>
  );
}

function InstallCard({
  install,
}: {
  install: {
    installed: boolean;
    scriptSeenAt: string | null;
    playerIdSeen: boolean;
    origins: string[];
    loaderSnippet: string;
    playerSnippet: string;
  };
}) {
  if (!install.installed) {
    return (
      <DataCard
        title="O script ainda não está no site"
        description="Os popups usam o mesmo script do web push. Peça ao suporte da Betleads para ativar o web push da casa e siga a instalação em Integrações → Web Push. Depois disso, nada mais precisa mudar no site."
      />
    );
  }
  return (
    <div
      className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-border/60 bg-background/40 px-4 py-3 text-sm"
      {...tourAnchor("popups.instalacao")}
    >
      <span className="text-muted-foreground">
        Site:{" "}
        <span className="font-medium text-foreground">{install.origins.join(", ") || "—"}</span>
      </span>
      <span className="text-muted-foreground">
        Script visto pela primeira vez:{" "}
        <span className="font-medium text-foreground">
          {install.scriptSeenAt ? dateFmt.format(new Date(install.scriptSeenAt)) : "ainda não"}
        </span>
      </span>
      <span className="text-muted-foreground">
        Jogador logado informado pelo site:{" "}
        <span className={install.playerIdSeen ? "font-medium text-emerald-300" : "font-medium text-amber-300"}>
          {install.playerIdSeen ? "sim" : "ainda não"}
        </span>
      </span>
    </div>
  );
}

function PopupStatsDialog({ item, onClose }: { item: PopupListItem | null; onClose: () => void }) {
  const statsFn = useServerFn(getPopupStatsFn);
  const stats = useQuery({
    queryKey: ["popup-stats", item?.id],
    queryFn: () => statsFn({ data: { id: item!.id, days: 30 } }),
    enabled: Boolean(item),
  });
  const points = [...(stats.data ?? [])].reverse();
  const totals = points.reduce(
    (acc, p) => ({
      exibicoes: acc.exibicoes + p.exibicoes,
      cliques: acc.cliques + p.cliques,
      fechamentos: acc.fechamentos + p.fechamentos,
    }),
    { exibicoes: 0, cliques: 0, fechamentos: 0 },
  );
  const dayFmt = (dia: string) => dia.split("-").reverse().slice(0, 2).join("/");

  return (
    <Dialog open={Boolean(item)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{item?.nome}</DialogTitle>
          <DialogDescription>
            Últimos 30 dias, por dia (horário de Brasília). Fechamento = a pessoa fechou no “×”, clicou fora ou
            apertou Esc.
          </DialogDescription>
        </DialogHeader>
        {stats.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Dia</TableHead>
                <TableHead className="text-right">Exibições</TableHead>
                <TableHead className="text-right">Cliques</TableHead>
                <TableHead className="text-right">Fechamentos</TableHead>
                <TableHead className="text-right">Taxa de clique</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow className="font-semibold">
                <TableCell>Total</TableCell>
                <TableCell className="text-right tabular-nums">{num(totals.exibicoes)}</TableCell>
                <TableCell className="text-right tabular-nums">{num(totals.cliques)}</TableCell>
                <TableCell className="text-right tabular-nums">{num(totals.fechamentos)}</TableCell>
                <TableCell className="text-right tabular-nums">{rate(totals.cliques, totals.exibicoes)}</TableCell>
              </TableRow>
              {points.map((p) => (
                <TableRow key={p.dia}>
                  <TableCell>{dayFmt(p.dia)}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(p.exibicoes)}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(p.cliques)}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(p.fechamentos)}</TableCell>
                  <TableCell className="text-right tabular-nums">{rate(p.cliques, p.exibicoes)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </DialogContent>
    </Dialog>
  );
}
