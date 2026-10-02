import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import {
  Activity,
  ArrowDownToLine,
  CircleDollarSign,
  Clock3,
  Copy,
  Crown,
  Gem,
  Gift,
  Loader2,
  Medal,
  Megaphone,
  Moon,
  Pencil,
  Snowflake,
  Trash2,
  Trophy,
  Users,
  WalletCards,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { requestConfirmation } from "@/components/system-dialog-host";
import { PageHeader } from "@/components/ui-premium/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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

type IconComponent = ComponentType<{ className?: string }>;
type Level = NonNullable<SmsAudienceCriteria["level"]>;
type Timing = SmsAudienceCriteria["timing"];

const LEVEL_RULES: Array<{
  value: Level;
  label: string;
  icon: IconComponent;
  tone: string;
}> = [
  { value: "bronze", label: "Bronze", icon: Activity, tone: "border-orange-400/40 bg-orange-400/10 text-orange-400" },
  { value: "silver", label: "Prata", icon: Medal, tone: "border-sky-200/40 bg-sky-200/10 text-sky-100" },
  { value: "gold", label: "Ouro", icon: Trophy, tone: "border-amber-400/40 bg-amber-400/10 text-amber-300" },
  { value: "diamond", label: "Diamante", icon: Gem, tone: "border-cyan-300/40 bg-cyan-300/10 text-cyan-200" },
  { value: "black", label: "Black VIP", icon: Crown, tone: "border-violet-300/40 bg-violet-300/10 text-violet-200" },
];

const TIMING_RULES: Array<{
  value: Timing;
  label: string;
  icon: IconComponent;
  tone: string;
}> = [
  { value: "cooling", label: "Esfriando", icon: Snowflake, tone: "border-amber-400/40 bg-amber-400/10 text-amber-400" },
  { value: "sleeping", label: "Dormindo", icon: Moon, tone: "border-rose-400/40 bg-rose-400/10 text-rose-400" },
  { value: "inactive30", label: "30+ dias", icon: Clock3, tone: "border-rose-500/40 bg-rose-500/10 text-rose-300" },
  { value: "inactive90", label: "90+ dias", icon: Clock3, tone: "border-red-500/40 bg-red-500/10 text-red-400" },
];

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
  const facets = preview.data?.facets;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Públicos"
        subtitle="Separe seus jogadores em grupos para criar campanhas mais precisas."
        icon={<Users className="h-5 w-5 text-primary-foreground" />}
      />

      <div className="grid gap-5 xl:grid-cols-[500px_1fr]">
        <Card className="border-border/60 bg-card/70">
          <CardContent className="space-y-5 p-5">
            <div>
              <h2 className="text-lg font-semibold">
                {editingId ? "Editar público" : "Novo público"}
              </h2>
              <p className="text-sm text-muted-foreground">Quem deve fazer parte deste público?</p>
            </div>
            <Input placeholder="Nome do público" value={name} onChange={(event) => setName(event.target.value)} />
            <Textarea
              placeholder="Quando este público deve ser usado? (opcional)"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />

            <RuleGroup
              title="O que o jogador fez"
              help="Escolhas incompatíveis se substituem; as demais podem ser combinadas."
            >
              <RuleButton icon={Users} tone="border-primary/40 bg-primary/10 text-primary" label="Nunca depositou" count={facets?.activity.depositNever} loading={calculating} active={criteria.activity.deposit === "never"} onClick={() => setActivity("deposit", "never")} />
              <RuleButton icon={WalletCards} tone="border-emerald-400/40 bg-emerald-400/10 text-emerald-400" label="Já depositou" count={facets?.activity.depositYes} loading={calculating} active={criteria.activity.deposit === "yes"} onClick={() => setActivity("deposit", "yes")} />
              <RuleButton icon={CircleDollarSign} tone="border-amber-400/40 bg-amber-400/10 text-amber-300" label="Gerou PIX e não pagou" count={facets?.activity.pixUnpaid} loading={calculating} active={criteria.activity.pixUnpaid} onClick={() => setActivity("pixUnpaid", true)} />
              <RuleButton icon={ArrowDownToLine} tone="border-sky-400/40 bg-sky-400/10 text-sky-300" label="Já sacou" count={facets?.activity.withdrawalYes} loading={calculating} active={criteria.activity.withdrawal === "yes"} onClick={() => setActivity("withdrawal", "yes")} />
              <RuleButton icon={ArrowDownToLine} tone="border-muted-foreground/40 bg-muted/30 text-muted-foreground" label="Nunca sacou" count={facets?.activity.withdrawalNever} loading={calculating} active={criteria.activity.withdrawal === "never"} onClick={() => setActivity("withdrawal", "never")} />
              <RuleButton icon={Clock3} tone="border-amber-400/40 bg-amber-400/10 text-amber-300" label="Saque pendente" count={facets?.activity.withdrawalPending} loading={calculating} active={criteria.activity.withdrawalPending} onClick={() => setActivity("withdrawalPending", true)} />
              <RuleButton icon={Gift} tone="border-violet-400/40 bg-violet-400/10 text-violet-300" label="Recebeu cashback" count={facets?.activity.cashback} loading={calculating} active={criteria.activity.cashback} onClick={() => setActivity("cashback", true)} />
            </RuleGroup>

            {criteria.activity.deposit !== "never" && (
              <RuleGroup title="Nível" help="Pode ser combinado com a situação do jogador.">
                {LEVEL_RULES.map((rule) => (
                  <RuleButton
                    key={rule.value}
                    {...rule}
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

            <RuleGroup
              title="Tempo sem depositar"
              help={
                criteria.activity.deposit === "never"
                  ? "Para quem nunca depositou, use o tempo desde o cadastro."
                  : "Escolha uma faixa e combine com o nível desejado."
              }
            >
              {criteria.activity.deposit !== "never" && (
                <>
                  {TIMING_RULES.map((rule) => (
                    <RuleButton
                      key={rule.value}
                      {...rule}
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
                  <div className="flex items-center gap-2">
                    <Input
                      className="h-9 w-24"
                      type="number"
                      min={1}
                      value={criteria.timing === "custom" ? criteria.customDays : ""}
                      placeholder="Dias"
                      onChange={(event) =>
                        setCriteria((current) => ({
                          ...current,
                          timing: "custom",
                          customDays: Math.max(1, Number(event.target.value) || 1),
                        }))
                      }
                    />
                    <span className="text-xs text-muted-foreground">ou informe os dias</span>
                  </div>
                </>
              )}
            </RuleGroup>

            <div className="grid gap-3 sm:grid-cols-2">
              <NumberRule label="Dias sem entrar" value={criteria.daysWithoutLogin} onChange={(value) => setCriteria((current) => ({ ...current, daysWithoutLogin: value }))} />
              <NumberRule label="Dias desde o cadastro" value={criteria.daysSinceRegistration} onChange={(value) => setCriteria((current) => ({ ...current, daysSinceRegistration: value }))} />
            </div>

            <div className="relative overflow-hidden rounded-xl border border-primary/30 bg-primary/5 p-4">
              {calculating && <div className="absolute inset-0 bg-background/45" />}
              <div className="relative flex items-center gap-2 text-sm font-medium">
                {calculating ? <Loader2 className="h-4 w-4 animate-spin text-primary" /> : <Users className="h-4 w-4" />}
                {calculating
                  ? "Calculando público..."
                  : `${(preview.data?.total ?? 0).toLocaleString("pt-BR")} jogadores correspondem a estas regras`}
              </div>
              <p className="relative mt-2 text-xs text-muted-foreground">{describeSmsAudience(criteria)}</p>
              {!calculating && preview.data && (
                <p className="relative mt-1 text-xs text-muted-foreground">
                  {preview.data.recipientTotal.toLocaleString("pt-BR")} com telefone válido para receber SMS
                </p>
              )}
              {preview.isError && !calculating && (
                <p className="relative mt-2 text-xs text-destructive">
                  Não foi possível calcular: {preview.error.message}
                </p>
              )}
            </div>

            <div className="flex gap-2">
              <Button disabled={!name.trim() || save.isPending || calculating} onClick={() => save.mutate()}>
                {editingId ? "Salvar alterações" : "Criar público"}
              </Button>
              {editingId && <Button variant="ghost" onClick={reset}>Cancelar</Button>}
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/60 bg-card/70">
          <CardContent className="space-y-3 p-5">
            <div>
              <h2 className="text-lg font-semibold">Seus públicos</h2>
              <p className="text-sm text-muted-foreground">
                As quantidades são recalculadas no momento do envio.
              </p>
            </div>
            {audiences.isFetching && !audiences.isLoading && (
              <div className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-primary" role="status">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Atualizando públicos...
              </div>
            )}
            {audiences.isLoading && <p className="py-8 text-center text-sm text-muted-foreground">Carregando públicos...</p>}
            {audiences.isError && <p className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">Não foi possível carregar os públicos: {audiences.error.message}</p>}
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
              <div className="text-sm font-semibold">Públicos automáticos</div>
              <p className="mt-1 text-xs text-muted-foreground">Os níveis da gamificação estão sempre prontos para uso e acompanham a classificação atual dos jogadores.</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {SYSTEM_SMS_AUDIENCES.map((audience) => {
                  const level = LEVEL_RULES.find((rule) => rule.value === audience.criteria.level);
                  const Icon = level?.icon ?? Users;
                  return (
                    <div key={audience.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${level?.tone ?? "border-primary/30 bg-primary/10 text-primary"}`}><Icon className="h-4 w-4" /></span>
                        <div className="min-w-0"><div className="font-medium">{audience.name}</div><div className="text-xs text-muted-foreground">{audience.description}</div></div>
                      </div>
                      <Button size="sm" variant="outline" asChild><a href={`/campanhas?newCampaign=1&audience=${encodeURIComponent(audience.id)}`}><Megaphone className="h-3.5 w-3.5" />Usar</a></Button>
                    </div>
                  );
                })}
              </div>
            </div>
            {!audiences.isLoading && !audiences.isError && (audiences.data ?? []).length === 0 && <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">Você ainda não criou públicos personalizados.</p>}
            {(audiences.data ?? []).map((row) => {
              const audience = row as AudienceRow;
              const normalized = normalizeSmsAudienceCriteria(audience.criteria);
              return (
                <div key={audience.id} className="rounded-xl border border-border/60 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold">{audience.name}</div>
                      {audience.description && <div className="mt-1 text-xs text-muted-foreground">{audience.description}</div>}
                      <CriteriaBadges criteria={normalized} />
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <Button size="sm" variant="outline" asChild><a href={`/campanhas?newCampaign=1&audience=${encodeURIComponent(audience.id)}`}><Megaphone className="h-3.5 w-3.5" />Usar</a></Button>
                      <Button size="sm" variant="outline" onClick={() => edit(audience)}><Pencil className="h-3.5 w-3.5" />Editar</Button>
                      <Button size="sm" variant="ghost" onClick={() => duplicate(audience)}><Copy className="h-3.5 w-3.5" />Duplicar</Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        onClick={async () => {
                          const confirmed = await requestConfirmation({
                            title: `Excluir “${audience.name}”?`,
                            description: "O público será removido da sua lista. Campanhas já enviadas não serão alteradas.",
                            confirmLabel: "Excluir público",
                            destructive: true,
                          });
                          if (confirmed) remove.mutate(audience.id);
                        }}
                      ><Trash2 className="h-3.5 w-3.5" />Excluir</Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function RuleGroup({ title, help, children }: { title: string; help?: string; children: ReactNode }) {
  return <div className="space-y-2"><div><div className="text-sm font-semibold">{title}</div>{help && <div className="text-xs text-muted-foreground">{help}</div>}</div><div className="flex flex-wrap gap-2">{children}</div></div>;
}

function RuleButton({ active, onClick, label, icon: Icon, tone, count, loading }: { active: boolean; onClick: () => void; label: string; icon: IconComponent; tone: string; count?: number; loading?: boolean }) {
  return <Button type="button" size="sm" variant="outline" className={`rounded-full gap-1.5 ${tone} ${active ? "ring-2 ring-primary/70 ring-offset-1 ring-offset-background" : "opacity-85 hover:opacity-100"}`} onClick={onClick}><Icon className="h-3.5 w-3.5" /><span>{label}</span><span className="ml-0.5 border-l border-current/20 pl-1.5 text-[11px] tabular-nums opacity-80">{loading ? "…" : (count ?? 0).toLocaleString("pt-BR")}</span></Button>;
}

function CriteriaBadges({ criteria }: { criteria: SmsAudienceCriteria }) {
  const badges: Array<{ label: string; icon: IconComponent; tone: string }> = [];
  if (criteria.activity.deposit === "never") badges.push({ label: "Sem depósito", icon: Users, tone: "border-primary/40 bg-primary/10 text-primary" });
  if (criteria.activity.deposit === "yes") badges.push({ label: "Já depositou", icon: WalletCards, tone: "border-emerald-400/40 bg-emerald-400/10 text-emerald-400" });
  if (criteria.activity.pixUnpaid) badges.push({ label: "PIX não pago", icon: CircleDollarSign, tone: "border-amber-400/40 bg-amber-400/10 text-amber-300" });
  if (criteria.activity.withdrawal === "yes") badges.push({ label: "Já sacou", icon: ArrowDownToLine, tone: "border-sky-400/40 bg-sky-400/10 text-sky-300" });
  if (criteria.activity.withdrawal === "never") badges.push({ label: "Nunca sacou", icon: ArrowDownToLine, tone: "border-border bg-muted/30 text-muted-foreground" });
  if (criteria.activity.withdrawalPending) badges.push({ label: "Saque pendente", icon: Clock3, tone: "border-amber-400/40 bg-amber-400/10 text-amber-300" });
  if (criteria.activity.cashback) badges.push({ label: "Cashback", icon: Gift, tone: "border-violet-400/40 bg-violet-400/10 text-violet-300" });
  if (criteria.level) {
    const rule = LEVEL_RULES.find((item) => item.value === criteria.level);
    if (rule) badges.push(rule);
  }
  if (criteria.timing !== "any") {
    const rule = TIMING_RULES.find((item) => item.value === criteria.timing);
    if (rule) badges.push(rule);
    else if (criteria.timing === "custom") badges.push({ label: `${criteria.customDays}+ dias sem depositar`, icon: Clock3, tone: "border-rose-400/40 bg-rose-400/10 text-rose-300" });
    else if (criteria.timing === "registered_week") badges.push({ label: "Cadastro nesta semana", icon: Clock3, tone: "border-primary/40 bg-primary/10 text-primary" });
  }
  if (criteria.daysWithoutLogin) badges.push({ label: `${criteria.daysWithoutLogin}+ dias sem entrar`, icon: Moon, tone: "border-rose-400/40 bg-rose-400/10 text-rose-300" });
  if (criteria.daysSinceRegistration) badges.push({ label: `${criteria.daysSinceRegistration}+ dias de cadastro`, icon: Clock3, tone: "border-border bg-muted/30 text-muted-foreground" });
  if (badges.length === 0) badges.push({ label: "Todos com telefone válido", icon: Users, tone: "border-border bg-muted/30 text-muted-foreground" });
  return <div className="mt-3 flex flex-wrap gap-1.5">{badges.map((badge, index) => { const Icon = badge.icon; return <span key={`${badge.label}-${index}`} className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium ${badge.tone}`}><Icon className="h-3 w-3" />{badge.label}</span>; })}</div>;
}

function NumberRule({ label, value, onChange }: { label: string; value: number | null; onChange: (value: number | null) => void }) {
  return <label className="space-y-1.5 text-sm font-medium">{label}<Input type="number" min={1} placeholder="Sem limite" value={value ?? ""} onChange={(event) => onChange(event.target.value ? Math.max(1, Number(event.target.value)) : null)} /></label>;
}
