import { type ReactNode, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  ArrowLeft,
  Clock3,
  Mail,
  MessageSquare,
  Pause,
  Phone,
  Play,
  Plus,
  Save,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { listJourneys, saveJourney } from "@/lib/journeys.functions";
import { journeyConflicts, type MapJourney } from "@/lib/journey-map";
import { TRIGGER_NAMES } from "@/lib/triggers";
import { listEmailTemplates } from "@/lib/email.functions";
import { listSmsTemplates } from "@/lib/sms-templates.functions";
import {
  createJourneyVoiceUpload,
  finalizeJourneyVoiceUpload,
  listJourneyVoiceAssets,
} from "@/lib/journey-voice-assets.functions";
import { getComposerOptions } from "@/lib/house-config.functions";
import { COMPOSER_OPTIONS_QUERY_KEY } from "@/components/house-config/house-config-query";
import { ShortDomainSelect } from "@/components/house-config/short-domain-select";
import { EmailSenderSelect } from "@/components/house-config/email-sender-select";
import {
  EmailBlockedNotice,
  ShortenerFallbackNotice,
} from "@/components/house-config/composer-notices";
import { requestConfirmation } from "@/components/system-dialog-host";
import { supabase } from "@/integrations/supabase/client";
import { eventMaxAgeHours } from "@/lib/journey-policy";
import { MAX_LOOPS_LIMIT, endStepMaxLoops, type JourneyStepInput } from "@/lib/journeys.shared";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  INACTIVITY_FIELDS,
  INACTIVITY_TRIGGER_NAME,
  JOURNEY_AUDIENCES,
  WAIT_UNITS,
  type WaitUnit,
  emailStepFromConfig,
  emailStepIdsForConfig,
  fromBrtInput,
  journeyAudienceDescription,
  journeyInProgress,
  journeyStatusLabel,
  journeyTriggerLabel,
  smsExtra,
  smsExtraForTemplateChange,
  splitWaitSeconds,
  toBrtInput,
  waitToSeconds,
} from "./journey-editor-config";
import { useJourneyStatusControl } from "./journey-status-control";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Page, PageHeader } from "@/components/ui-premium/page-header";

type Step =
  | { kind: "wait"; amount: string; unit: WaitUnit }
  | { kind: "sms"; templateId: string; content: string; extra?: Record<string, unknown> }
  | {
      kind: "email";
      templateId: string;
      senderId: string | null;
      shortDomainId: string | null;
    }
  | { kind: "voice"; assetId: string; callerId: string };
type SavedStep = { step_type: string; config: Record<string, unknown>; is_enabled?: boolean };
type ConflictPolicy = "coexist" | "pause_lower_priority" | "exclusive";
type Option = { value: string; label: string };

const STEP_TITLES: Record<Step["kind"], string> = {
  wait: "Aguardar",
  sms: "Enviar SMS",
  email: "Enviar e-mail",
  voice: "Fazer ligação",
};

const LEVEL_OPTIONS: Option[] = [
  { value: "bronze", label: "Bronze" },
  { value: "silver", label: "Prata" },
  { value: "gold", label: "Ouro" },
  { value: "diamond", label: "Diamante" },
  { value: "black", label: "Black VIP" },
];
const REENTRY_OPTIONS: Option[] = [
  { value: "once", label: "Uma única vez" },
  { value: "per_occurrence", label: "A cada ocorrência" },
  { value: "after_cooldown", label: "Depois do intervalo entre jornadas" },
  { value: "never", label: "Nunca reentrar" },
];
const AUDIENCE_OPTIONS: Option[] = (["system:all-leads", "all_active", "vip"] as const).map(
  (value) => ({ value, label: JOURNEY_AUDIENCES[value].label }),
);
const HOLDOUT_OPTIONS: Option[] = [
  { value: "0", label: "Desligado" },
  { value: "5", label: "5% não recebem mensagens" },
  { value: "10", label: "10% não recebem mensagens" },
];
/** Triggers whose entry event has a max age (P0.3), with the field's wording. */
const EVENT_AGE_LABELS: Record<string, string> = {
  cadastrados_sem_deposito: "Só entra quem se cadastrou nas últimas (horas)",
  primeiro_deposito: "Só entra quem fez o 1º depósito nas últimas (horas)",
  saque_pago: "Só entra saque pago nas últimas (horas)",
};
const FAMILY_NONE = "none";
const FAMILY_OPTIONS: Option[] = [
  { value: FAMILY_NONE, label: "Sem família" },
  { value: "progressao_niveis", label: "Progressão de níveis" },
];
const POLICY_OPTIONS: Option[] = [
  { value: "coexist", label: "Permitir coexistência" },
  { value: "pause_lower_priority", label: "Pausar a menor prioridade" },
  { value: "exclusive", label: "Manter apenas esta família" },
];
const EXIT_RULE_OPTIONS = [
  { key: "deposit", label: "Realizou depósito" },
  { key: "first_deposit", label: "Fez o primeiro depósito" },
  { key: "login", label: "Fez login" },
  { key: "voltou_jogar", label: "Voltou a jogar" },
];

