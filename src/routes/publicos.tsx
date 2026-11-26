import { createFileRoute } from "@tanstack/react-router";
import { FILTER_GROUP_DOT, INACTIVITY_DOT, LEVEL_IDENTITY } from "@/components/identity/identity";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  Copy,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Users,
  Workflow,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  AudienceRow,
  countNoun,
  LevelTile,
  RuleChip,
  RuleGroup,
  type AudienceCount,
} from "@/components/audiences/audience-parts";
import { criteriaLabels } from "@/components/audiences/criteria-labels";
import { HomeCard } from "@/components/home/home-cards";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { requestConfirmation } from "@/components/system-dialog-host";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useCampaignDataSource } from "@/hooks/use-campaign-data-source";
import type { CampaignAudienceRow } from "@/lib/campaign-data-source";
import { resolveExpertCampaignAudience } from "@/lib/expert-campaigns.functions";
import { getExpertHome } from "@/lib/expert-leads.functions";
import {
  resolveSmsCampaignAudience,
  type ResolvedSmsAudience,
} from "@/lib/sms-audiences.functions";
import {
  describeSmsAudience,
  EMPTY_SMS_AUDIENCE,
  isSelectionAudience,
  DEAD_LEADS_SYSTEM_AUDIENCE_ID,
  normalizeSmsAudienceCriteria,
  SYSTEM_SMS_AUDIENCES,
  type SmsAudienceCriteria,
} from "@/lib/sms-audience-criteria";
import { useEnabledChannels } from "@/hooks/use-enabled-channels";
import { tourAnchor } from "@/help/anchor";
import { Term } from "@/components/help/term";

export const Route = createFileRoute("/publicos")({ component: PublicosPage });

type SavedAudience = CampaignAudienceRow;

/** Preview of the rules; the expert's adds the per-channel counts of their leads. */
type AudiencePreview = ResolvedSmsAudience & { emailEligible?: number };

type Level = NonNullable<SmsAudienceCriteria["level"]>;
type Timing = "cooling" | "sleeping" | "inactive30" | "inactive90";

const LEVEL_RULES: Array<{ value: Level; label: string }> = [
  { value: "bronze", label: "Bronze" },
  { value: "silver", label: "Prata" },
  { value: "gold", label: "Ouro" },
  { value: "diamond", label: "Diamante" },
  { value: "black", label: "Black VIP" },
];

const TIMING_RULES: Array<{ value: Timing; label: string }> = [
  { value: "cooling", label: "Esfriando" },
  { value: "sleeping", label: "Dormindo" },
  { value: "inactive30", label: "30+ dias" },
  { value: "inactive90", label: "90+ dias" },
];

/** Level icon in the level colour, as on the player list. */
function LevelMarker({ level }: { level: Level }) {
  const tone = LEVEL_IDENTITY[level];
  const Icon = tone.icon;
  return <Icon className={`size-3.5 shrink-0 ${tone.text}`} aria-hidden="true" />;
}

