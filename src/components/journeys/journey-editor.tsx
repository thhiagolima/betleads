import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Clock3, Mail, MessageSquare, Phone, Save, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { saveJourney } from "@/lib/journeys.functions";
import { listEmailTemplates } from "@/lib/email.functions";
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
  | { kind: "sms"; content: string }
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
  metrics?: { total: number; byStatus: Record<string, number>; exits: Record<string, number> };
}) {
  const navigate = useNavigate();
  const save = useServerFn(saveJourney);
  const templatesFn = useServerFn(listEmailTemplates);
  const voiceAssetsFn = useServerFn(listJourneyVoiceAssets);
  const createVoiceUpload = useServerFn(createJourneyVoiceUpload);
  const finalizeVoiceUpload = useServerFn(finalizeJourneyVoiceUpload);
  const templates = useQuery({
    queryKey: ["journey-email-templates"],
    queryFn: () => templatesFn(),
  });
  const voiceAssets = useQuery({
    queryKey: ["journey-voice-assets"],
    queryFn: () => voiceAssetsFn(),
  });
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
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [trigger, setTrigger] = useState(initial?.trigger_type ?? "manual");
  const [steps, setSteps] = useState<Step[]>(() =>
    initialSteps.flatMap((s) =>
      s.step_type === "wait"
        ? [{ kind: "wait" as const, seconds: Number(s.config.delay_seconds ?? 3600) }]
        : s.step_type === "sms"
          ? [{ kind: "sms" as const, content: String(s.config.content ?? "") }]
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
            ? s.content.trim()
              ? [{ step_type: "sms", config: { content: s.content } }]
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
            steps: [...body, { step_type: "end", config: {} }],
          },
        },
      });
    },
    onSuccess: (r) => {
      toast.success("Jornada salva como rascunho");
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
          ? { kind, content: "" }
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
          Gatilho
          <Input value={trigger} onChange={(e) => setTrigger(e.target.value)} />
        </label>
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
              <Button type="button" size="sm" variant="outline" onClick={() => add("voice")}>
                <Phone className="mr-1 h-4 w-4" /> Voz
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
                <Textarea
                  value={s.content}
                  onChange={(e) => change(i, { kind: "sms", content: e.target.value })}
                  placeholder="Mensagem SMS"
                />
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
                    {(voiceAssets.data?.assets ?? []).map((asset) => (
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
