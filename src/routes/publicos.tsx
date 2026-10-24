import { createFileRoute } from "@tanstack/react-router";
import { FILTER_GROUP_DOT, INACTIVITY_DOT, LEVEL_IDENTITY } from "@/components/identity/identity";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { Copy, Loader2, Pencil, Trash2, Users, Workflow, X } from "lucide-react";
import { toast } from "sonner";
import { AudienceCard, RuleChip, RuleGroup } from "@/components/audiences/audience-parts";
import { criteriaLabels } from "@/components/audiences/criteria-labels";
import { HomeCard } from "@/components/home/home-cards";
import { Button } from "@/components/ui/button";
import { requestConfirmation } from "@/components/system-dialog-host";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  deleteSmsAudience,
  listSmsAudiences,
  saveSmsAudience,
} from "@/lib/sms-audience-crud.functions";
import { resolveSmsCampaignAudience } from "@/lib/sms-audiences.functions";
import {
  describeSmsAudience,
  EMPTY_SMS_AUDIENCE,
  isSelectionAudience,
  normalizeSmsAudienceCriteria,
  SYSTEM_SMS_AUDIENCES,
  type SmsAudienceCriteria,
} from "@/lib/sms-audience-criteria";

export const Route = createFileRoute("/publicos")({ component: PublicosPage });

