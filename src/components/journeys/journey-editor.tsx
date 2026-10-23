import { type ReactNode, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  ArrowLeft,
  Clock3,
  HelpCircle,
  Mail,
  MessageSquare,
  Phone,
  Save,
  Trash2,
  Upload,
  X,
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
import { supabase } from "@/integrations/supabase/client";
import type { JourneyStepInput } from "@/lib/journeys.shared";
import { Button } from "@/components/ui/button";
import {
  INACTIVITY_FIELDS,
  INACTIVITY_TRIGGER_NAME,
  emailStepFromConfig,
  emailStepIdsForConfig,
  fromBrtInput,
  smsExtra,
  smsExtraForTemplateChange,
  toBrtInput,
} from "./journey-editor-config";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Page, PageHeader } from "@/components/ui-premium/page-header";

type Step =
  | { kind: "wait"; seconds: number }
  | { kind: "sms"; templateId: string; content: string; extra?: Record<string, unknown> }
  | {
      kind: "email";
      templateId: string;
      senderId: string | null;
      shortDomainId: string | null;
    }
  | { kind: "voice"; assetId: string; callerId: string };
type SavedStep = { step_type: string; config: Record<string, unknown>; is_enabled?: boolean };

const JOURNEY_HELP = {
  name: ["Nome", "Use um nome que deixe claro o objetivo da jornada para a equipe."],
  description: [
    "Descrição",
    "Registre o contexto e a intenção da jornada. Ela não é enviada ao jogador.",
  ],
  trigger: [
    "Gatilho de entrada",
    "É o evento que coloca um jogador na jornada. Ele só entra se também fizer parte do público escolhido.",
  ],
  level: [
    "Nível de destino",
    "O jogador entra nesta jornada ao alcançar este nível. A jornada do nível anterior é encerrada automaticamente.",
  ],
  exit: [
    "Gatilhos de saída",
    "Marque os eventos que devem encerrar a jornada para evitar mensagens fora de contexto.",
  ],
  conflicts: [
    "Conflitos",
    "Define como esta jornada se comporta quando disputa a atenção do mesmo jogador com outra jornada.",
  ],
  family: [
    "Família",
    "Agrupa jornadas relacionadas. A família de níveis garante que o jogador fique em apenas um nível por vez.",
  ],
  priority: ["Prioridade", "Em uma disputa, o menor número vence. Prioridade 1 é a mais alta."],
  policy: [
    "Ao competir",
    "Escolha se as jornadas podem coexistir ou se a menos prioritária deve aguardar.",
  ],
  audience: [
    "Público",
    "Define quem pode entrar depois de cumprir o gatilho. Consentimento e canal disponível ainda são verificados no envio.",
  ],
  reentry: ["Reentrada", "Define se o mesmo jogador pode voltar à jornada após sair dela."],
  dailyLimit: [
    "Limite diário",
    "É o máximo de mensagens desta jornada por dia. Protege a operação contra envios em excesso.",
  ],
  cooldown: [
    "Cooldown",
    "É o intervalo mínimo antes de outra jornada enviar no mesmo canal. Não altera a espera entre etapas desta própria jornada.",
  ],
  holdout: [
    "Grupo de controle",
    "Uma parte sorteada dos jogadores que entram não recebe mensagens. Comparar quem recebeu com quem não recebeu mostra quanto a jornada realmente traz de volta. Esses jogadores ficam sem a régua.",
  ],
  endsAt: [
    "Data de término",
    "Opcional. A partir dela a jornada não recebe novos jogadores e encerra os que ainda estão nela. Sem data, os loops continuam até o jogador mudar de categoria.",
  ],
  window: [
    "Janela de envio",
    "Mensagens fora desse horário aguardam a próxima abertura da janela, no horário de Brasília.",
  ],
  sequence: [
    "Sequência",
    "Monte a ordem das esperas e mensagens. Cada etapa só ocorre depois que a etapa anterior termina.",
  ],
  wait: ["Espera", "Define quantos segundos a jornada aguarda antes da próxima etapa."],
  sms: ["SMS", "Escolha um template aprovado. A jornada guarda uma cópia da versão usada."],
  email: ["E-mail", "Escolha o template de e-mail que será enviado nesta etapa."],
  voice: ["Voz", "Envie um áudio e selecione-o para fazer uma ligação automatizada."],
} as const;

