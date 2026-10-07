import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Clock3, Mail, MessageSquare, Phone, Save, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { saveJourney } from "@/lib/journeys.functions";
import { TRIGGER_NAMES } from "@/lib/triggers";
import { listEmailTemplates } from "@/lib/email.functions";
import { listSmsTemplates } from "@/lib/sms-templates.functions";
import {
  createJourneyVoiceUpload,
  finalizeJourneyVoiceUpload,
  listJourneyVoiceAssets,
} from "@/lib/journey-voice-assets.functions";
import { supabase } from "@/integrations/supabase/client";
import type { JourneyStepInput } from "@/lib/journeys.shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Step =
  | { kind: "wait"; seconds: number }
  | { kind: "sms"; templateId: string; content: string }
  | { kind: "email"; templateId: string }
  | { kind: "voice"; assetId: string; callerId: string };
type SavedStep = { step_type: string; config: Record<string, unknown> };

export function JourneyEditor({
  id,
  initial,
  initialSteps = [],
  metrics,
}: {
  id?: string;
  initial?: { name: string; description: string | null; trigger_type: string };
  initialSteps?: SavedStep[];
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
            } | null;
          } catch {
            return null;
          }
        })()
      : null;
  const navigate = useNavigate();
  const save = useServerFn(saveJourney);
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
  const [dailyLimit, setDailyLimit] = useState(1000);
  const [cooldownHours, setCooldownHours] = useState(72);
  const [windowStart, setWindowStart] = useState("08:00");
  const [windowEnd, setWindowEnd] = useState("22:00");
  const [audience, setAudience] = useState("all_active");
  const [exitRules, setExitRules] = useState<Record<string, boolean>>({
    deposit: true,
    first_deposit: true,
    login: false,
    voltou_jogar: false,
  });
  const [steps, setSteps] = useState<Step[]>(() =>
    initialSteps.flatMap((s): Step[] =>
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
              },
            ]
          : s.step_type === "email"
            ? [{ kind: "email" as const, templateId: String(s.config.template_id ?? "") }]
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
      const body = steps.flatMap((s): JourneyStepInput[] =>
        s.kind === "wait"
          ? [{ step_type: "wait", config: { delay_seconds: Math.max(60, s.seconds) } }]
          : s.kind === "sms"
            ? s.templateId && s.content.trim()
              ? [
                  {
                    step_type: "sms",
                    config: {
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
                ? [{ step_type: "email", config: { template_id: s.templateId } }]
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
            exit_rules: exitRules,
            entry_rules: {
              audience,
              window_start: windowStart,
              window_end: windowEnd,
            },
            daily_limit: dailyLimit,
            cooldown_hours: cooldownHours,
            steps: [...body, { step_type: "end", config: {} }],
          },
        },
      });
    },
    onSuccess: (r) => {
      toast.success("Jornada salva como rascunho");
      if (!r.id) throw new Error("Jornada salva sem identificador");
      navigate({ to: "/jornadas/$journeyId", params: { journeyId: r.id } });
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
            ? { kind, templateId: "" }
            : { kind, assetId: "", callerId: "5511980465329" },
    ]);
  const change = (i: number, value: Step) =>
    setSteps((all) => all.map((s, n) => (n === i ? value : s)));
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-4 sm:p-6">
      <Button variant="ghost" size="sm" onClick={() => navigate({ to: "/jornadas" })}>
        <ArrowLeft className="mr-1 h-4 w-4" /> Jornadas
      </Button>
      <div>
        <p className="text-xs font-medium uppercase tracking-[.18em] text-primary">
          Jornadas multicanal
        </p>
        <h1 className="mt-1 text-2xl font-semibold">{id ? "Editar jornada" : "Nova jornada"}</h1>
        <p className="mt-1 text-sm text-muted-foreground">A jornada só envia após ser publicada.</p>
      </div>
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
        <label className="block text-sm font-medium">
          Nome
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block text-sm font-medium">
          Descrição
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="block text-sm font-medium">
          Gatilho de entrada
          <select
            className="mt-1 flex h-10 w-full rounded-md border bg-background px-3 text-sm"
            value={trigger}
            onChange={(e) => setTrigger(e.target.value)}
          >
            <option value="manual">Entrada manual</option>
            {Object.entries(TRIGGER_NAMES).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <section className="rounded-lg border p-4 text-sm">
          <p className="font-medium">Gatilhos de saída</p>
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
        </section>
        <section className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
          <div>
            <p className="font-medium">Quem entra nesta régua</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Todos os jogadores ativos que atingirem o gatilho, respeitando opt-out e
              elegibilidade.
            </p>
            <select
              className="mt-3 flex h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={audience}
              onChange={(event) => setAudience(event.target.value)}
            >
              <option value="all_active">Todos os jogadores ativos</option>
              <option value="vip">Somente VIP</option>
            </select>
          </div>
          <div>
            <p className="font-medium">Proteção contra excesso</p>
            <label className="mt-3 block text-xs text-muted-foreground">
              Limite diário
              <Input
                type="number"
                min={1}
                value={dailyLimit}
                onChange={(e) => setDailyLimit(Number(e.target.value))}
              />
            </label>
            <label className="mt-3 block text-xs text-muted-foreground">
              Cooldown (horas)
              <Input
                type="number"
                min={0}
                value={cooldownHours}
                onChange={(e) => setCooldownHours(Number(e.target.value))}
              />
            </label>
          </div>
        </section>
        <section className="rounded-lg border p-4">
          <p className="font-medium">Quando pode disparar</p>
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
          <div className="flex items-center justify-between">
            <b className="text-sm">Sequência</b>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => add("wait")}>
                <Clock3 className="mr-1 h-4 w-4" /> Espera
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => add("sms")}>
                <MessageSquare className="mr-1 h-4 w-4" /> SMS
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => add("email")}>
                <Mail className="mr-1 h-4 w-4" /> E-mail
              </Button>
            </div>
          </div>
          {steps.map((s, i) => (
            <div key={i} className="rounded-lg border p-4">
              <div className="mb-2 flex justify-between font-medium">
                {s.kind === "wait"
                  ? "Aguardar"
                  : s.kind === "sms"
                    ? "Enviar SMS"
                    : s.kind === "email"
                      ? "Enviar e-mail"
                      : "Fazer ligação"}
                <Button
                  size="icon"
                  variant="ghost"
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
                        kind: "sms",
                        templateId: event.target.value,
                        content: template?.content ?? "",
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
                  <p className="text-xs text-muted-foreground">
                    A jornada guarda uma cópia desta versão para não mudar após a publicação.
                  </p>
                </div>
              ) : s.kind === "email" ? (
                <select
                  className="flex h-10 w-full rounded-md border bg-background px-3 text-sm"
                  value={s.templateId}
                  onChange={(e) => change(i, { kind: "email", templateId: e.target.value })}
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
    </div>
  );
}