type AudienceRow = {
  id: string;
  name: string;
  description: string | null;
  criteria: unknown;
};

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
  const listFn = useServerFn(listSmsAudiences);
  const saveFn = useServerFn(saveSmsAudience);
  const deleteFn = useServerFn(deleteSmsAudience);
  const resolveFn = useServerFn(resolveSmsCampaignAudience);
  const audiences = useQuery({ queryKey: ["sms-audiences"], queryFn: () => listFn() });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [criteria, setCriteria] = useState<SmsAudienceCriteria>(EMPTY_SMS_AUDIENCE);
  const [previewWaiting, setPreviewWaiting] = useState(true);
  const previewVersion = useRef(0);

  const preview = useMutation({
    mutationFn: (next: SmsAudienceCriteria) => resolveFn({ data: { criteria: next } }),
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
      qc.invalidateQueries({ queryKey: ["sms-audiences"] });
      reset();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Público excluído");
      qc.invalidateQueries({ queryKey: ["sms-audiences"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  function reset() {
    setEditingId(null);
    setName("");
    setDescription("");
    setCriteria(EMPTY_SMS_AUDIENCE);
  }

  function edit(row: AudienceRow) {
    setEditingId(row.id);
    // Público de seleção: só renomear; a lista de jogadores não se mistura com regras.
    setName(row.name);
    setDescription(row.description ?? "");
    setCriteria(normalizeSmsAudienceCriteria(row.criteria));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function duplicate(row: AudienceRow) {
    setEditingId(null);
    setName(`${row.name} — cópia`);
    setDescription(row.description ?? "");
    setCriteria(normalizeSmsAudienceCriteria(row.criteria));
    window.scrollTo({ top: 0, behavior: "smooth" });
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
  const savedAudiences = (audiences.data ?? []) as AudienceRow[];

  return (
    <Page>
      <PageHeader subtitle="Separe seus jogadores em grupos para criar campanhas mais precisas." />

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,440px)_minmax(0,1fr)]">
        <HomeCard className="min-w-0 space-y-5 p-4 sm:p-5">
          <div>
            <h2 className="text-section">{editingId ? "Editar público" : "Novo público"}</h2>
            <p className="mt-0.5 text-body text-muted-foreground">
              Quem deve fazer parte deste público?
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="audience-name">Nome</Label>
            <Input
              id="audience-name"
              placeholder="Ex.: Ouro que parou há 30 dias"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="h-10"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="audience-description">
              Descrição <span className="font-normal text-muted-foreground">(opcional)</span>
            </Label>
            <Textarea
              id="audience-description"
              placeholder="Quando este público deve ser usado?"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className="min-h-16"
            />
          </div>

          {editingSelection ? (
            <p className="rounded-xl border border-border bg-secondary/40 p-3.5 text-body text-muted-foreground">
              Público de seleção: {describeSmsAudience(criteria)} em Jogadores. As regras não se
              aplicam a ele; você pode alterar o nome e a descrição ou excluí-lo.
            </p>
          ) : (
            <>
              <div className="space-y-2">
                <p className="text-label font-semibold">O que o jogador fez</p>
                <p className="-mt-1 text-meta text-muted-foreground">
                  Escolhas incompatíveis se substituem; as demais podem ser combinadas.
                </p>
                <div className="grid gap-4 sm:grid-cols-[repeat(auto-fit,minmax(230px,1fr))]">
                  <RuleGroup title="Depósito" dot={FILTER_GROUP_DOT.deposit}>
                    <RuleChip
                      label="Já depositou"
                      dot={FILTER_GROUP_DOT.deposit}
                      count={facets?.activity.depositYes}
                      loading={calculating}
                      active={criteria.activity.deposit === "yes"}
                      onClick={() => setActivity("deposit", "yes")}
                    />
                    <RuleChip
                      label="Nunca depositou"
                      dot={FILTER_GROUP_DOT.signup}
                      count={facets?.activity.depositNever}
                      loading={calculating}
                      active={criteria.activity.deposit === "never"}
                      onClick={() => setActivity("deposit", "never")}
                    />
                  </RuleGroup>
                  <RuleGroup title="Pendências" dot={FILTER_GROUP_DOT.pending}>
                    <RuleChip
                      label="Gerou PIX e não pagou"
                      dot={FILTER_GROUP_DOT.pending}
                      count={facets?.activity.pixUnpaid}
                      loading={calculating}
                      active={criteria.activity.pixUnpaid}
                      onClick={() => setActivity("pixUnpaid", true)}
                    />
                    <RuleChip
                      label="Saque pendente"
                      dot={FILTER_GROUP_DOT.pending}
                      count={facets?.activity.withdrawalPending}
                      loading={calculating}
                      active={criteria.activity.withdrawalPending}
                      onClick={() => setActivity("withdrawalPending", true)}
                    />
                  </RuleGroup>
                  <RuleGroup title="Saques" dot={FILTER_GROUP_DOT.withdrawal}>
                    <RuleChip
                      label="Já sacou"
                      dot={FILTER_GROUP_DOT.withdrawal}
                      count={facets?.activity.withdrawalYes}
                      loading={calculating}
                      active={criteria.activity.withdrawal === "yes"}
                      onClick={() => setActivity("withdrawal", "yes")}
                    />
                    <RuleChip
                      label="Nunca sacou"
                      dot={`${FILTER_GROUP_DOT.withdrawal} opacity-40`}
                      count={facets?.activity.withdrawalNever}
                      loading={calculating}
                      active={criteria.activity.withdrawal === "never"}
                      onClick={() => setActivity("withdrawal", "never")}
                    />
                  </RuleGroup>
                  <RuleGroup title="Bônus" dot={FILTER_GROUP_DOT.bonus}>
                    <RuleChip
                      label="Recebeu cashback"
                      dot={FILTER_GROUP_DOT.bonus}
                      count={facets?.activity.cashback}
                      loading={calculating}
                      active={criteria.activity.cashback}
                      onClick={() => setActivity("cashback", true)}
                    />
                  </RuleGroup>
                </div>
              </div>

              {!neverDeposited && (
                <RuleGroup title="Nível" help="Pode ser combinado com o tempo sem depositar.">
                  {LEVEL_RULES.map((rule) => (
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
                    />
                  ))}
                </RuleGroup>
              )}

              {!neverDeposited && (
                <RuleGroup
                  title="Tempo sem depositar"
                  help="Escolha uma faixa ou informe os dias. Quanto mais escura a bolinha, mais tempo parado."
                  dot={FILTER_GROUP_DOT.inactivity}
                >
                  {TIMING_RULES.map((rule) => (
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
                    />
                    {criteria.timing === "custom" ? (
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-10 px-2 text-meta sm:h-8"
                        onClick={() => setCriteria((current) => ({ ...current, timing: "any" }))}
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

              <div className="grid gap-3 sm:grid-cols-2">
                <NumberRule
                  id="days-without-login"
                  label="Dias sem entrar"
                  value={criteria.daysWithoutLogin}
                  onChange={(value) =>
                    setCriteria((current) => ({ ...current, daysWithoutLogin: value }))
                  }
                />
                <NumberRule
                  id="days-since-registration"
                  label="Dias desde o cadastro"
                  value={criteria.daysSinceRegistration}
                  onChange={(value) =>
                    setCriteria((current) => ({ ...current, daysSinceRegistration: value }))
                  }
                />
              </div>
            </>
          )}

          <div
            className="relative overflow-hidden rounded-xl border border-border bg-secondary/40 p-3.5"
            aria-live="polite"
          >
            <div className="flex items-center gap-2 text-body font-medium">
              {calculating ? (
                <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
              ) : (
                <Users className="size-4 text-muted-foreground" aria-hidden="true" />
              )}
              {calculating
                ? "Calculando público…"
                : editingSelection
                  ? `${(preview.data?.total ?? 0).toLocaleString("pt-BR")} jogadores da seleção nesta casa`
                  : `${(preview.data?.total ?? 0).toLocaleString("pt-BR")} jogadores atendem a estas regras`}
            </div>
            <p className="mt-1.5 text-meta text-muted-foreground">
              {describeSmsAudience(criteria)}
            </p>
            {!calculating && preview.data && (
              <div className="mt-1 space-y-1 text-meta text-muted-foreground">
                <p>
                  {preview.data.recipientTotal.toLocaleString("pt-BR")} com telefone válido para
                  receber SMS
                </p>
                {preview.data.total > preview.data.recipientTotal && (
                  <p>
                    {(preview.data.total - preview.data.recipientTotal).toLocaleString("pt-BR")}{" "}
                    ficam de fora do envio por não terem telefone válido.
                  </p>
                )}
              </div>
            )}
            {preview.isError && !calculating && (
              <p className="mt-2 text-meta text-destructive">
                Não foi possível calcular: {preview.error.message}
              </p>
            )}
          </div>

          <div className="flex gap-2">
            <Button
              className="h-10 sm:h-9"
              disabled={!name.trim() || save.isPending || calculating}
              onClick={() => save.mutate()}
            >
              {editingId ? "Salvar alterações" : "Criar público"}
            </Button>
            {editingId && (
              <Button variant="ghost" className="h-10 sm:h-9" onClick={reset}>
                Cancelar
              </Button>
            )}
          </div>
        </HomeCard>

        <HomeCard className="min-w-0 space-y-5 p-4 sm:p-5">
          <section className="space-y-3" aria-labelledby="saved-audiences-title">
            <div>
              <h2 id="saved-audiences-title" className="text-section">
                Seus públicos
              </h2>
              <p className="mt-0.5 text-body text-muted-foreground">
                As quantidades são recalculadas no momento do envio.
              </p>
            </div>
            {audiences.isFetching && !audiences.isLoading && (
              <p className="flex items-center gap-2 text-meta text-muted-foreground" role="status">
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> Atualizando
                públicos…
              </p>
            )}
            {audiences.isLoading && (
              <p className="py-6 text-center text-body text-muted-foreground">
                Carregando públicos…
              </p>
            )}
            {audiences.isError && (
              <p className="rounded-lg border border-destructive/30 p-3 text-body text-destructive">
                Não foi possível carregar os públicos: {audiences.error.message}
              </p>
            )}
            {!audiences.isLoading && !audiences.isError && savedAudiences.length === 0 && (
              <p className="rounded-xl border border-dashed border-border p-6 text-center text-body text-muted-foreground">
                Você ainda não criou públicos personalizados.
              </p>
            )}
            <div className="space-y-2">
              {savedAudiences.map((audience) => {
                const audienceCriteria = normalizeSmsAudienceCriteria(audience.criteria);
                const selection = isSelectionAudience(audienceCriteria);
                return (
                  <AudienceCard
                    key={audience.id}
                    audienceId={audience.id}
                    name={audience.name}
                    description={audience.description}
                    labels={criteriaLabels(audienceCriteria)}
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
            </div>
          </section>

          <section
            className="space-y-3 border-t border-border/70 pt-5"
            aria-labelledby="system-audiences-title"
          >
            <div>
              <h2 id="system-audiences-title" className="text-section">
                Públicos automáticos
              </h2>
              <p className="mt-0.5 text-body text-muted-foreground">
                Os níveis de fidelização estão sempre prontos para uso e acompanham a classificação
                atual dos jogadores.
              </p>
            </div>
            <div className="grid gap-2 xl:grid-cols-2">
              {SYSTEM_SMS_AUDIENCES.map((audience) => (
                <AudienceCard
                  key={audience.id}
                  audienceId={audience.id}
                  name={audience.name}
                  description={audience.description}
                  menu={
                    audience.id === "system:all-leads"
                      ? [
                          {
                            label: "Usar em jornada",
                            icon: <Workflow className="size-4" aria-hidden="true" />,
                            to: "/jornadas/nova",
                            search: { audience: "system:all-leads" },
                          },
                        ]
                      : undefined
                  }
                />
              ))}
            </div>
          </section>
        </HomeCard>
      </div>
    </Page>
  );
}

function NumberRule({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
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
      />
    </div>
  );
}