function JourneyHelp({
  id,
  activeId,
  setActiveId,
  help,
}: {
  id: string;
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  help: readonly [string, string];
}) {
  return (
    <Popover open={activeId === id} onOpenChange={(open) => setActiveId(open ? id : null)}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Ajuda: ${help[0]}`}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <HelpCircle className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        collisionPadding={16}
        className="w-[calc(100vw-2rem)] max-w-sm rounded-xl p-4"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-semibold">{help[0]}</p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{help[1]}</p>
          </div>
          <button
            type="button"
            aria-label="Fechar ajuda"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md hover:bg-muted"
            onClick={() => setActiveId(null)}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function JourneyFieldTitle({
  children,
  helpId,
  activeHelp,
  setActiveHelp,
  help,
}: {
  children: ReactNode;
  helpId: string;
  activeHelp: string | null;
  setActiveHelp: (id: string | null) => void;
  help: readonly [string, string];
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span>{children}</span>
      <JourneyHelp id={helpId} activeId={activeHelp} setActiveId={setActiveHelp} help={help} />
    </div>
  );
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
    conflict_policy?: "coexist" | "pause_lower_priority" | "exclusive";
  };
  initialSteps?: SavedStep[];
  initialAudience?: string;
  metrics?: {
    total: number;
    byStatus: Record<string, number>;
    exits: Record<string, number>;
    recovered: number;
    sentByChannel: Record<string, number>;
    cost: number;
    roi: number | null;
  };
}) {
  const draft =
    !id && typeof window !== "undefined"
      ? (() => {
          try {
            return JSON.parse(window.sessionStorage.getItem("journey-draft") ?? "null") as {
              name?: string;
              trigger?: string;
              triggerConfig?: Record<string, unknown>;
            } | null;
          } catch {
            return null;
          }
        })()
      : null;
  const navigate = useNavigate();
  const save = useServerFn(saveJourney);
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
  const [name, setName] = useState(initial?.name ?? draft?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [trigger, setTrigger] = useState(initial?.trigger_type ?? draft?.trigger ?? "manual");
  const [triggerConfig, setTriggerConfig] = useState(
    initial?.trigger_config ?? draft?.triggerConfig ?? {},
  );
  const [dailyLimit, setDailyLimit] = useState(initial?.daily_limit ?? 1000);
  const [cooldownHours, setCooldownHours] = useState(initial?.cooldown_hours ?? 72);
  const [endsAt, setEndsAt] = useState(() => toBrtInput(initial?.ends_at));
  const [holdoutPercent, setHoldoutPercent] = useState(initial?.holdout_percent ?? 0);
  const [conflictFamily, setConflictFamily] = useState(initial?.conflict_family ?? "");
  const [journeyPriority, setJourneyPriority] = useState(initial?.journey_priority ?? 4);
  const [conflictPolicy, setConflictPolicy] = useState<
    "coexist" | "pause_lower_priority" | "exclusive"
  >(initial?.conflict_policy ?? "coexist");
  const [activeHelp, setActiveHelp] = useState<string | null>(null);
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
  const [steps, setSteps] = useState<Step[]>(() =>
    enabledSteps.flatMap((s): Step[] =>
      s.step_type === "wait"
        ? [{ kind: "wait" as const, seconds: Number(s.config.delay_seconds ?? 3600) }]
        : s.step_type === "sms"
          ? [
              {
                kind: "sms" as const,
                templateId: String(s.config.template_id ?? ""),
                content: String(
                  (s.config.template_snapshot as { content?: string } | undefined)?.content ??
                    s.config.content ??
                    "",
                ),
                extra: smsExtra(s.config),
              },
            ]
          : s.step_type === "email"
            ? [{ kind: "email" as const, ...emailStepFromConfig(s.config) }]
            : s.step_type === "voice"
              ? [
                  {
                    kind: "voice" as const,
                    assetId: String(s.config.asset_id ?? ""),
                    callerId: String(s.config.caller_id ?? "5511980465329"),
                  },
                ]
              : [],
    ),
  );
  const mutation = useMutation({
    mutationFn: () => {
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
      const body = steps.flatMap((s): JourneyStepInput[] =>
        s.kind === "wait"
          ? [{ step_type: "wait", config: { delay_seconds: Math.max(60, s.seconds) } }]
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
                        caller_id: s.callerId,
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
                    ? { loop_to_position: body.length - loopTailLength }
                    : {},
              },
            ],
          },
        },
      });
    },
    onSuccess: (r) => {
      toast.success("Jornada salva como rascunho");
      if (!r.id) throw new Error("Jornada salva sem identificador");
      window.sessionStorage.removeItem("journey-draft");
      navigate({ to: "/automacoes" });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const add = (kind: Step["kind"]) =>
    setSteps((all) => [
      ...all,
      kind === "wait"
        ? { kind, seconds: 3600 }
        : kind === "sms"
          ? { kind, templateId: "", content: "" }
          : kind === "email"
            ? { kind, templateId: "", senderId: null, shortDomainId: null }
            : { kind, assetId: "", callerId: "5511980465329" },
    ]);
  const change = (i: number, value: Step) =>
    setSteps((all) => all.map((s, n) => (n === i ? value : s)));
  return (
    <Page className="max-w-3xl">
      <Button variant="ghost" size="sm" onClick={() => navigate({ to: "/automacoes" })}>
        <ArrowLeft className="mr-1 h-4 w-4" /> Jornadas
      </Button>
      <PageHeader subtitle="A jornada só envia após ser publicada." />
      <div className="space-y-5 rounded-xl border p-5">
        {metrics && (
          <section className="rounded-lg border bg-muted/30 p-4 text-sm">
            <div className="font-medium">Execução da jornada</div>
            <div className="mt-2 flex flex-wrap gap-4 text-muted-foreground">
              <span>{metrics.total} entradas</span>
              <span>{metrics.byStatus.active ?? 0} em andamento</span>
              <span>{metrics.byStatus.completed ?? 0} concluídas</span>
              <span>{metrics.byStatus.failed ?? 0} falhas</span>
            </div>
            <div className="mt-3 grid gap-2 border-t pt-3 sm:grid-cols-3">
              <span>
                Enviados:{" "}
                {Object.values(metrics.sentByChannel).reduce((sum, value) => sum + value, 0)}
              </span>
              <span>
                Recuperado:{" "}
                {metrics.recovered.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}
              </span>
              <span>
                Custo estimado:{" "}
                {metrics.cost.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}
                {metrics.roi != null ? ` · ROI ${metrics.roi.toFixed(1)}x` : ""}
              </span>
            </div>
            {Object.keys(metrics.exits).length > 0 && (
              <div className="mt-3 border-t pt-3">
                <p className="font-medium">Saídas por gatilho</p>
                {Object.entries(metrics.exits).map(([reason, count]) => (
                  <p key={reason} className="mt-1 text-muted-foreground">
                    {reason}: {count}
                  </p>
                ))}
              </div>
            )}
          </section>
        )}
        <div className="block text-sm font-medium">
          <JourneyFieldTitle
            helpId="name"
            activeHelp={activeHelp}
            setActiveHelp={setActiveHelp}
            help={JOURNEY_HELP.name}
          >
            Nome
          </JourneyFieldTitle>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="block text-sm font-medium">
          <JourneyFieldTitle
            helpId="description"
            activeHelp={activeHelp}
            setActiveHelp={setActiveHelp}
            help={JOURNEY_HELP.description}
          >
            Descrição
          </JourneyFieldTitle>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="block text-sm font-medium">
          <JourneyFieldTitle
            helpId="trigger"
            activeHelp={activeHelp}
            setActiveHelp={setActiveHelp}
            help={JOURNEY_HELP.trigger}
          >
            Gatilho de entrada
          </JourneyFieldTitle>
          <select
            className="mt-1 flex h-10 w-full rounded-md border bg-background px-3 text-sm"
            value={trigger}
            onChange={(e) => {
              const nextTrigger = e.target.value;
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
            <option value="manual">Entrada manual</option>
            <option value="inactivity">{INACTIVITY_TRIGGER_NAME}</option>
            {Object.entries(TRIGGER_NAMES).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {trigger === "inactivity" && (
          <section className="rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm">
            <p className="font-medium">{INACTIVITY_TRIGGER_NAME}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              O jogador entra quando passa este tempo sem a atividade escolhida.
            </p>
            <div className="mt-3 grid max-w-sm grid-cols-2 gap-2">
              <label className="text-sm font-medium">
                Sem atividade em
                <select
                  className="mt-1 flex h-10 w-full rounded-md border bg-background px-3 text-sm"
                  value={String(triggerConfig.field ?? "ultimo_login")}
                  onChange={(event) =>
                    setTriggerConfig((current) => ({ ...current, field: event.target.value }))
                  }
                >
                  {Object.entries(INACTIVITY_FIELDS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm font-medium">
                Horas
                <Input
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
              </label>
            </div>
          </section>
        )}
        {trigger === "nivel_alterado" && (
          <section className="rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm">
            <JourneyFieldTitle
              helpId="level"
              activeHelp={activeHelp}
              setActiveHelp={setActiveHelp}
              help={JOURNEY_HELP.level}
            >
              Nível de destino
            </JourneyFieldTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Ao atingir este nível, o jogador sai da jornada do nível anterior e entra nesta.
            </p>
            <select
              className="mt-3 flex h-10 w-full max-w-sm rounded-md border bg-background px-3 text-sm"
              value={String(triggerConfig.level ?? "")}
              onChange={(event) =>
                setTriggerConfig((current) => ({ ...current, level: event.target.value }))
              }
            >
              <option value="">Selecione o nível</option>
              <option value="bronze">Bronze</option>
              <option value="silver">Prata</option>
              <option value="gold">Ouro</option>
              <option value="diamond">Diamante</option>
              <option value="black">Black VIP</option>
            </select>
          </section>
        )}
        <section className="rounded-lg border p-4 text-sm">
          <JourneyFieldTitle
            helpId="exit"
            activeHelp={activeHelp}
            setActiveHelp={setActiveHelp}
            help={JOURNEY_HELP.exit}
          >
            Gatilhos de saída
          </JourneyFieldTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            A jornada encerra para o jogador quando um destes eventos ocorre.
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {[
              { key: "deposit", label: "Realizou depósito" },
              { key: "first_deposit", label: "Fez primeiro depósito" },
              { key: "login", label: "Fez login" },
              { key: "voltou_jogar", label: "Voltou a jogar" },
            ].map((rule) => (
              <label key={rule.key} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={!!exitRules[rule.key]}
                  onChange={(e) =>
                    setExitRules((current) => ({ ...current, [rule.key]: e.target.checked }))
                  }
                />
                {rule.label}
              </label>
            ))}
          </div>
          {trigger === "nivel_alterado" && (
            <p className="mt-3 text-xs text-muted-foreground">
              Jornadas de nível encerram sozinhas quando o jogador muda de nível, e ele entra na
              jornada do novo nível a partir da primeira etapa.
            </p>
          )}
        </section>
        <section className="rounded-lg border p-4 text-sm">
          <JourneyFieldTitle
            helpId="conflicts"
            activeHelp={activeHelp}
            setActiveHelp={setActiveHelp}
            help={JOURNEY_HELP.conflicts}
          >
            Conflitos entre jornadas
          </JourneyFieldTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Use uma família para definir como jornadas relacionadas se comportam para o mesmo
            jogador.
          </p>
          {(() => {
            const warnings = journeyConflicts(
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
              ((otherJourneys.data?.journeys ?? []) as MapJourney[]).filter(
                (journey) => journey.id !== id,
              ),
            );
            return warnings.length ? (
              <ul
                className="mt-3 space-y-1 rounded-md border border-warning/30 bg-warning/10 p-3 text-xs text-warning"
                role="status"
              >
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null;
          })()}
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <div className="block text-xs text-muted-foreground">
              <JourneyFieldTitle
                helpId="family"
                activeHelp={activeHelp}
                setActiveHelp={setActiveHelp}
                help={JOURNEY_HELP.family}
              >
                Família
              </JourneyFieldTitle>
              <select
                className="mt-1 flex h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={conflictFamily}
                onChange={(event) => setConflictFamily(event.target.value)}
              >
                <option value="">Sem família</option>
                <option value="progressao_niveis">Progressão de níveis</option>
              </select>
            </div>
            <div className="block text-xs text-muted-foreground">
              <JourneyFieldTitle
                helpId="priority"
                activeHelp={activeHelp}
                setActiveHelp={setActiveHelp}
                help={JOURNEY_HELP.priority}
              >
                Prioridade (1 é maior)
              </JourneyFieldTitle>
              <Input
                className="mt-1"
                type="number"
                min={1}
                max={100}
                value={journeyPriority}
                onChange={(event) => setJourneyPriority(Number(event.target.value) || 1)}
              />
            </div>
            <div className="block text-xs text-muted-foreground">
              <JourneyFieldTitle
                helpId="policy"
                activeHelp={activeHelp}
                setActiveHelp={setActiveHelp}
                help={JOURNEY_HELP.policy}
              >
                Ao competir
              </JourneyFieldTitle>
              <select
                className="mt-1 flex h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={conflictPolicy}
                onChange={(event) =>
                  setConflictPolicy(
                    event.target.value as "coexist" | "pause_lower_priority" | "exclusive",
                  )
                }
              >
                <option value="coexist">Permitir coexistência</option>
                <option value="pause_lower_priority">Pausar a menor prioridade</option>
                <option value="exclusive">Manter apenas esta família</option>
              </select>
            </div>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            {conflictFamily === "progressao_niveis"
              ? "Prévia: ao mudar de nível, a jornada anterior é encerrada antes da entrada na nova jornada."
              : conflictPolicy === "pause_lower_priority"
                ? "Prévia: para o mesmo canal, a jornada com menor número de prioridade segue; a outra aguarda."
                : "Prévia: esta jornada não bloqueará outras jornadas."}
          </p>
        </section>
        <section className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
          <div>
            <JourneyFieldTitle
              helpId="audience"
              activeHelp={activeHelp}
              setActiveHelp={setActiveHelp}
              help={JOURNEY_HELP.audience}
            >
              Quem entra nesta jornada
            </JourneyFieldTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Todos os jogadores ativos que atingirem o gatilho, respeitando opt-out e
              elegibilidade.
            </p>
            <select
              className="mt-3 flex h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={audience}
              onChange={(event) => setAudience(event.target.value)}
            >
              <option value="system:all-leads">Todos os leads do tenant</option>
              <option value="all_active">Todos os jogadores ativos</option>
              <option value="vip">Somente VIP</option>
            </select>
            <div className="mt-3 block text-xs text-muted-foreground">
              <JourneyFieldTitle
                helpId="reentry"
                activeHelp={activeHelp}
                setActiveHelp={setActiveHelp}
                help={JOURNEY_HELP.reentry}
              >
                Reentrada
              </JourneyFieldTitle>
              <select
                className="mt-1 flex h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={reentry}
                onChange={(e) => setReentry(e.target.value)}
              >
                <option value="once">Uma única vez</option>
                <option value="per_occurrence">A cada ocorrência</option>
                <option value="after_cooldown">Após o cooldown</option>
                <option value="never">Nunca reentrar</option>
              </select>
            </div>
          </div>
          <div>
            <p className="font-medium">Proteção contra excesso</p>
            <div className="mt-3 block text-xs text-muted-foreground">
              <JourneyFieldTitle
                helpId="daily-limit"
                activeHelp={activeHelp}
                setActiveHelp={setActiveHelp}
                help={JOURNEY_HELP.dailyLimit}
              >
                Limite diário
              </JourneyFieldTitle>
              <Input
                type="number"
                min={1}
                value={dailyLimit}
                onChange={(e) => setDailyLimit(Number(e.target.value))}
              />
            </div>
            <div className="mt-3 block text-xs text-muted-foreground">
              <JourneyFieldTitle
                helpId="cooldown"
                activeHelp={activeHelp}
                setActiveHelp={setActiveHelp}
                help={JOURNEY_HELP.cooldown}
              >
                Cooldown (horas)
              </JourneyFieldTitle>
              <Input
                type="number"
                min={0}
                value={cooldownHours}
                onChange={(e) => setCooldownHours(Number(e.target.value))}
              />
            </div>
            <div className="mt-3 block text-xs text-muted-foreground">
              <JourneyFieldTitle
                helpId="holdout"
                activeHelp={activeHelp}
                setActiveHelp={setActiveHelp}
                help={JOURNEY_HELP.holdout}
              >
                Grupo de controle
              </JourneyFieldTitle>
              <select
                className="flex h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={holdoutPercent}
                onChange={(e) => setHoldoutPercent(Number(e.target.value))}
                aria-label="Grupo de controle"
              >
                <option value={0}>Desligado</option>
                <option value={5}>5% não recebem mensagens</option>
                <option value={10}>10% não recebem mensagens</option>
              </select>
              <p className="mt-1">
                {holdoutPercent
                  ? `${holdoutPercent}% dos jogadores que entrarem ficam sem mensagens, para medir o efeito real em Resultados do CRM.`
                  : "Sem grupo de controle: a jornada não mede o efeito incremental."}
              </p>
            </div>
            <div className="mt-3 block text-xs text-muted-foreground">
              <JourneyFieldTitle
                helpId="ends-at"
                activeHelp={activeHelp}
                setActiveHelp={setActiveHelp}
                help={JOURNEY_HELP.endsAt}
              >
                Data de término (opcional)
              </JourneyFieldTitle>
              <div className="flex items-center gap-2">
                <Input
                  type="datetime-local"
                  value={endsAt}
                  onChange={(e) => setEndsAt(e.target.value)}
                  aria-label="Data de término, horário de Brasília"
                />
                {endsAt && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setEndsAt("")}>
                    Limpar
                  </Button>
                )}
              </div>
              <p className="mt-1">
                {endsAt
                  ? "Horário de Brasília. Depois dessa data ninguém entra e quem estiver na jornada sai."
                  : "Sem data: a jornada roda até ser pausada ou arquivada."}
              </p>
            </div>
          </div>
        </section>
        <section className="rounded-lg border p-4">
          <JourneyFieldTitle
            helpId="window"
            activeHelp={activeHelp}
            setActiveHelp={setActiveHelp}
            help={JOURNEY_HELP.window}
          >
            Quando pode disparar
          </JourneyFieldTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Mensagens fora da janela aguardam a próxima abertura, no horário de Brasília.
          </p>
          <div className="mt-3 flex max-w-sm items-center gap-2">
            <Input
              type="time"
              value={windowStart}
              onChange={(e) => setWindowStart(e.target.value)}
            />
            <span>até</span>
            <Input type="time" value={windowEnd} onChange={(e) => setWindowEnd(e.target.value)} />
          </div>
        </section>
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <JourneyFieldTitle
              helpId="sequence"
              activeHelp={activeHelp}
              setActiveHelp={setActiveHelp}
              help={JOURNEY_HELP.sequence}
            >
              Sequência
            </JourneyFieldTitle>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => add("wait")}>
                <Clock3 className="mr-1 h-4 w-4" /> Espera
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => add("sms")}>
                <MessageSquare className="mr-1 h-4 w-4" /> SMS
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => add("email")}>
                <Mail className="mr-1 h-4 w-4" /> E-mail
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => add("voice")}>
                <Phone className="mr-1 h-4 w-4" /> Voz
              </Button>
            </div>
          </div>
          {steps.map((s, i) => (
            <div key={i} className="rounded-lg border p-4">
              <div className="mb-2 flex items-center justify-between gap-2 font-medium">
                <JourneyFieldTitle
                  helpId={`step-${i}`}
                  activeHelp={activeHelp}
                  setActiveHelp={setActiveHelp}
                  help={
                    s.kind === "wait"
                      ? JOURNEY_HELP.wait
                      : s.kind === "sms"
                        ? JOURNEY_HELP.sms
                        : s.kind === "email"
                          ? JOURNEY_HELP.email
                          : JOURNEY_HELP.voice
                  }
                >
                  {s.kind === "wait"
                    ? "Aguardar"
                    : s.kind === "sms"
                      ? "Enviar SMS"
                      : s.kind === "email"
                        ? "Enviar e-mail"
                        : "Fazer ligação"}
                </JourneyFieldTitle>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Remover etapa"
                  onClick={() => setSteps((all) => all.filter((_, n) => n !== i))}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              {s.kind === "wait" ? (
                <Input
                  type="number"
                  min={60}
                  value={s.seconds}
                  onChange={(e) => change(i, { kind: "wait", seconds: Number(e.target.value) })}
                />
              ) : s.kind === "sms" ? (
                <div className="space-y-2">
                  <select
                    className="flex h-10 w-full rounded-md border bg-background px-3 text-sm"
                    value={s.templateId}
                    onChange={(event) => {
                      const template = (smsTemplates.data?.items ?? []).find(
                        (item) => item.id === event.target.value,
                      );
                      change(i, {
                        ...s,
                        templateId: event.target.value,
                        content: template?.content ?? "",
                        extra: smsExtraForTemplateChange(s.extra),
                      });
                    }}
                  >
                    <option value="">Selecione um template SMS</option>
                    {(smsTemplates.data?.items ?? [])
                      .filter((template) => template.isActive)
                      .map((template) => (
                        <option key={template.id} value={template.id}>
                          {template.name} · v{template.version}
                        </option>
                      ))}
                  </select>
                  <Textarea value={s.content} readOnly placeholder="Conteúdo do template" />
                  {Array.isArray(s.extra?.variants) && s.extra.variants.length > 1 && (
                    <p className="rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-warning">
                      Este passo sorteia entre {s.extra.variants.length} variações a cada envio; o
                      texto acima é a primeira. Escolher um template substitui todas.
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    A jornada guarda uma cópia desta versão para não mudar após a publicação.
                  </p>
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
                  <select
                    className="flex h-10 w-full rounded-md border bg-background px-3 text-sm"
                    value={s.templateId}
                    onChange={(e) => change(i, { ...s, templateId: e.target.value })}
                  >
                    <option value="">Selecione um template</option>
                    {(templates.data?.items ?? [])
                      .filter((t) => t.ativo)
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.nome}
                        </option>
                      ))}
                  </select>
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
                <div className="space-y-2">
                  <label className="inline-flex cursor-pointer items-center rounded-md border px-3 py-2 text-sm hover:bg-muted">
                    <Upload className="mr-2 h-4 w-4" />{" "}
                    {uploadAudio.isPending ? "Enviando..." : "Enviar áudio"}
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
                  <select
                    className="flex h-10 w-full rounded-md border bg-background px-3 text-sm"
                    value={s.assetId}
                    onChange={(e) => change(i, { ...s, assetId: e.target.value })}
                  >
                    <option value="">Selecione o áudio enviado</option>
                    {voiceAssetRows.map((asset) => (
                      <option key={asset.id} value={asset.id}>
                        {asset.name}
                      </option>
                    ))}
                  </select>
                  <Input
                    value={s.callerId}
                    onChange={(e) =>
                      change(i, { ...s, callerId: e.target.value.replace(/\D/g, "") })
                    }
                    placeholder="Número de origem"
                  />
                </div>
              )}
            </div>
          ))}
          <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
            Encerrar jornada
          </div>
        </section>
        <Button disabled={!name.trim() || mutation.isPending} onClick={() => mutation.mutate()}>
          <Save className="mr-2 h-4 w-4" /> Salvar rascunho
        </Button>
      </div>
    </Page>
  );
}