/** A neutral editor section: 15px title + one short help line (no "?" popovers). */
function EditorSection({
  title,
  help,
  children,
}: {
  title: string;
  help?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-card/80 p-4 sm:p-5">
      <h2 className="text-section">{title}</h2>
      {help && <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{help}</p>}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function Field({
  id,
  label,
  hint,
  children,
  className,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className ? `space-y-1.5 ${className}` : "space-y-1.5"}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-[12.5px] leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** shadcn Select over string options; keeps an unknown saved value visible instead of hiding it. */
function OptionSelect({
  id,
  value,
  onChange,
  options,
  placeholder,
  ariaLabel,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  placeholder?: string;
  ariaLabel?: string;
}) {
  const known = value === "" || options.some((option) => option.value === value);
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} aria-label={ariaLabel} className="h-10">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
        {!known && <SelectItem value={value}>{value}</SelectItem>}
      </SelectContent>
    </Select>
  );
}

function initialStep(s: SavedStep): Step[] {
  if (s.step_type === "wait") {
    return [{ kind: "wait", ...splitWaitSeconds(Number(s.config.delay_seconds ?? 3600)) }];
  }
  if (s.step_type === "sms") {
    return [
      {
        kind: "sms",
        templateId: String(s.config.template_id ?? ""),
        content: String(
          (s.config.template_snapshot as { content?: string } | undefined)?.content ??
            s.config.content ??
            "",
        ),
        extra: smsExtra(s.config),
      },
    ];
  }
  if (s.step_type === "email") return [{ kind: "email", ...emailStepFromConfig(s.config) }];
  if (s.step_type === "voice") {
    return [
      {
        kind: "voice",
        assetId: String(s.config.asset_id ?? ""),
        callerId: String(s.config.caller_id ?? ""),
      },
    ];
  }
  return [];
}

export function JourneyEditor({
  id,
  initial,
  initialSteps = [],
  metrics,
  initialAudience,
}: {
  id?: string;
  initial?: {
    name: string;
    description: string | null;
    status?: string;
    trigger_type: string;
    trigger_config?: Record<string, unknown>;
    entry_rules?: Record<string, unknown>;
    exit_rules?: Record<string, boolean>;
    daily_limit?: number;
    cooldown_hours?: number;
    ends_at?: string | null;
    holdout_percent?: number;
    conflict_family?: string | null;
    journey_priority?: number;
    conflict_policy?: ConflictPolicy;
  };
  initialSteps?: SavedStep[];
  initialAudience?: string;
  /** Only `byStatus` is used (players inside the journey, for the Pausar dialog).
   * The numbers themselves live in the journey report. */
  metrics?: { byStatus: Record<string, number> };
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const save = useServerFn(saveJourney);
  const statusControl = useJourneyStatusControl();
  const listJourneysFn = useServerFn(listJourneys);
  const otherJourneys = useQuery({
    queryKey: ["journeys"],
    queryFn: () => listJourneysFn(),
    staleTime: 60_000,
  });
  const templatesFn = useServerFn(listEmailTemplates);
  const smsTemplatesFn = useServerFn(listSmsTemplates);
  const voiceAssetsFn = useServerFn(listJourneyVoiceAssets);
  const createVoiceUpload = useServerFn(createJourneyVoiceUpload);
  const finalizeVoiceUpload = useServerFn(finalizeJourneyVoiceUpload);
  const templates = useQuery({
    queryKey: ["journey-email-templates"],
    queryFn: () => templatesFn(),
  });
  const smsTemplates = useQuery({
    queryKey: ["journey-sms-templates"],
    queryFn: () => smsTemplatesFn(),
  });
  const voiceAssets = useQuery({
    queryKey: ["journey-voice-assets"],
    queryFn: () => voiceAssetsFn(),
  });
  const composerOptionsFn = useServerFn(getComposerOptions);
  const composerOptions = useQuery({
    queryKey: COMPOSER_OPTIONS_QUERY_KEY,
    queryFn: () => composerOptionsFn(),
  });
  const shortDomains = composerOptions.data?.shortDomains ?? [];
  const shortenerPending = composerOptions.data?.shortenerPending ?? false;
  const emailSenders = composerOptions.data?.senders ?? [];
  const voiceAssetRows = (voiceAssets.data?.assets ?? []) as Array<{ id: string; name: string }>;
  const uploadAudio = useMutation({
    mutationFn: async (file: File) => {
      const contentType = file.type as "audio/mpeg";
      const name = file.name.replace(/\.[^.]+$/, "");
      const signed = await createVoiceUpload({
        data: { name, filename: file.name, contentType, sizeBytes: file.size },
      });
      const { error } = await supabase.storage
        .from("call-audios")
        .uploadToSignedUrl(signed.path, signed.token, file, { contentType: file.type });
      if (error) throw new Error(error.message);
      return finalizeVoiceUpload({
        data: { path: signed.path, name, contentType, sizeBytes: file.size },
      });
    },
    onSuccess: () => {
      voiceAssets.refetch();
      toast.success("Áudio enviado");
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const savedStatus = id ? (initial?.status ?? "draft") : "draft";
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [trigger, setTrigger] = useState(initial?.trigger_type ?? "manual");
  const [triggerConfig, setTriggerConfig] = useState<Record<string, unknown>>(
    initial?.trigger_config ?? {},
  );
  const [dailyLimit, setDailyLimit] = useState(initial?.daily_limit ?? 1000);
  const [cooldownHours, setCooldownHours] = useState(initial?.cooldown_hours ?? 72);
  const [endsAt, setEndsAt] = useState(() => toBrtInput(initial?.ends_at));
  const [holdoutPercent, setHoldoutPercent] = useState(initial?.holdout_percent ?? 0);
  const [conflictFamily, setConflictFamily] = useState(initial?.conflict_family ?? "");
  const [journeyPriority, setJourneyPriority] = useState(initial?.journey_priority ?? 4);
  const [conflictPolicy, setConflictPolicy] = useState<ConflictPolicy>(
    initial?.conflict_policy ?? "coexist",
  );
  const [windowStart, setWindowStart] = useState(
    String(initial?.entry_rules?.window_start ?? "08:00"),
  );
  const [windowEnd, setWindowEnd] = useState(String(initial?.entry_rules?.window_end ?? "22:00"));
  const [audience, setAudience] = useState(
    String(initial?.entry_rules?.audience ?? initialAudience ?? "all_active"),
  );
  const [reentry, setReentry] = useState(String(initial?.entry_rules?.reentry ?? "once"));
  const [exitRules, setExitRules] = useState<Record<string, boolean>>(
    initial?.exit_rules ?? {
      deposit: true,
      first_deposit: true,
      login: false,
      voltou_jogar: false,
    },
  );
  const enabledSteps = initialSteps.filter((step) => step.is_enabled !== false);
  const initialEndIndex = enabledSteps.findIndex((step) => step.step_type === "end");
  const initialLoopToPosition = enabledSteps[initialEndIndex]?.config.loop_to_position;
  const loopTailLength =
    typeof initialLoopToPosition === "number" && initialEndIndex > initialLoopToPosition
      ? initialEndIndex - initialLoopToPosition
      : null;
  const [maxLoops, setMaxLoops] = useState(() =>
    endStepMaxLoops(enabledSteps[initialEndIndex]?.config),
  );
  const [steps, setSteps] = useState<Step[]>(() => enabledSteps.flatMap(initialStep));

  // Unsaved changes: Ativar on a draft saves first; on a paused journey it warns.
  const signature = JSON.stringify([
    name,
    description,
    trigger,
    triggerConfig,
    dailyLimit,
    cooldownHours,
    endsAt,
    holdoutPercent,
    conflictFamily,
    journeyPriority,
    conflictPolicy,
    windowStart,
    windowEnd,
    audience,
    reentry,
    exitRules,
    steps,
    maxLoops,
  ]);
  const [savedSignature, setSavedSignature] = useState(signature);
  const dirty = signature !== savedSignature;

  const mutation = useMutation({
    mutationFn: (_signature: string) => {
      if (!name.trim()) throw new Error("Dê um nome para a jornada.");
      if (trigger === "nivel_alterado" && !String(triggerConfig.level ?? "")) {
        throw new Error("Selecione o nível que inicia esta jornada.");
      }
      if (trigger === "inactivity") {
        const hours = Number(triggerConfig.hours);
        if (!(String(triggerConfig.field ?? "") in INACTIVITY_FIELDS)) {
          throw new Error("Escolha a atividade que a jornada observa.");
        }
        if (!Number.isInteger(hours) || hours < 1 || hours > 8760) {
          throw new Error("Informe as horas sem atividade (de 1 a 8760).");
        }
      }
      steps.forEach((s, index) => {
        if (s.kind === "wait" && waitToSeconds(s.amount, s.unit) === null)
          throw new Error(`Informe o tempo de espera da etapa ${index + 1}.`);
      });
      const body = steps.flatMap((s): JourneyStepInput[] =>
        s.kind === "wait"
          ? [
              {
                step_type: "wait",
                config: { delay_seconds: Math.max(60, waitToSeconds(s.amount, s.unit) ?? 0) },
              },
            ]
          : s.kind === "sms"
            ? s.content.trim() && !s.templateId
              ? [{ step_type: "sms", config: { ...s.extra, content: s.content } }]
              : s.templateId && s.content.trim()
                ? [
                    {
                      step_type: "sms",
                      config: {
                        ...s.extra,
                        template_id: s.templateId,
                        content: s.content,
                        template_snapshot: (() => {
                          const template = (smsTemplates.data?.items ?? []).find(
                            (item) => item.id === s.templateId,
                          );
                          return template
                            ? {
                                id: template.id,
                                name: template.name,
                                content: template.content,
                                version: template.version,
                              }
                            : { id: s.templateId, content: s.content };
                        })(),
                      },
                    },
                  ]
                : []
            : s.kind === "email"
              ? s.templateId
                ? [
                    {
                      step_type: "email",
                      config: (() => {
                        const template = (templates.data?.items ?? []).find(
                          (item) => item.id === s.templateId,
                        );
                        return {
                          template_id: s.templateId,
                          ...emailStepIdsForConfig({
                            senderId: s.senderId,
                            shortDomainId: s.shortDomainId,
                          }),
                          ...(template
                            ? {
                                template_snapshot: {
                                  id: template.id,
                                  subject: template.assunto,
                                  body_html: template.corpo,
                                  version: template.version,
                                },
                              }
                            : {}),
                        };
                      })(),
                    },
                  ]
                : []
              : s.assetId
                ? [
                    {
                      step_type: "voice",
                      config: {
                        asset_id: s.assetId,
                        // Hidden field: only an old step's valid number is kept.
                        ...(/^\d{10,15}$/.test(s.callerId) ? { caller_id: s.callerId } : {}),
                        max_attempts: 1,
                        retry_delay_seconds: 86400,
                      },
                    },
                  ]
                : [],
      );
      return save({
        data: {
          id,
          journey: {
            name,
            description: description || null,
            trigger_type: trigger,
            trigger_config: triggerConfig,
            exit_rules: exitRules,
            entry_rules: {
              ...(initial?.entry_rules ?? {}),
              audience,
              window_start: windowStart,
              window_end: windowEnd,
              weekdays: [1, 2, 3, 4, 5, 6, 0],
              reentry,
              reentry_cooldown_hours: cooldownHours,
              max_attempts: 3,
              retry_base_seconds: 60,
            },
            daily_limit: dailyLimit,
            cooldown_hours: cooldownHours,
            ends_at: fromBrtInput(endsAt),
            holdout_percent: holdoutPercent,
            conflict_family: conflictFamily || null,
            journey_priority: journeyPriority,
            conflict_policy: conflictPolicy,
            steps: [
              ...body,
              {
                step_type: "end",
                config:
                  loopTailLength !== null && body.length >= loopTailLength
                    ? { loop_to_position: body.length - loopTailLength, max_loops: maxLoops }
                    : {},
              },
            ],
          },
        },
      });
    },
    onSuccess: async (r, savedAs) => {
      if (!r.id) throw new Error("Jornada salva sem identificador");
      setSavedSignature(savedAs);
      // save_journey_draft edits a draft in place; for an active or paused journey
      // it creates a new draft revision and leaves the live version untouched.
      const createdRevision = Boolean(id) && savedStatus !== "draft";
      toast.success(
        !id
          ? "Jornada criada como rascunho. Ela só envia depois de ativada."
          : createdRevision
            ? `Alterações salvas numa revisão em rascunho. A versão ${journeyStatusLabel(savedStatus).toLowerCase()} continua igual.`
            : "Rascunho salvo",
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["journeys"] }),
        queryClient.invalidateQueries({ queryKey: ["journey", r.id] }),
      ]);
      if (r.id !== id) navigate({ to: "/jornadas/$journeyId", params: { journeyId: r.id } });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const activate = async () => {
    if (!id) return;
    if (dirty && savedStatus === "draft") {
      try {
        await mutation.mutateAsync(signature);
      } catch {
        return;
      }
      statusControl.requestActivate({ id, name, trigger_type: trigger });
      return;
    }
    if (dirty) {
      const confirmed = await requestConfirmation({
        title: "Ativar sem as alterações?",
        description:
          "As alterações que você fez aqui ainda não foram salvas e não entram na jornada. Para usá-las, salve (isso cria uma revisão em rascunho) e ative a revisão.",
        confirmLabel: "Ativar versão salva",
      });
      if (!confirmed) return;
    }
    statusControl.requestActivate({
      id,
      name: initial?.name ?? name,
      trigger_type: initial?.trigger_type ?? trigger,
    });
  };
  const pause = () => {
    if (!id) return;
    statusControl.requestPause({
      id,
      name: initial?.name ?? name,
      inProgress: journeyInProgress(metrics?.byStatus),
    });
  };

  const add = (kind: Step["kind"]) =>
    setSteps((all) => [
      ...all,
      kind === "wait"
        ? { kind, amount: "1", unit: "hours" }
        : kind === "sms"
          ? { kind, templateId: "", content: "" }
          : kind === "email"
            ? { kind, templateId: "", senderId: null, shortDomainId: null }
            : { kind, assetId: "", callerId: "" },
    ]);
  const change = (i: number, value: Step) =>
    setSteps((all) => all.map((s, n) => (n === i ? value : s)));

  const statusAction = id ? (
    savedStatus === "active" ? (
      <Button
        variant="outline"
        className="h-11 md:h-9"
        disabled={statusControl.isPending}
        onClick={pause}
      >
        <Pause className="mr-1 h-4 w-4" aria-hidden="true" /> Pausar
      </Button>
    ) : savedStatus !== "archived" ? (
      <Button
        variant="outline"
        className="h-11 md:h-9"
        disabled={statusControl.isPending || mutation.isPending}
        onClick={() => void activate()}
      >
        <Play className="mr-1 h-4 w-4" aria-hidden="true" />
        {dirty && savedStatus === "draft" ? "Salvar e ativar" : "Ativar"}
      </Button>
    ) : null
  ) : null;
  const saveAction = (
    <Button
      className="h-11 md:h-9"
      disabled={mutation.isPending}
      onClick={() => mutation.mutate(signature)}
    >
      <Save className="mr-1 h-4 w-4" aria-hidden="true" />
      {mutation.isPending ? "Salvando…" : "Salvar"}
    </Button>
  );

  const conflictWarnings = journeyConflicts(
    {
      id: id ?? "new",
      name,
      status: "draft",
      trigger_type: trigger,
      trigger_config: triggerConfig,
      exit_rules: exitRules,
      conflict_family: conflictFamily || null,
      journey_priority: journeyPriority,
    },
    ((otherJourneys.data?.journeys ?? []) as MapJourney[]).filter((journey) => journey.id !== id),
  );

  return (
    <Page className="max-w-3xl">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to="/automacoes" hash="jornadas">
          <ArrowLeft className="mr-1 h-4 w-4" aria-hidden="true" /> Automações
        </Link>
      </Button>
      <PageHeader
        title={id ? initial?.name || "Jornada" : "Nova jornada"}
        subtitle={
          <>
            {journeyStatusLabel(savedStatus)} ·{" "}
            {journeyTriggerLabel(
              initial?.trigger_type ?? trigger,
              initial?.trigger_config ?? triggerConfig,
            )}
            {savedStatus === "draft" && " · só envia depois de ativada"}
            {dirty && " · alterações não salvas"}
          </>
        }
        actions={
          <>
            {id && (
              <Button asChild variant="outline" className="h-11 md:h-9">
                <Link to="/jornadas/$journeyId/relatorio" params={{ journeyId: id }}>
                  Relatório
                </Link>
              </Button>
            )}
            <div className="hidden items-center gap-2 md:flex">
              {statusAction}
              {saveAction}
            </div>
          </>
        }
      />
      {id && (savedStatus === "active" || savedStatus === "paused") && (
        <p className="rounded-xl border border-border bg-card/80 px-4 py-3 text-[12.5px] leading-relaxed text-muted-foreground">
          Esta jornada está {journeyStatusLabel(savedStatus).toLowerCase()}. Salvar cria uma revisão
          em rascunho; a versão {journeyStatusLabel(savedStatus).toLowerCase()} continua como está
          até você ativar a revisão.
        </p>
      )}

      <EditorSection
        title="Gatilho de entrada"
        help="O que coloca o jogador na jornada. Ele só entra se também fizer parte do público escolhido abaixo."
      >
        <Field id="journey-trigger" label="Quando o jogador entra">
          <Select
            value={trigger}
            onValueChange={(nextTrigger) => {
              setTrigger(nextTrigger);
              if (nextTrigger === "inactivity") {
                setTriggerConfig((current) => ({
                  ...current,
                  field:
                    String(current.field ?? "") in INACTIVITY_FIELDS
                      ? current.field
                      : "ultimo_login",
                  hours: Number(current.hours) > 0 ? current.hours : 168,
                }));
              }
              if (nextTrigger === "nivel_alterado") {
                setConflictFamily("progressao_niveis");
                setConflictPolicy("exclusive");
                setJourneyPriority(4);
                setExitRules((current) => ({ ...current, level_changed: true }));
              }
            }}
          >
            <SelectTrigger id="journey-trigger" className="h-10">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Quando algo acontece</SelectLabel>
                {Object.entries(TRIGGER_NAMES).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectGroup>
              <SelectGroup>
                <SelectLabel>Quando nada acontece</SelectLabel>
                <SelectItem value="inactivity">Tempo sem atividade</SelectItem>
              </SelectGroup>
              <SelectGroup>
                <SelectLabel>Sem gatilho</SelectLabel>
                <SelectItem value="manual">Entrada manual ou API</SelectItem>
              </SelectGroup>
              {trigger !== "manual" && trigger !== "inactivity" && !(trigger in TRIGGER_NAMES) && (
                <SelectItem value={trigger}>{trigger}</SelectItem>
              )}
            </SelectContent>
          </Select>
        </Field>
        {trigger === "inactivity" && (
          <div className="space-y-2 border-t border-border pt-4">
            <p className="text-[12.5px] text-muted-foreground">
              {INACTIVITY_TRIGGER_NAME}: o jogador entra quando passa este tempo sem a atividade
              escolhida.
            </p>
            <div className="grid gap-3 sm:max-w-md sm:grid-cols-2">
              <Field id="inactivity-field" label="Sem atividade em">
                <OptionSelect
                  id="inactivity-field"
                  value={String(triggerConfig.field ?? "ultimo_login")}
                  onChange={(field) => setTriggerConfig((current) => ({ ...current, field }))}
                  options={Object.entries(INACTIVITY_FIELDS).map(([value, label]) => ({
                    value,
                    label,
                  }))}
                />
              </Field>
              <Field id="inactivity-hours" label="Horas sem atividade">
                <Input
                  id="inactivity-hours"
                  className="h-10"
                  type="number"
                  min={1}
                  max={8760}
                  value={String(triggerConfig.hours ?? "")}
                  onChange={(event) =>
                    setTriggerConfig((current) => ({
                      ...current,
                      hours: event.target.value === "" ? "" : Number(event.target.value),
                    }))
                  }
                />
              </Field>
            </div>
          </div>
        )}
        {trigger === "nivel_alterado" && (
          <Field
            id="journey-level"
            label="Nível de destino"
            hint="Ao atingir este nível, o jogador sai da jornada do nível anterior e entra nesta."
            className="border-t border-border pt-4 sm:max-w-md"
          >
            <OptionSelect
              id="journey-level"
              value={String(triggerConfig.level ?? "")}
              onChange={(level) => setTriggerConfig((current) => ({ ...current, level }))}
              options={LEVEL_OPTIONS}
              placeholder="Selecione o nível"
            />
          </Field>
        )}
        {trigger in EVENT_AGE_LABELS && (
          <Field
            id="event-max-age"
            label={EVENT_AGE_LABELS[trigger]}
            hint="Evita tratar a base antiga como evento novo. 0 tira o limite."
            className="border-t border-border pt-4 sm:max-w-md"
          >
            <Input
              id="event-max-age"
              className="h-10"
              type="number"
              min={0}
              max={8760}
              value={String(eventMaxAgeHours(trigger, triggerConfig) ?? 0)}
              onChange={(event) =>
                setTriggerConfig((current) => ({
                  ...current,
                  max_event_age_hours: Math.min(
                    8760,
                    Math.max(0, Math.trunc(Number(event.target.value) || 0)),
                  ),
                }))
              }
            />
          </Field>
        )}
      </EditorSection>

      <EditorSection
        title="Identificação"
        help="O nome identifica a jornada para a equipe. A descrição registra o objetivo e não é enviada ao jogador."
      >
        <Field id="journey-name" label="Nome">
          <Input
            id="journey-name"
            className="h-10"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex.: Sumiu depois do primeiro depósito"
          />
        </Field>
        <Field id="journey-description" label="Descrição (opcional)">
          <Textarea
            id="journey-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </EditorSection>

      <EditorSection
        title="Público"
        help="Quem pode entrar depois de cumprir o gatilho. Consentimento e canal disponível são verificados em cada envio."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="journey-audience"
            label="Quem entra"
            hint={journeyAudienceDescription(audience)}
          >
            <OptionSelect
              id="journey-audience"
              value={audience}
              onChange={setAudience}
              options={
                audience in JOURNEY_AUDIENCES &&
                !AUDIENCE_OPTIONS.some((option) => option.value === audience)
                  ? [
                      ...AUDIENCE_OPTIONS,
                      {
                        value: audience,
                        label: JOURNEY_AUDIENCES[audience as keyof typeof JOURNEY_AUDIENCES].label,
                      },
                    ]
                  : AUDIENCE_OPTIONS
              }
            />
          </Field>
          <Field
            id="journey-reentry"
            label="Reentrada"
            hint="Se o mesmo jogador pode voltar à jornada depois de sair dela."
          >
            <OptionSelect
              id="journey-reentry"
              value={reentry}
              onChange={setReentry}
              options={REENTRY_OPTIONS}
            />
          </Field>
        </div>
      </EditorSection>

      <EditorSection
        title="Etapas"
        help="Cada etapa acontece depois que a anterior termina. SMS e e-mail usam templates ativos, e a jornada guarda uma cópia da versão usada para não mudar depois de ativada."
      >
        {steps.length === 0 && (
          <p className="rounded-lg border border-dashed border-border p-4 text-center text-[13px] text-muted-foreground">
            Nenhuma etapa ainda. Comece por uma espera ou por uma mensagem.
          </p>
        )}
        <ol className="space-y-3">
          {steps.map((s, i) => (
            <li key={i} className="rounded-xl border border-border p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-[13.5px] font-semibold">
                  {i + 1}. {STEP_TITLES[s.kind]}
                </h3>
                <IconButton
                  label={`Remover a etapa ${i + 1}`}
                  icon={<Trash2 className="h-4 w-4" aria-hidden="true" />}
                  className="-my-2 text-muted-foreground hover:text-destructive"
                  onClick={() => setSteps((all) => all.filter((_, n) => n !== i))}
                />
              </div>
              {s.kind === "wait" ? (
                <div className="space-y-1.5">
                  <Label htmlFor={`step-${i}-wait`}>Tempo de espera</Label>
                  <div className="flex max-w-sm gap-2">
                    <Input
                      id={`step-${i}-wait`}
                      className="h-10 w-28"
                      inputMode="decimal"
                      value={s.amount}
                      onChange={(e) => change(i, { ...s, amount: e.target.value })}
                    />
                    <div className="flex-1">
                      <OptionSelect
                        ariaLabel="Unidade da espera"
                        value={s.unit}
                        onChange={(unit) => change(i, { ...s, unit: unit as WaitUnit })}
                        options={Object.entries(WAIT_UNITS).map(([value, unit]) => ({
                          value,
                          label: unit.label,
                        }))}
                      />
                    </div>
                  </div>
                  {(() => {
                    const seconds = waitToSeconds(s.amount, s.unit);
                    return seconds !== null && seconds < 60 ? (
                      <p className="text-[12.5px] text-muted-foreground">
                        O mínimo é 1 minuto; menos que isso é salvo como 1 minuto.
                      </p>
                    ) : null;
                  })()}
                </div>
              ) : s.kind === "sms" ? (
                <div className="space-y-2">
                  <Label htmlFor={`step-${i}-sms`}>Template de SMS</Label>
                  <OptionSelect
                    id={`step-${i}-sms`}
                    value={s.templateId}
                    placeholder="Selecione um template de SMS"
                    onChange={(templateId) => {
                      const template = (smsTemplates.data?.items ?? []).find(
                        (item) => item.id === templateId,
                      );
                      change(i, {
                        ...s,
                        templateId,
                        content: template?.content ?? "",
                        extra: smsExtraForTemplateChange(s.extra),
                      });
                    }}
                    options={(smsTemplates.data?.items ?? [])
                      .filter((template) => template.isActive || template.id === s.templateId)
                      .map((template) => ({
                        value: template.id,
                        label: `${template.name} · v${template.version}`,
                      }))}
                  />
                  <Textarea
                    value={s.content}
                    readOnly
                    aria-label="Conteúdo do template"
                    placeholder="Conteúdo do template"
                  />
                  {Array.isArray(s.extra?.variants) && s.extra.variants.length > 1 && (
                    <p className="rounded-md border border-warning/30 bg-warning/10 p-2 text-[12.5px] text-warning">
                      Esta etapa sorteia entre {s.extra.variants.length} variações a cada envio; o
                      texto acima é a primeira. Escolher um template substitui todas.
                    </p>
                  )}
                  <ShortenerFallbackNotice
                    isSuccess={composerOptions.isSuccess}
                    isError={composerOptions.isError}
                    shortenerPending={shortenerPending}
                    hasVerifiedDomain={shortDomains.length > 0}
                  />
                  <ShortDomainSelect
                    domains={shortDomains}
                    value={(s.extra?.short_domain_id as string | null | undefined) ?? null}
                    onChange={(short_domain_id) =>
                      change(i, { ...s, extra: { ...s.extra, short_domain_id } })
                    }
                  />
                </div>
              ) : s.kind === "email" ? (
                <div className="space-y-2">
                  <Label htmlFor={`step-${i}-email`}>Template de e-mail</Label>
                  <OptionSelect
                    id={`step-${i}-email`}
                    value={s.templateId}
                    placeholder="Selecione um template de e-mail"
                    onChange={(templateId) => change(i, { ...s, templateId })}
                    options={(templates.data?.items ?? [])
                      .filter((t) => t.ativo || t.id === s.templateId)
                      .map((t) => ({ value: t.id, label: t.nome }))}
                  />
                  <EmailBlockedNotice
                    isSuccess={composerOptions.isSuccess}
                    isError={composerOptions.isError}
                    hasVerifiedSender={emailSenders.length > 0}
                  />
                  <EmailSenderSelect
                    senders={emailSenders}
                    value={s.senderId}
                    onChange={(senderId) => change(i, { ...s, senderId })}
                  />
                  <ShortenerFallbackNotice
                    isSuccess={composerOptions.isSuccess}
                    isError={composerOptions.isError}
                    shortenerPending={shortenerPending}
                    hasVerifiedDomain={shortDomains.length > 0}
                  />
                  <ShortDomainSelect
                    domains={shortDomains}
                    value={s.shortDomainId}
                    onChange={(shortDomainId) => change(i, { ...s, shortDomainId })}
                  />
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="space-y-2">
                    <Label htmlFor={`step-${i}-voice`}>Áudio da ligação</Label>
                    <OptionSelect
                      id={`step-${i}-voice`}
                      value={s.assetId}
                      placeholder="Selecione um áudio enviado"
                      onChange={(assetId) => change(i, { ...s, assetId })}
                      options={voiceAssetRows.map((asset) => ({
                        value: asset.id,
                        label: asset.name,
                      }))}
                    />
                    <label className="inline-flex h-11 cursor-pointer items-center rounded-md border border-border px-3 text-sm hover:bg-muted md:h-9">
                      <Upload className="mr-2 h-4 w-4" aria-hidden="true" />
                      {uploadAudio.isPending ? "Enviando…" : "Enviar novo áudio"}
                      <input
                        className="sr-only"
                        type="file"
                        accept="audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/ogg"
                        disabled={uploadAudio.isPending}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) uploadAudio.mutate(file);
                          e.currentTarget.value = "";
                        }}
                      />
                    </label>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ol>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="h-11 w-full sm:w-auto md:h-9">
              <Plus className="mr-1 h-4 w-4" aria-hidden="true" /> Adicionar etapa
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            <DropdownMenuItem className="min-h-11 md:min-h-9" onSelect={() => add("wait")}>
              <Clock3 className="mr-2 h-4 w-4" aria-hidden="true" /> Espera
            </DropdownMenuItem>
            <DropdownMenuItem className="min-h-11 md:min-h-9" onSelect={() => add("sms")}>
              <MessageSquare className="mr-2 h-4 w-4" aria-hidden="true" /> SMS
            </DropdownMenuItem>
            <DropdownMenuItem className="min-h-11 md:min-h-9" onSelect={() => add("email")}>
              <Mail className="mr-2 h-4 w-4" aria-hidden="true" /> E-mail
            </DropdownMenuItem>
            <DropdownMenuItem className="min-h-11 md:min-h-9" onSelect={() => add("voice")}>
              <Phone className="mr-2 h-4 w-4" aria-hidden="true" /> Ligação (voz)
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="space-y-3 rounded-lg border border-dashed border-border px-4 py-3 text-[13px] text-muted-foreground">
          <p>
            Fim da jornada
            {loopTailLength !== null && ` · volta às últimas ${loopTailLength} etapa(s) em loop`}
          </p>
          {loopTailLength !== null && (
            <Field
              id="max-loops"
              label="Repetir o loop no máximo"
              hint={`Depois de ${maxLoops} repetição(ões) a jornada termina para o jogador. Máximo ${MAX_LOOPS_LIMIT}.`}
            >
              <Input
                id="max-loops"
                className="h-10 max-w-32"
                type="number"
                min={0}
                max={MAX_LOOPS_LIMIT}
                value={maxLoops}
                onChange={(e) =>
                  setMaxLoops(
                    Math.min(MAX_LOOPS_LIMIT, Math.max(0, Math.trunc(Number(e.target.value) || 0))),
                  )
                }
              />
            </Field>
          )}
        </div>
      </EditorSection>

      <EditorSection
        title="Saída"
        help="A jornada encerra para o jogador quando um destes eventos acontece, para evitar mensagens fora de contexto."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {EXIT_RULE_OPTIONS.map((rule) => (
            <div key={rule.key} className="flex min-h-11 items-center gap-3 md:min-h-0">
              <Checkbox
                id={`exit-${rule.key}`}
                checked={!!exitRules[rule.key]}
                onCheckedChange={(checked) =>
                  setExitRules((current) => ({ ...current, [rule.key]: checked === true }))
                }
              />
              <Label htmlFor={`exit-${rule.key}`} className="cursor-pointer font-normal">
                {rule.label}
              </Label>
            </div>
          ))}
        </div>
        {trigger === "nivel_alterado" && (
          <p className="text-[12.5px] text-muted-foreground">
            Jornadas de nível encerram sozinhas quando o jogador muda de nível, e ele entra na
            jornada do novo nível a partir da primeira etapa.
          </p>
        )}
      </EditorSection>

      <EditorSection
        title="Janela de envio"
        help="Mensagens fora deste horário aguardam a próxima abertura, no horário de Brasília."
      >
        <div className="grid max-w-sm grid-cols-2 gap-3">
          <Field id="window-start" label="De">
            <Input
              id="window-start"
              className="h-10"
              type="time"
              value={windowStart}
              onChange={(e) => setWindowStart(e.target.value)}
            />
          </Field>
          <Field id="window-end" label="Até">
            <Input
              id="window-end"
              className="h-10"
              type="time"
              value={windowEnd}
              onChange={(e) => setWindowEnd(e.target.value)}
            />
          </Field>
        </div>
      </EditorSection>

      <EditorSection
        title="Limites e duração"
        help="Protegem a operação contra envios em excesso. O intervalo entre jornadas não muda as esperas desta jornada."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="daily-limit" label="Limite diário de mensagens">
            <Input
              id="daily-limit"
              className="h-10"
              type="number"
              min={1}
              value={dailyLimit}
              onChange={(e) => setDailyLimit(Number(e.target.value))}
            />
          </Field>
          <Field
            id="cooldown-hours"
            label="Intervalo entre jornadas (horas)"
            hint="Tempo mínimo antes de outra jornada enviar no mesmo canal."
          >
            <Input
              id="cooldown-hours"
              className="h-10"
              type="number"
              min={0}
              value={cooldownHours}
              onChange={(e) => setCooldownHours(Number(e.target.value))}
            />
          </Field>
          <Field
            id="holdout"
            label="Grupo de controle"
            hint={
              holdoutPercent
                ? `${holdoutPercent}% dos jogadores que entrarem ficam sem mensagens, para medir o efeito real em Resultados do CRM.`
                : "Sem grupo de controle: a jornada não mede o efeito incremental."
            }
          >
            <OptionSelect
              id="holdout"
              value={String(holdoutPercent)}
              onChange={(value) => setHoldoutPercent(Number(value))}
              options={HOLDOUT_OPTIONS}
            />
          </Field>
          <Field
            id="ends-at"
            label="Data de término (opcional)"
            hint={
              endsAt
                ? "Horário de Brasília. Depois dessa data ninguém entra e quem estiver na jornada sai."
                : "Sem data: a jornada roda até ser pausada ou arquivada."
            }
          >
            <div className="flex items-center gap-2">
              <Input
                id="ends-at"
                className="h-10"
                type="datetime-local"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
              />
              {endsAt && (
                <Button type="button" variant="ghost" size="sm" onClick={() => setEndsAt("")}>
                  Limpar
                </Button>
              )}
            </div>
          </Field>
        </div>
      </EditorSection>

      <EditorSection
        title="Conflitos entre jornadas"
        help="O que acontece quando outra jornada disputa o mesmo jogador. Na disputa, o menor número de prioridade vence."
      >
        {conflictWarnings.length > 0 && (
          <ul
            className="space-y-1 rounded-md border border-warning/30 bg-warning/10 p-3 text-[12.5px] text-warning"
            role="status"
          >
            {conflictWarnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field id="conflict-family" label="Família">
            <OptionSelect
              id="conflict-family"
              value={conflictFamily || FAMILY_NONE}
              onChange={(value) => setConflictFamily(value === FAMILY_NONE ? "" : value)}
              options={FAMILY_OPTIONS}
            />
          </Field>
          <Field id="journey-priority" label="Prioridade (1 é a maior)">
            <Input
              id="journey-priority"
              className="h-10"
              type="number"
              min={1}
              max={100}
              value={journeyPriority}
              onChange={(event) => setJourneyPriority(Number(event.target.value) || 1)}
            />
          </Field>
          <Field id="conflict-policy" label="Ao competir">
            <OptionSelect
              id="conflict-policy"
              value={conflictPolicy}
              onChange={(value) => setConflictPolicy(value as ConflictPolicy)}
              options={POLICY_OPTIONS}
            />
          </Field>
        </div>
        <p className="text-[12.5px] text-muted-foreground">
          {conflictFamily === "progressao_niveis"
            ? "Ao mudar de nível, a jornada anterior é encerrada antes da entrada na nova jornada."
            : conflictPolicy === "pause_lower_priority"
              ? "No mesmo canal, a jornada com o menor número de prioridade segue; a outra aguarda."
              : "Esta jornada não bloqueia outras jornadas."}
        </p>
      </EditorSection>

      {/* Phones: Salvar / Ativar always at hand, above the bottom tab bar. */}
      <div className="sticky bottom-[calc(60px+env(safe-area-inset-bottom))] z-30 -mx-4 flex gap-2 sm:-mx-6 sm:px-6 border-t border-border bg-background/95 px-4 py-3 backdrop-blur md:hidden [&>*]:flex-1">
        {statusAction}
        {saveAction}
      </div>
      {statusControl.dialogs}
    </Page>
  );
}