function PublicosPage() {
  const qc = useQueryClient();
  // Same screen for the house and the expert (campaign-data-source.ts): the
  // expert lists/saves their own audiences, sees the house's read-only, and
  // the server limits every count to their leads.
  const source = useCampaignDataSource();
  const { isEnabled } = useEnabledChannels();
  const isExpert = source.isExpert;
  const listFn = source.listAudiences;
  const saveFn = source.saveAudience;
  const deleteFn = source.deleteAudience;
  const resolveFn = useServerFn(resolveSmsCampaignAudience);
  const resolveExpertFn = useServerFn(resolveExpertCampaignAudience);
  const expertHomeFn = useServerFn(getExpertHome);
  const audiencesKey = source.queryKeys.audiences;
  const audiences = useQuery({ queryKey: audiencesKey, queryFn: () => listFn() });
  // Same key as the expert home: access type and how many leads they have.
  const expertHome = useQuery({
    queryKey: ["expert-home"],
    queryFn: () => expertHomeFn(),
    enabled: isExpert,
  });
  // The editor is a side panel: the library (pick an audience, see its size)
  // is what the screen is for most of the time.
  const [editorOpen, setEditorOpen] = useState(false);
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [criteria, setCriteria] = useState<SmsAudienceCriteria>(EMPTY_SMS_AUDIENCE);
  const [previewWaiting, setPreviewWaiting] = useState(true);
  const previewVersion = useRef(0);

  const preview = useMutation({
    mutationFn: async (next: SmsAudienceCriteria): Promise<AudiencePreview> => {
      if (!isExpert) return resolveFn({ data: { criteria: next } });
      // Counts only, in the expert's scope: one call per channel shown.
      const criteria = next as unknown as Record<string, unknown>;
      const [sms, email] = await Promise.all([
        resolveExpertFn({ data: { criteria, channel: "sms" } }),
        resolveExpertFn({ data: { criteria, channel: "email" } }),
      ]);
      return { ...sms, recipientTotal: sms.eligibleTotal, emailEligible: email.eligibleTotal };
    },
  });

  useEffect(() => {
    const version = ++previewVersion.current;
    setPreviewWaiting(true);
    const timer = window.setTimeout(
      () =>
        preview.mutate(criteria, {
          onSettled: () => {
            if (previewVersion.current === version) setPreviewWaiting(false);
          },
        }),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [criteria]);

  const save = useMutation({
    mutationFn: () => saveFn({ data: { id: editingId ?? undefined, name, description, criteria } }),
    onSuccess: () => {
      toast.success(editingId ? "Público atualizado" : "Público criado");
      qc.invalidateQueries({ queryKey: audiencesKey });
      setEditorOpen(false);
      reset();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Público excluído");
      qc.invalidateQueries({ queryKey: audiencesKey });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  function reset() {
    setEditingId(null);
    setName("");
    setDescription("");
    setCriteria(EMPTY_SMS_AUDIENCE);
  }

  function edit(row: SavedAudience) {
    setEditingId(row.id);
    // Público de seleção: só renomear; a lista de jogadores não se mistura com regras.
    setName(row.name);
    setDescription(row.description ?? "");
    setCriteria(normalizeSmsAudienceCriteria(row.criteria));
    setEditorOpen(true);
  }

  function duplicate(row: SavedAudience) {
    setEditingId(null);
    setName(`${row.name} — cópia`);
    setDescription(row.description ?? "");
    setCriteria(normalizeSmsAudienceCriteria(row.criteria));
    setEditorOpen(true);
  }

  function startNew() {
    reset();
    setEditorOpen(true);
  }

  function setActivity<K extends keyof SmsAudienceCriteria["activity"]>(
    key: K,
    value: SmsAudienceCriteria["activity"][K],
  ) {
    setCriteria((current) => {
      const nextValue =
        current.activity[key] === value ? (typeof value === "boolean" ? false : "any") : value;
      return {
        ...current,
        activity: { ...current.activity, [key]: nextValue },
        ...(key === "deposit" && nextValue === "never"
          ? { level: null, timing: "any" as const }
          : {}),
      };
    });
  }

  const calculating = previewWaiting || preview.isPending;
  const editingSelection = isSelectionAudience(criteria);
  const facets = preview.data?.facets;
  const neverDeposited = criteria.activity.deposit === "never";
  const allAudiences = (audiences.data ?? []) as SavedAudience[];
  // The expert's own audiences; the house's (total-access expert) are listed apart, read-only.
  const savedAudiences = allAudiences.filter((row) => row.owner !== "casa");
  const houseAudiences = isExpert ? allAudiences.filter((row) => row.owner === "casa") : [];
  const home = expertHome.data as { tipo: "restrito" | "total"; totalLeads: number } | undefined;
  const restricted = isExpert && home?.tipo === "restrito";
  const noLeads = isExpert && home !== undefined && home.totalLeads === 0;
  const noun = isExpert ? "lead" : "jogador";

  // --- Sizes shown in the library -------------------------------------------
  // Same server calls as the editor preview (and the same 30 s server cache):
  // one per audience, recalculated again at send time.
  const countScope = isExpert ? "expert" : "house";
  async function countFor(next: SmsAudienceCriteria) {
    if (!isExpert) {
      const result = await resolveFn({ data: { criteria: next } });
      return { total: result.total, reachable: result.recipientTotal, facets: result.facets };
    }
    const result = await resolveExpertFn({
      data: { criteria: next as unknown as Record<string, unknown>, channel: "sms" },
    });
    return { total: result.total, reachable: result.eligibleTotal, facets: result.facets };
  }
  // "Todos" and the five loyalty levels come from one call: the empty rules
  // return the whole base and its per-level facets.
  const baseCount = useQuery({
    queryKey: ["audience-count", countScope, "base"],
    queryFn: () => countFor(EMPTY_SMS_AUDIENCE),
    staleTime: 60_000,
  });
  const listed = [...savedAudiences, ...houseAudiences];
  const deadLeadsAudience = SYSTEM_SMS_AUDIENCES.find(
    (audience) => audience.id === DEAD_LEADS_SYSTEM_AUDIENCE_ID,
  );
  const countTargets = [
    ...(deadLeadsAudience
      ? [{ id: deadLeadsAudience.id, criteria: deadLeadsAudience.criteria }]
      : []),
    ...listed.map((row) => ({ id: row.id, criteria: normalizeSmsAudienceCriteria(row.criteria) })),
  ];
  const countQueries = useQueries({
    queries: countTargets.map((target) => ({
      queryKey: ["audience-count", countScope, target.id, JSON.stringify(target.criteria)],
      queryFn: () => countFor(target.criteria),
      staleTime: 60_000,
    })),
  });
  const countById = new Map(countTargets.map((target, i) => [target.id, countQueries[i]]));
  const reachableLabel = "com celular";
  function countOf(id: string): { count: AudienceCount; error: boolean } {
    const query = id === "base" ? baseCount : countById.get(id);
    if (!query?.data) return { count: null, error: Boolean(query?.isError) };
    return {
      count: { total: query.data.total, reachable: query.data.reachable, reachableLabel },
      error: false,
    };
  }
  const countsFetching = baseCount.isFetching || countQueries.some((query) => query.isFetching);
  const countedAt = useMemo(
    () => (baseCount.dataUpdatedAt ? new Date(baseCount.dataUpdatedAt) : null),
    [baseCount.dataUpdatedAt],
  );

  const term = search.trim().toLowerCase();
  const visibleSaved = term
    ? savedAudiences.filter((row) => row.name.toLowerCase().includes(term))
    : savedAudiences;
  const allLeadsAudience = SYSTEM_SMS_AUDIENCES.find(
    (audience) => audience.id === "system:all-leads",
  );
  const levelAudiences = SYSTEM_SMS_AUDIENCES.filter((audience) => audience.criteria.level);

  function rulesSummary(row: SavedAudience) {
    return criteriaLabels(normalizeSmsAudienceCriteria(row.criteria)).join(" · ");
  }

  // --- Live size in the editor footer ----------------------------------------
  const previewLine = calculating
    ? "Calculando…"
    : preview.data
      ? isExpert
        ? `${countNoun(preview.data.total, "lead")} · ${preview.data.recipientTotal.toLocaleString("pt-BR")} com celular${
            isEnabled("email")
              ? ` · ${(preview.data.emailEligible ?? 0).toLocaleString("pt-BR")} com e-mail`
              : ""
          }`
        : `${countNoun(preview.data.total, "jogador")} · ${preview.data.recipientTotal.toLocaleString("pt-BR")} com celular`
      : "";
  const missingPhones =
    !calculating && preview.data && !isExpert
      ? preview.data.total - preview.data.recipientTotal
      : 0;

  return (
    <Page>
      <PageHeader
        subtitle={
          isExpert
            ? `Separe seus leads em grupos para mandar campanhas mais certeiras.${
                restricted ? " (leads dos seus IDs de afiliado)" : ""
              }`
            : "Separe seus jogadores em grupos para mandar campanhas mais certeiras."
        }
        actions={
          <Button className="h-10 sm:h-9" onClick={startNew} {...tourAnchor("publicos.novo")}>
            <Plus className="size-4" aria-hidden="true" />
            Novo público
          </Button>
        }
      />

      {noLeads ? (
        <p
          className="rounded-xl border border-warning/40 bg-warning/10 p-3.5 text-body text-foreground"
          role="status"
        >
          {restricted
            ? "Você ainda não tem leads na sua carteira: seu acesso é restrito aos seus IDs de afiliado e nenhum lead chegou por eles. Se seus IDs ainda não foram cadastrados, fale com o admin da casa."
            : "Você ainda não tem leads na sua carteira. Os públicos ficam vazios até chegarem leads."}
        </p>
      ) : null}

      <HomeCard className="min-w-0 space-y-6 p-4 sm:p-5">
        {/* ---------------------------------------------------- Prontos para usar */}
        <section className="space-y-2" aria-labelledby="system-audiences-title">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 id="system-audiences-title" className="text-section">
                Prontos para usar
              </h2>
              <p className="mt-0.5 text-body text-muted-foreground">
                Atualizados sozinhos, conforme o comportamento{" "}
                {isExpert ? "dos seus leads" : "dos jogadores"}.
              </p>
            </div>
            <div className="flex items-center gap-2 text-meta text-muted-foreground">
              {countedAt && !countsFetching && (
                <span>
                  Contado às{" "}
                  {countedAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="text-meta"
                disabled={countsFetching}
                onClick={() => qc.invalidateQueries({ queryKey: ["audience-count"] })}
              >
                <RefreshCw
                  className={countsFetching ? "size-3.5 animate-spin" : "size-3.5"}
                  aria-hidden="true"
                />
                {countsFetching ? "Contando…" : "Recontar"}
              </Button>
            </div>
          </div>

          <ul className="divide-y divide-border/70">
            {allLeadsAudience && (
              <AudienceRow
                audienceId={allLeadsAudience.id}
                name={isExpert ? "Todos os seus leads" : allLeadsAudience.name}
                summary={
                  isExpert ? "Toda a sua carteira" : "Todos os jogadores cadastrados na casa"
                }
                count={countOf("base").count}
                countError={countOf("base").error}
                noun={noun}
                rowAnchor={tourAnchor("publicos.automaticos.cartao")}
                menuAnchor={tourAnchor("publicos.automaticos.menu")}
                menu={
                  // Jornadas are a house page: no "Usar em jornada" for the expert.
                  isExpert
                    ? undefined
                    : [
                        {
                          label: "Usar em jornada",
                          icon: <Workflow className="size-4" aria-hidden="true" />,
                          to: "/jornadas/nova",
                          search: { audience: "system:all-leads" },
                        },
                      ]
                }
              />
            )}
            <li className="space-y-2 py-3.5">
              <div>
                <h3 className="text-body font-semibold">Por nível de fidelização</h3>
                <p className="mt-0.5 text-meta text-muted-foreground">
                  Toque num nível para mandar uma campanha para ele.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
                {levelAudiences.map((audience, index) => {
                  const level = audience.criteria.level as Level;
                  const levelCount = baseCount.data?.facets?.levels?.[level];
                  return (
                    <LevelTile
                      key={audience.id}
                      audienceId={audience.id}
                      name={audience.name}
                      icon={<LevelMarker level={level} />}
                      count={baseCount.data ? (levelCount ?? 0) : null}
                      noun={noun}
                      tourProps={
                        index === 0 ? tourAnchor("publicos.automaticos.niveis") : undefined
                      }
                    />
                  );
                })}
              </div>
            </li>
            {deadLeadsAudience && (
              <AudienceRow
                audienceId={deadLeadsAudience.id}
                name="Leads mortos"
                summary="Receberam várias mensagens de jornada seguidas sem nenhuma ação na casa"
                count={countOf(deadLeadsAudience.id).count}
                countError={countOf(deadLeadsAudience.id).error}
                noun={noun}
              />
            )}
          </ul>
        </section>

        {/* -------------------------------------------------------- Seus públicos */}
        <section
          className="space-y-2 border-t border-border/70 pt-5"
          aria-labelledby="saved-audiences-title"
        >
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 id="saved-audiences-title" className="text-section">
                Seus públicos
              </h2>
              <p className="mt-0.5 text-body text-muted-foreground">
                Grupos que você montou. No envio, a lista é contada de novo.
              </p>
            </div>
            {savedAudiences.length > 5 && (
              <div className="relative w-full sm:w-64">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Buscar público"
                  aria-label="Buscar público pelo nome"
                  className="h-10 pl-9 sm:h-9"
                />
              </div>
            )}
          </div>
          {audiences.isFetching && !audiences.isLoading && (
            <p className="flex items-center gap-2 text-meta text-muted-foreground" role="status">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> Atualizando públicos…
            </p>
          )}
          {audiences.isLoading && (
            <p className="py-6 text-center text-body text-muted-foreground">Carregando públicos…</p>
          )}
          {audiences.isError && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 p-3 text-body text-destructive">
              <span>Não foi possível carregar os públicos: {audiences.error.message}</span>
              <Button variant="outline" size="sm" onClick={() => void audiences.refetch()}>
                Tentar novamente
              </Button>
            </div>
          )}
          {!audiences.isLoading && !audiences.isError && savedAudiences.length === 0 && (
            <div className="space-y-3 rounded-xl border border-dashed border-border p-6 text-center">
              <p className="text-body text-muted-foreground">
                {isExpert
                  ? "Você ainda não criou públicos. Monte um com as regras que quiser e use nas suas campanhas."
                  : "Você ainda não criou públicos. Monte um com as regras que quiser — por exemplo, quem só fez o 1º depósito — e use nas campanhas."}
              </p>
              <Button variant="outline" className="h-10 sm:h-9" onClick={startNew}>
                <Plus className="size-4" aria-hidden="true" />
                Criar meu primeiro público
              </Button>
            </div>
          )}
          {term && visibleSaved.length === 0 && savedAudiences.length > 0 && (
            <p className="py-4 text-center text-body text-muted-foreground">
              Nenhum público com “{search.trim()}” no nome.
            </p>
          )}
          <ul className="divide-y divide-border/70">
            {visibleSaved.map((audience, index) => {
              const audienceCriteria = normalizeSmsAudienceCriteria(audience.criteria);
              const selection = isSelectionAudience(audienceCriteria);
              const { count, error } = countOf(audience.id);
              return (
                <AudienceRow
                  key={audience.id}
                  audienceId={audience.id}
                  name={audience.name}
                  summary={rulesSummary(audience)}
                  description={audience.description}
                  count={count}
                  countError={error}
                  noun={noun}
                  rowAnchor={index === 0 ? tourAnchor("publicos.lista.cartao") : undefined}
                  actionAnchor={
                    index === 0 ? tourAnchor("publicos.lista.usar-campanha") : undefined
                  }
                  menuAnchor={index === 0 ? tourAnchor("publicos.lista.menu") : undefined}
                  menu={[
                    {
                      label: selection ? "Renomear" : "Editar",
                      icon: <Pencil className="size-4" aria-hidden="true" />,
                      onSelect: () => edit(audience),
                    },
                    // Duplicar abre o editor de regras; não vale para uma lista de jogadores.
                    ...(selection
                      ? []
                      : [
                          {
                            label: "Duplicar",
                            icon: <Copy className="size-4" aria-hidden="true" />,
                            onSelect: () => duplicate(audience),
                          },
                        ]),
                    {
                      label: "Excluir",
                      icon: <Trash2 className="size-4" aria-hidden="true" />,
                      destructive: true,
                      onSelect: async () => {
                        const confirmed = await requestConfirmation({
                          title: `Excluir “${audience.name}”?`,
                          description:
                            "O público será removido da sua lista. Campanhas já enviadas não serão alteradas.",
                          confirmLabel: "Excluir público",
                          destructive: true,
                        });
                        if (confirmed) remove.mutate(audience.id);
                      },
                    },
                  ]}
                />
              );
            })}
          </ul>
        </section>

        {houseAudiences.length > 0 ? (
          <section
            className="space-y-2 border-t border-border/70 pt-5"
            aria-labelledby="house-audiences-title"
          >
            <div>
              <h2 id="house-audiences-title" className="text-section">
                Públicos da casa
              </h2>
              <p className="mt-0.5 text-body text-muted-foreground">
                Criados pela casa. Use nas suas campanhas ou duplique para ajustar; só os seus leads
                entram no envio.
              </p>
            </div>
            <ul className="divide-y divide-border/70">
              {houseAudiences.map((audience) => {
                const audienceCriteria = normalizeSmsAudienceCriteria(audience.criteria);
                const selection = isSelectionAudience(audienceCriteria);
                const { count, error } = countOf(audience.id);
                return (
                  <AudienceRow
                    key={audience.id}
                    audienceId={audience.id}
                    name={audience.name}
                    summary={rulesSummary(audience)}
                    description={audience.description}
                    badge="Da casa"
                    count={count}
                    countError={error}
                    noun={noun}
                    menu={
                      selection
                        ? undefined
                        : [
                            {
                              label: "Duplicar como meu público",
                              icon: <Copy className="size-4" aria-hidden="true" />,
                              onSelect: () => duplicate(audience),
                            },
                          ]
                    }
                  />
                );
              })}
            </ul>
          </section>
        ) : null}
      </HomeCard>

      {/* ---------------------------------------------------------------- Editor */}
      <Sheet open={editorOpen} onOpenChange={setEditorOpen}>
        <SheetContent
          side="right"
          closeLabel="Fechar editor"
          className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-[560px]"
        >
          <SheetHeader className="border-b border-border/60 px-5 py-4 pr-12 text-left">
            <SheetTitle>{editingId ? "Editar público" : "Novo público"}</SheetTitle>
            <SheetDescription>
              Escolha quem entra. A contagem embaixo atualiza na hora.
            </SheetDescription>
          </SheetHeader>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-5 py-5">
            <div className="space-y-1.5">
              <Label htmlFor="audience-name">Nome</Label>
              <Input
                id="audience-name"
                placeholder="Ex.: Ouro que parou há 30 dias"
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="h-10"
                {...tourAnchor("publicos.editor.nome")}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="audience-description">
                Para que serve <span className="font-normal text-muted-foreground">(opcional)</span>
              </Label>
              <Textarea
                id="audience-description"
                placeholder="Ex.: reativar quem parou depois do bônus de boas-vindas"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                className="min-h-16"
                {...tourAnchor("publicos.editor.descricao")}
              />
            </div>

            {editingSelection ? (
              <p className="rounded-xl border border-border bg-secondary/40 p-3.5 text-body text-muted-foreground">
                Público de seleção: {describeSmsAudience(criteria)}{" "}
                {isExpert ? "nos seus leads" : "em Jogadores"}. As regras não se aplicam a ele; você
                pode alterar o nome e a descrição ou excluí-lo.
              </p>
            ) : (
              <div className="space-y-5 border-t border-border/60 pt-5">
                <div>
                  <p className="text-label font-semibold">Quem entra</p>
                  <p className="mt-0.5 text-meta text-muted-foreground">
                    Toque para filtrar; dá para juntar filtros de grupos diferentes. O número ao
                    lado mostra quantos {isExpert ? "leads" : "jogadores"} a opção traz junto com o
                    que já está marcado.
                  </p>
                </div>

                <RuleGroup title="Depósito" dot={FILTER_GROUP_DOT.deposit}>
                  <RuleChip
                    label="Já depositou"
                    count={facets?.activity.depositYes}
                    loading={calculating}
                    active={criteria.activity.deposit === "yes"}
                    onClick={() => setActivity("deposit", "yes")}
                    tourProps={tourAnchor("publicos.editor.deposito-sim")}
                  />
                  <RuleChip
                    label="Só fez o 1º depósito"
                    count={facets?.activity.depositFirstOnly}
                    loading={calculating}
                    active={criteria.activity.deposit === "first_only"}
                    onClick={() => setActivity("deposit", "first_only")}
                    tourProps={tourAnchor("publicos.editor.deposito-primeiro")}
                  />
                  <RuleChip
                    label="Já fez 2 depósitos"
                    count={facets?.activity.depositExactly2}
                    loading={calculating}
                    active={criteria.activity.deposit === "exactly_2"}
                    onClick={() => setActivity("deposit", "exactly_2")}
                    tourProps={tourAnchor("publicos.editor.deposito-dois")}
                  />
                  <RuleChip
                    label="Já fez 3 depósitos"
                    count={facets?.activity.depositExactly3}
                    loading={calculating}
                    active={criteria.activity.deposit === "exactly_3"}
                    onClick={() => setActivity("deposit", "exactly_3")}
                    tourProps={tourAnchor("publicos.editor.deposito-tres")}
                  />
                  <RuleChip
                    label="Nunca depositou"
                    count={facets?.activity.depositNever}
                    loading={calculating}
                    active={criteria.activity.deposit === "never"}
                    onClick={() => setActivity("deposit", "never")}
                    tourProps={tourAnchor("publicos.editor.deposito-nunca")}
                  />
                </RuleGroup>

                <RuleGroup
                  title="Saques e pendências"
                  dot={FILTER_GROUP_DOT.withdrawal}
                  help={
                    <>
                      Pendência é <Term id="pix-gerado-pago">PIX</Term> gerado e não pago, ou saque
                      ainda em aberto.
                    </>
                  }
                >
                  <RuleChip
                    label="Gerou PIX e não pagou"
                    count={facets?.activity.pixUnpaid}
                    loading={calculating}
                    active={criteria.activity.pixUnpaid}
                    onClick={() => setActivity("pixUnpaid", true)}
                    tourProps={tourAnchor("publicos.editor.pix-nao-pago")}
                  />
                  <RuleChip
                    label="Saque pendente"
                    count={facets?.activity.withdrawalPending}
                    loading={calculating}
                    active={criteria.activity.withdrawalPending}
                    onClick={() => setActivity("withdrawalPending", true)}
                    tourProps={tourAnchor("publicos.editor.saque-pendente")}
                  />
                  <RuleChip
                    label="Já sacou"
                    count={facets?.activity.withdrawalYes}
                    loading={calculating}
                    active={criteria.activity.withdrawal === "yes"}
                    onClick={() => setActivity("withdrawal", "yes")}
                    tourProps={tourAnchor("publicos.editor.saque-sim")}
                  />
                  <RuleChip
                    label="Nunca sacou"
                    count={facets?.activity.withdrawalNever}
                    loading={calculating}
                    active={criteria.activity.withdrawal === "never"}
                    onClick={() => setActivity("withdrawal", "never")}
                    tourProps={tourAnchor("publicos.editor.saque-nunca")}
                  />
                </RuleGroup>

                {!neverDeposited && (
                  <RuleGroup title="Nível" help="Combina com o tempo sem depositar.">
                    {LEVEL_RULES.map((rule, index) => (
                      <RuleChip
                        key={rule.value}
                        label={rule.label}
                        marker={<LevelMarker level={rule.value} />}
                        count={facets?.levels?.[rule.value]}
                        loading={calculating}
                        active={criteria.level === rule.value}
                        onClick={() =>
                          setCriteria((current) => ({
                            ...current,
                            level: current.level === rule.value ? null : rule.value,
                          }))
                        }
                        tourProps={index === 0 ? tourAnchor("publicos.editor.nivel") : undefined}
                      />
                    ))}
                  </RuleGroup>
                )}

                {!neverDeposited && (
                  <RuleGroup
                    title="Tempo sem depositar"
                    help="Quanto mais escura a bolinha, mais tempo parado. Ou digite os dias."
                    dot={FILTER_GROUP_DOT.inactivity}
                  >
                    {TIMING_RULES.map((rule, index) => (
                      <RuleChip
                        key={rule.value}
                        label={rule.label}
                        dot={INACTIVITY_DOT[rule.value]}
                        count={facets?.timings?.[rule.value]}
                        loading={calculating}
                        active={criteria.timing === rule.value}
                        onClick={() =>
                          setCriteria((current) => ({
                            ...current,
                            timing: current.timing === rule.value ? "any" : rule.value,
                          }))
                        }
                        tourProps={
                          index === 0
                            ? tourAnchor("publicos.editor.tempo-sem-depositar")
                            : undefined
                        }
                      />
                    ))}
                    <div className="flex items-center gap-1.5">
                      <Input
                        className="h-10 w-24 sm:h-8"
                        type="number"
                        inputMode="numeric"
                        min={1}
                        aria-label="Dias sem depositar"
                        value={criteria.timing === "custom" ? criteria.customDays : ""}
                        placeholder="Dias"
                        onChange={(event) => {
                          const raw = event.target.value;
                          setCriteria((current) =>
                            raw === ""
                              ? { ...current, timing: "any" }
                              : {
                                  ...current,
                                  timing: "custom",
                                  customDays: Math.max(1, Number(raw) || 1),
                                },
                          );
                        }}
                        {...tourAnchor("publicos.editor.dias-personalizado")}
                      />
                      {criteria.timing === "custom" ? (
                        <Button
                          type="button"
                          variant="ghost"
                          className="h-10 px-2 text-meta sm:h-8"
                          onClick={() => setCriteria((current) => ({ ...current, timing: "any" }))}
                          {...tourAnchor("publicos.editor.limpar-dias")}
                        >
                          <X className="size-3.5" aria-hidden="true" />
                          Limpar
                        </Button>
                      ) : (
                        <span className="text-meta text-muted-foreground">dias ou mais</span>
                      )}
                    </div>
                  </RuleGroup>
                )}

                <RuleGroup
                  title="Cadastro e bônus"
                  dot={FILTER_GROUP_DOT.signup}
                  help="“Ontem” é o dia anterior inteiro, no horário de Brasília."
                >
                  <RuleChip
                    label="Cadastrou ontem"
                    count={facets?.activity.registeredYesterday}
                    loading={calculating}
                    active={Boolean(criteria.registeredYesterday)}
                    onClick={() =>
                      setCriteria((current) => ({
                        ...current,
                        registeredYesterday: current.registeredYesterday ? undefined : true,
                      }))
                    }
                    tourProps={tourAnchor("publicos.editor.cadastro-ontem")}
                  />
                  <RuleChip
                    label="Recebeu cashback"
                    count={facets?.activity.cashback}
                    loading={calculating}
                    active={criteria.activity.cashback}
                    onClick={() => setActivity("cashback", true)}
                    tourProps={tourAnchor("publicos.editor.cashback")}
                  />
                </RuleGroup>

                <Collapsible
                  open={
                    moreFiltersOpen ||
                    criteria.daysWithoutLogin !== null ||
                    criteria.daysSinceRegistration !== null
                  }
                  onOpenChange={setMoreFiltersOpen}
                >
                  <CollapsibleTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      className="-ml-2 h-10 px-2 text-label sm:h-9"
                    >
                      <ChevronDown className="size-4" aria-hidden="true" />
                      Mais filtros: dias sem entrar, dias desde o cadastro
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="grid gap-3 pt-2 sm:grid-cols-2">
                    <NumberRule
                      id="days-without-login"
                      label="Dias sem entrar"
                      value={criteria.daysWithoutLogin}
                      onChange={(value) =>
                        setCriteria((current) => ({ ...current, daysWithoutLogin: value }))
                      }
                      tourProps={tourAnchor("publicos.editor.dias-sem-entrar")}
                    />
                    <NumberRule
                      id="days-since-registration"
                      label="Dias desde o cadastro"
                      value={criteria.daysSinceRegistration}
                      onChange={(value) =>
                        setCriteria((current) => ({ ...current, daysSinceRegistration: value }))
                      }
                      tourProps={tourAnchor("publicos.editor.dias-desde-cadastro")}
                    />
                  </CollapsibleContent>
                </Collapsible>
              </div>
            )}
          </div>

          {/* Footer: the live size and the save, always visible. */}
          <div className="space-y-3 border-t border-border/60 bg-background/95 px-5 py-3.5 pb-[calc(0.875rem+env(safe-area-inset-bottom))]">
            <div aria-live="polite" {...tourAnchor("publicos.editor.previa")}>
              <p className="flex items-center gap-2 text-body font-semibold tabular-nums">
                {calculating ? (
                  <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
                ) : (
                  <Users className="size-4 text-muted-foreground" aria-hidden="true" />
                )}
                {previewLine}
              </p>
              {!calculating && (
                <p className="mt-0.5 line-clamp-2 text-meta text-muted-foreground">
                  {describeSmsAudience(criteria)}
                  {missingPhones > 0
                    ? ` · ${missingPhones.toLocaleString("pt-BR")} sem telefone válido ficam de fora do SMS`
                    : ""}
                </p>
              )}
              {preview.isError && !calculating && (
                <p className="mt-1 text-meta text-destructive">
                  Não foi possível contar: {preview.error.message}
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                className="h-10 sm:h-9"
                disabled={!name.trim() || save.isPending || calculating}
                onClick={() => save.mutate()}
                {...tourAnchor("publicos.editor.salvar")}
              >
                {save.isPending ? "Salvando…" : editingId ? "Salvar alterações" : "Salvar público"}
              </Button>
              <Button
                variant="ghost"
                className="h-10 sm:h-9"
                onClick={() => setEditorOpen(false)}
                {...tourAnchor("publicos.editor.cancelar")}
              >
                Cancelar
              </Button>
              {!name.trim() && (
                <span className="text-meta text-muted-foreground">Dê um nome para salvar.</span>
              )}
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </Page>
  );
}

function NumberRule({
  id,
  label,
  value,
  onChange,
  tourProps,
}: {
  id: string;
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  /** `tourAnchor(...)` do chamador. */
  tourProps?: Record<string, string>;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={1}
        placeholder="Sem limite"
        value={value ?? ""}
        className="h-10"
        onChange={(event) =>
          onChange(event.target.value ? Math.max(1, Number(event.target.value)) : null)
        }
        {...tourProps}
      />
    </div>
  );
}
