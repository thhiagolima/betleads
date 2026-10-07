import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Mail,
  MessageSquare,
  Phone,
  Plus,
  Send,
} from "lucide-react";
import { toast } from "sonner";

import { LinkTrackingToggle } from "@/components/link-tracking-toggle";
import { MessageVariablePicker } from "@/components/message-variable-picker";
import { SmsTemplateDialog } from "@/components/sms/sms-template-dialog";
import { ScriptFormDialog } from "@/components/ligacoes/script-form-dialog";
import { VoiceAssetUploadDialog } from "@/components/ligacoes/voice-asset-upload-dialog";
import {
  TemplateEditorDialog,
  type EditorTemplate,
} from "@/components/email/template-editor-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { bulkDispatchCalls, listCallScripts } from "@/lib/calls.functions";
import { tenantSafeChannelError } from "@/lib/channel-error";
import {
  getCampaignDraft,
  saveCampaignDraft,
  submitCampaignDraft,
  type CampaignDraftPayload,
} from "@/lib/campaign-drafts.functions";
import {
  listEmailTemplates,
  saveEmailCampaign,
  saveEmailTemplate,
  sendEmailCampaignNow,
} from "@/lib/email.functions";
import { num } from "@/lib/format";
import { MESSAGE_VARIABLES } from "@/lib/message-variables";
import { listJourneyVoiceAssets } from "@/lib/journey-voice-assets.functions";
import {
  resolveCampaignAudience,
  type ResolvedCampaignAudience,
} from "@/lib/sms-audiences.functions";
import { SYSTEM_SMS_AUDIENCES, type SmsAudienceCriteria } from "@/lib/sms-audience-criteria";
import { listSmsAudiences } from "@/lib/sms-audience-crud.functions";
import { listSmsTemplates } from "@/lib/sms-templates.functions";
import { scheduleBulkSms, sendBulkSms } from "@/lib/sms.functions";

type Channel = "sms" | "email" | "voice";
type AudienceOption = { id: string; name: string; criteria: SmsAudienceCriteria; system?: boolean };
type ResolvedAudience = ResolvedCampaignAudience;

const variablePattern = /\{([a-zA-Z0-9_]+)\}/g;
const allowedVariables = new Set(MESSAGE_VARIABLES.map((variable) => variable.key));

function unknownVariables(content: string) {
  return [...content.matchAll(variablePattern)]
    .map((match) => match[1])
    .filter((key) => !allowedVariables.has(key));
}

function smsParts(content: string) {
  if (!content) return 0;
  return content.length <= 160 ? 1 : Math.ceil(content.length / 153);
}

const channelMeta: Record<Channel, { label: string; icon: typeof MessageSquare; tone: string }> = {
  sms: { label: "SMS", icon: MessageSquare, tone: "text-sky-500" },
  email: { label: "E-mail", icon: Mail, tone: "text-violet-500" },
  voice: { label: "Voz", icon: Phone, tone: "text-amber-500" },
};

const fieldIds = {
  name: "campaign-name",
  audienceLabel: "campaign-audience-label",
  audience: "campaign-audience",
  smsTemplateLabel: "campaign-sms-template-label",
  smsTemplate: "campaign-sms-template",
  smsContent: "campaign-sms-content",
  emailTemplateLabel: "campaign-email-template-label",
  emailTemplate: "campaign-email-template",
  voiceSourceLabel: "campaign-voice-source-label",
  voiceSource: "campaign-voice-source",
  schedule: "campaign-schedule",
  validation: "campaign-validation",
  risk: "campaign-risk-confirmation",
};

export function ChannelCampaignComposer({
  open,
  onOpenChange,
  onCreated,
  initialChannel = "sms",
  initialDraftId = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  initialChannel?: Channel;
  initialDraftId?: string | null;
}) {
  const queryClient = useQueryClient();
  const resolveAudience = useServerFn(resolveCampaignAudience);
  const getDraft = useServerFn(getCampaignDraft);
  const saveDraft = useServerFn(saveCampaignDraft);
  const submitDraft = useServerFn(submitCampaignDraft);
  const listAudiences = useServerFn(listSmsAudiences);
  const listSmsTemplateFn = useServerFn(listSmsTemplates);
  const listEmailTemplateFn = useServerFn(listEmailTemplates);
  const listScripts = useServerFn(listCallScripts);
  const listAssets = useServerFn(listJourneyVoiceAssets);
  const sendSms = useServerFn(sendBulkSms);
  const scheduleSms = useServerFn(scheduleBulkSms);
  const saveEmail = useServerFn(saveEmailCampaign);
  const sendEmail = useServerFn(sendEmailCampaignNow);
  const dispatchVoice = useServerFn(bulkDispatchCalls);
  const createEmailTemplate = useServerFn(saveEmailTemplate);

  const [channel, setChannel] = useState<Channel>(initialChannel);
  const [name, setName] = useState("");
  const [audienceId, setAudienceId] = useState("");
  const [audienceCriteria, setAudienceCriteria] = useState<SmsAudienceCriteria | null>(null);
  const [audience, setAudience] = useState<ResolvedAudience | null>(null);
  const [smsTemplateId, setSmsTemplateId] = useState("");
  const [smsContent, setSmsContent] = useState("");
  const smsContentRef = useRef<HTMLTextAreaElement>(null);
  const [emailTemplateId, setEmailTemplateId] = useState("");
  const [voiceMode, setVoiceMode] = useState<"script" | "asset">("asset");
  const [voiceSourceId, setVoiceSourceId] = useState("");
  const [when, setWhen] = useState<"now" | "schedule">("now");
  const [scheduledAt, setScheduledAt] = useState("");
  const [trackLinks, setTrackLinks] = useState(true);
  const [riskConfirmed, setRiskConfirmed] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [smsTemplateDialogOpen, setSmsTemplateDialogOpen] = useState(false);
  const [emailTemplateDialogOpen, setEmailTemplateDialogOpen] = useState(false);
  const [voiceScriptDialogOpen, setVoiceScriptDialogOpen] = useState(false);
  const [voiceUploadDialogOpen, setVoiceUploadDialogOpen] = useState(false);
  const [draftId, setDraftId] = useState<string | null>(initialDraftId);
  const [draftVersion, setDraftVersion] = useState<number | null>(null);
  const [draftState, setDraftState] = useState<"idle" | "dirty" | "saving" | "saved" | "error">(
    "idle",
  );
  const idempotencyKey = useRef(
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : "00000000-0000-4000-8000-000000000000",
  );
  const hydratedDraftId = useRef<string | null>(null);
  const submitted = useRef(false);

  const draftQuery = useQuery({
    queryKey: ["campaign-draft", initialDraftId],
    queryFn: () => getDraft({ data: { id: initialDraftId! } }),
    enabled: open && Boolean(initialDraftId),
  });

  const savedAudiences = useQuery({
    queryKey: ["sms-audiences"],
    queryFn: () => listAudiences(),
    enabled: open,
  });
  const smsTemplatesQuery = useQuery({
    queryKey: ["sms-templates"],
    queryFn: () => listSmsTemplateFn(),
    enabled: open && channel === "sms",
  });
  const emailTemplatesQuery = useQuery({
    queryKey: ["email-templates"],
    queryFn: () => listEmailTemplateFn(),
    enabled: open && channel === "email",
  });
  const scriptsQuery = useQuery({
    queryKey: ["call-scripts"],
    queryFn: () => listScripts(),
    enabled: open && channel === "voice",
  });
  const assetsQuery = useQuery({
    queryKey: ["journey-voice-assets"],
    queryFn: () => listAssets(),
    enabled: open && channel === "voice",
  });

  const audienceOptions = useMemo<AudienceOption[]>(
    () => [
      ...SYSTEM_SMS_AUDIENCES.map((item) => ({ ...item, system: true })),
      ...(
        (savedAudiences.data ?? []) as Array<{
          id: string;
          name: string;
          criteria: SmsAudienceCriteria;
        }>
      ).map((item) => ({ ...item, system: false })),
    ],
    [savedAudiences.data],
  );
  const smsTemplates = (
    (smsTemplatesQuery.data?.items ?? []) as Array<{
      id: string;
      name: string;
      content: string;
      isActive?: boolean;
    }>
  ).filter((item) => item.isActive !== false);
  const emailTemplates = (
    (emailTemplatesQuery.data?.items ?? []) as Array<{
      id: string;
      nome: string;
      name?: string;
      body_html?: string;
      subject?: string;
      assunto?: string;
      ativo?: boolean;
      corpo?: string;
    }>
  ).filter((item) => item.ativo !== false);
  const scripts = (
    (scriptsQuery.data?.scripts ?? []) as Array<{
      id: string;
      name: string;
      content: string;
      status: string;
    }>
  ).filter((item) => item.status === "active");
  const assets = (
    (assetsQuery.data?.assets ?? []) as Array<{
      id: string;
      name: string;
      is_archived?: boolean;
      duration_seconds?: number | null;
    }>
  ).filter((item) => !item.is_archived);

  useEffect(() => {
    if (!open || initialDraftId) return;
    setChannel(initialChannel);
    setName("");
    setAudienceId("");
    setAudienceCriteria(null);
    setAudience(null);
    setSmsTemplateId("");
    setSmsContent("");
    setEmailTemplateId("");
    setVoiceMode("asset");
    setVoiceSourceId("");
    setWhen("now");
    setScheduledAt("");
    setTrackLinks(true);
    setRiskConfirmed(false);
    setSubmitAttempted(false);
    setDraftId(null);
    setDraftVersion(null);
    setDraftState("idle");
    submitted.current = false;
    hydratedDraftId.current = null;
    idempotencyKey.current = crypto.randomUUID();
  }, [open, initialChannel, initialDraftId]);

  useEffect(() => {
    const draft = draftQuery.data;
    if (!open || !draft || hydratedDraftId.current === draft.id) return;
    const payload = draft.payload as Record<string, unknown>;
    setDraftId(draft.id);
    setDraftVersion(draft.version);
    setChannel(draft.channel);
    setName(draft.name);
    setAudienceId(draft.audienceId ?? "");
    setAudienceCriteria((draft.audienceCriteria as SmsAudienceCriteria | null) ?? null);
    setSmsTemplateId(String(payload.smsTemplateId ?? ""));
    setSmsContent(draft.content);
    setEmailTemplateId(String(payload.emailTemplateId ?? ""));
    setVoiceMode(payload.voiceMode === "script" ? "script" : "asset");
    setVoiceSourceId(draft.assetId ?? "");
    setWhen(draft.scheduledAt ? "schedule" : "now");
    setScheduledAt(draft.scheduledAt ? draft.scheduledAt.slice(0, 16) : "");
    setTrackLinks(draft.trackLinks);
    setRiskConfirmed(false);
    setDraftState("saved");
    hydratedDraftId.current = draft.id;
    if (draft.audienceCriteria) {
      audienceMutation.mutate({
        channel: draft.channel,
        criteria: draft.audienceCriteria as SmsAudienceCriteria,
      });
    }
  }, [draftQuery.data, open]);

  const audienceMutation = useMutation({
    mutationFn: ({ criteria, channel }: { criteria: SmsAudienceCriteria; channel: Channel }) =>
      resolveAudience({ data: { criteria, channel } }),
    onSuccess: (result) => setAudience(result),
    onError: (error: Error) => toast.error(tenantSafeChannelError(error)),
  });

  const activeEmailTemplate = emailTemplates.find((item) => item.id === emailTemplateId);
  const activeScript = scripts.find((item) => item.id === voiceSourceId);
  const previewContent =
    channel === "sms"
      ? smsContent
      : channel === "email"
        ? (activeEmailTemplate?.body_html ?? activeEmailTemplate?.corpo ?? "")
        : (activeScript?.content ?? "");
  const invalidVariables = unknownVariables(previewContent);
  const recipients = audience?.eligibleTotal ?? 0;
  const parts = smsParts(smsContent);
  const cost = channel === "sms" ? recipients * parts : recipients;
  const channelLimitError =
    channel === "voice" && recipients > 200
      ? "Voz aceita até 200 destinatários por campanha."
      : null;
  const validationIssues = [
    !name.trim() ? "Informe o nome da campanha." : null,
    !audience || recipients === 0 ? "Escolha um público com destinatários elegíveis." : null,
    channel === "sms" && !smsContent.trim() ? "Escreva ou selecione a mensagem de SMS." : null,
    channel === "email" && !emailTemplateId ? "Selecione um template de e-mail." : null,
    channel === "voice" && !voiceSourceId ? "Selecione um script ou áudio da biblioteca." : null,
    when === "schedule" && !scheduledAt ? "Escolha a data e hora do agendamento." : null,
    when === "schedule" && scheduledAt && new Date(scheduledAt).getTime() < Date.now() + 60_000
      ? "O agendamento deve ter pelo menos um minuto de antecedência."
      : null,
    ...(invalidVariables.length
      ? [`Variáveis não reconhecidas: ${invalidVariables.join(", ")}`]
      : []),
    channelLimitError,
    !riskConfirmed ? "Confirme a revisão de risco antes de enviar." : null,
  ].filter((issue): issue is string => Boolean(issue));

  const draftPayload = useMemo<CampaignDraftPayload>(
    () => ({
      channel,
      name,
      audienceId: audienceId || null,
      audienceCriteria: (audienceCriteria as unknown as Record<string, unknown>) ?? null,
      assetId:
        channel === "sms"
          ? smsTemplateId || null
          : channel === "email"
            ? emailTemplateId || null
            : voiceSourceId || null,
      assetKind:
        channel === "sms" ? "sms_template" : channel === "email" ? "email_template" : voiceMode,
      assetSnapshot:
        channel === "sms"
          ? { content: smsContent }
          : channel === "email"
            ? activeEmailTemplate
              ? {
                  name: activeEmailTemplate.nome ?? activeEmailTemplate.name,
                  subject: activeEmailTemplate.subject ?? activeEmailTemplate.assunto,
                  bodyHtml: activeEmailTemplate.body_html ?? activeEmailTemplate.corpo,
                }
              : null
            : activeScript
              ? { name: activeScript.name, content: activeScript.content }
              : { name: assets.find((item) => item.id === voiceSourceId)?.name ?? "" },
      content: channel === "sms" ? smsContent : previewContent,
      scheduledAt: when === "schedule" && scheduledAt ? new Date(scheduledAt).toISOString() : null,
      trackLinks,
      payload: { smsTemplateId, emailTemplateId, voiceMode },
    }),
    [
      channel,
      name,
      audienceId,
      audienceCriteria,
      smsTemplateId,
      smsContent,
      emailTemplateId,
      voiceSourceId,
      voiceMode,
      activeEmailTemplate,
      activeScript,
      assets,
      previewContent,
      when,
      scheduledAt,
      trackLinks,
    ],
  );
  const serializedDraft = JSON.stringify(draftPayload);

  const autosave = useMutation({
    scope: { id: "campaign-draft-autosave" },
    mutationFn: () =>
      saveDraft({
        data: {
          ...draftPayload,
          id: draftId,
          version: draftVersion,
          idempotencyKey: idempotencyKey.current,
        },
      }),
    onMutate: () => setDraftState("saving"),
    onSuccess: (saved) => {
      setDraftId(saved.id);
      setDraftVersion(saved.version);
      setDraftState("saved");
      queryClient.invalidateQueries({ queryKey: ["campaign-drafts"] });
    },
    onError: () => setDraftState("error"),
  });

  const saveVisualEmailTemplate = useMutation({
    mutationFn: (template: EditorTemplate) =>
      createEmailTemplate({
        data: {
          nome: template.nome,
          assunto: template.assunto,
          preheader: template.preheader,
          fromName: template.fromName,
          categoria: template.categoria,
          tags: template.tags,
          corpo: template.corpo,
          ativo: template.ativo,
          lifecycleStatus: template.lifecycleStatus ?? "published",
          trackLinks: template.trackLinks ?? true,
        },
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["email-templates"] });
      setEmailTemplateId(result.id);
      setEmailTemplateDialogOpen(false);
      toast.success("Template de e-mail criado e selecionado");
    },
    onError: (error: Error) => toast.error(tenantSafeChannelError(error)),
  });

  const emptyEmailTemplate: EditorTemplate = {
    id: "",
    nome: "",
    assunto: "",
    preheader: "",
    fromName: "BETLEADS",
    categoria: "Geral",
    tags: [],
    corpo: "",
    ativo: true,
    trackLinks,
    lifecycleStatus: "published",
    version: 1,
    atualizadoEm: "agora",
  };

  useEffect(() => {
    if (!open || submitted.current || (initialDraftId && !draftQuery.data)) return;
    setDraftState("dirty");
    const timer = window.setTimeout(() => autosave.mutate(), 700);
    return () => window.clearTimeout(timer);
  }, [serializedDraft, open, initialDraftId, draftQuery.data]);

  const submit = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Informe o nome da campanha.");
      if (!audience || recipients === 0)
        throw new Error("Escolha um público com destinatários elegíveis.");
      if (invalidVariables.length)
        throw new Error(`Variáveis inválidas: ${invalidVariables.join(", ")}`);
      if (channelLimitError) throw new Error(channelLimitError);
      if (when === "schedule" && !scheduledAt)
        throw new Error("Escolha a data e hora do agendamento.");
      if (when === "schedule" && new Date(scheduledAt).getTime() < Date.now() + 60_000)
        throw new Error("O agendamento deve ter pelo menos um minuto de antecedência.");
      if (!riskConfirmed) throw new Error("Confirme a revisão de risco antes de enviar.");
      const scheduleAt = when === "schedule" ? new Date(scheduledAt).toISOString() : undefined;

      if (channel === "sms") {
        if (!smsContent.trim()) throw new Error("Escreva ou selecione a mensagem de SMS.");
        const payload = {
          phones: audience.eligibleIdentifiers,
          content: smsContent,
          campaignName: name,
          route: "iGaming" as const,
          ratePerMinute: 1000,
          trackLinks,
          templateId: smsTemplateId || undefined,
        };
        const result =
          when === "schedule"
            ? scheduleSms({ data: { ...payload, scheduledAt: scheduleAt! } })
            : sendSms({ data: payload });
        const completed = await result;
        if (draftId) await submitDraft({ data: { id: draftId } });
        submitted.current = true;
        return completed;
      }
      if (channel === "email") {
        if (!emailTemplateId) throw new Error("Selecione um template de e-mail.");
        const created = await saveEmail({
          data: {
            nome: name,
            audienceMode: "leads",
            segmento: "Público salvo",
            template:
              activeEmailTemplate?.nome ?? activeEmailTemplate?.name ?? "Template selecionado",
            smtp: "Remetente padrão",
            templateId: emailTemplateId,
            smtpId: null,
            agendadoPara: scheduleAt ?? null,
            status: when === "schedule" ? "agendada" : "enviando",
            targetPlayerIds: audience.eligiblePlayerIds,
            extraEmails: [],
            trackLinks,
          },
        } as never);
        const completed =
          when === "schedule"
            ? created
            : sendEmail({ data: { campaignId: (created as { id: string }).id } } as never);
        const result = await completed;
        if (draftId) await submitDraft({ data: { id: draftId } });
        submitted.current = true;
        return result;
      }
      if (!voiceSourceId) throw new Error("Selecione um script ou áudio da biblioteca.");
      const completed = await dispatchVoice({
        data: {
          campaign_name: name,
          scheduled_at: scheduleAt,
          script_id: voiceMode === "script" ? voiceSourceId : undefined,
          asset_id: voiceMode === "asset" ? voiceSourceId : undefined,
          targets: audience.eligibleIdentifiers.map((phone) => ({ phone_number: phone })),
        },
      });
      if (draftId) await submitDraft({ data: { id: draftId } });
      submitted.current = true;
      return completed;
    },
    onSuccess: () => {
      toast.success(
        when === "schedule"
          ? "Campanha agendada com revisão registrada"
          : "Campanha enviada para processamento",
      );
      onCreated();
      onOpenChange(false);
    },
    onError: (error: Error) => toast.error(tenantSafeChannelError(error)),
  });

  const MetaIcon = channelMeta[channel].icon;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && (draftState === "dirty" || draftState === "saving")) {
          const leave = window.confirm(
            "Ainda há alterações sendo salvas. Deseja fechar e continuar depois pelo rascunho?",
          );
          if (!leave) return;
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[94vh] w-[calc(100vw-1rem)] max-w-3xl overflow-y-auto sm:w-full">
        <DialogHeader>
          <div className="flex items-center justify-between gap-3 pr-8">
            <DialogTitle>Composer de campanha</DialogTitle>
            <Badge variant={draftState === "error" ? "destructive" : "secondary"}>
              {draftState === "saving" || draftState === "dirty"
                ? "Salvando…"
                : draftState === "error"
                  ? "Falha ao salvar"
                  : draftState === "saved"
                    ? "Salvo agora"
                    : "Preparando rascunho"}
            </Badge>
          </div>
          <DialogDescription>
            Planeje, revise e dispare SMS, e-mail ou voz em um único fluxo.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-5 md:grid-cols-[1fr_280px]">
          <div className="space-y-5">
            <div className="grid grid-cols-3 gap-2" role="group" aria-label="Canal da campanha">
              {(Object.keys(channelMeta) as Channel[]).map((item) => {
                const Icon = channelMeta[item].icon;
                return (
                  <Button
                    key={item}
                    type="button"
                    variant={channel === item ? "default" : "outline"}
                    className="h-auto py-3"
                    aria-pressed={channel === item}
                    onClick={() => {
                      setChannel(item);
                      const selected = audienceOptions.find((option) => option.id === audienceId);
                      if (selected) {
                        setAudienceCriteria(selected.criteria);
                        audienceMutation.mutate({ criteria: selected.criteria, channel: item });
                      }
                      setRiskConfirmed(false);
                    }}
                  >
                    <Icon className="mr-2 size-4" />
                    {channelMeta[item].label}
                  </Button>
                );
              })}
            </div>
            <div className="space-y-2">
              <Label htmlFor={fieldIds.name}>Nome da campanha</Label>
              <Input
                id={fieldIds.name}
                name="campaign-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Ex.: Bônus de fim de semana"
                aria-invalid={submitAttempted && !name.trim()}
                aria-describedby={fieldIds.validation}
              />
            </div>
            <div className="space-y-2">
              <Label id={fieldIds.audienceLabel}>Público</Label>
              <Select
                value={audienceId}
                onValueChange={(value) => {
                  setAudienceId(value);
                  setAudience(null);
                  const selected = audienceOptions.find((item) => item.id === value);
                  if (selected) {
                    setAudienceCriteria(selected.criteria);
                    audienceMutation.mutate({ criteria: selected.criteria, channel });
                  }
                }}
              >
                <SelectTrigger
                  id={fieldIds.audience}
                  aria-labelledby={fieldIds.audienceLabel}
                  aria-describedby={fieldIds.validation}
                  aria-invalid={
                    submitAttempted && Boolean(!audience && !audienceMutation.isPending)
                  }
                >
                  <SelectValue placeholder="Selecione um público salvo" />
                </SelectTrigger>
                <SelectContent>
                  {audienceOptions.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.system ? `Nível · ${item.name}` : item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="rounded-lg bg-muted/60 px-3 py-2 text-sm" aria-live="polite">
                <strong>{audienceMutation.isPending ? "Calculando..." : num(recipients)}</strong>{" "}
                {channel === "email" ? "e-mail(s) válido(s)" : "telefone(s) válido(s)"}
                {audience && (
                  <span className="text-muted-foreground">
                    {" "}
                    de {num(audience.total)} jogador(es)
                  </span>
                )}
              </p>
              {audience && audience.excludedTotal > 0 && (
                <p className="text-xs text-muted-foreground">
                  {num(audience.excludedTotal)} excluído(s) por cadastro inválido, ausência de
                  contato ou consentimento.
                </p>
              )}
            </div>
            {channel === "sms" && (
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label id={fieldIds.smsTemplateLabel}>Template SMS</Label>
                  <Select
                    value={smsTemplateId}
                    onValueChange={(value) => {
                      setSmsTemplateId(value);
                      const template = smsTemplates.find((item) => item.id === value);
                      if (template) setSmsContent(template.content);
                    }}
                  >
                    <SelectTrigger
                      id={fieldIds.smsTemplate}
                      aria-labelledby={fieldIds.smsTemplateLabel}
                    >
                      <SelectValue placeholder="Mensagem manual" />
                    </SelectTrigger>
                    <SelectContent>
                      {smsTemplates.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setSmsTemplateDialogOpen(true)}
                  >
                    <Plus className="mr-1.5 size-3.5" /> Criar novo template
                  </Button>
                </div>
                <div className="space-y-2">
                  <Label htmlFor={fieldIds.smsContent}>Mensagem</Label>
                  <Textarea
                    ref={smsContentRef}
                    id={fieldIds.smsContent}
                    name="sms-content"
                    rows={5}
                    value={smsContent}
                    onChange={(event) => setSmsContent(event.target.value)}
                    placeholder="Olá {primeiro_nome}, seu bônus está liberado."
                    aria-invalid={
                      submitAttempted && (Boolean(invalidVariables.length) || !smsContent.trim())
                    }
                    aria-describedby={fieldIds.validation}
                  />
                  <MessageVariablePicker
                    channel="sms"
                    textareaRef={smsContentRef}
                    value={smsContent}
                    onChange={setSmsContent}
                  />
                  <p className="text-xs text-muted-foreground">
                    {smsContent.length} caracteres · {parts} parte(s) · estimativa: {num(cost)}{" "}
                    créditos
                  </p>
                </div>
                <LinkTrackingToggle
                  value={trackLinks}
                  onChange={setTrackLinks}
                  content={smsContent}
                  channel="sms"
                />
              </div>
            )}
            {channel === "email" && (
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label id={fieldIds.emailTemplateLabel}>Template de e-mail</Label>
                  <Select value={emailTemplateId} onValueChange={setEmailTemplateId}>
                    <SelectTrigger
                      id={fieldIds.emailTemplate}
                      aria-labelledby={fieldIds.emailTemplateLabel}
                      aria-invalid={submitAttempted && !emailTemplateId}
                      aria-describedby={fieldIds.validation}
                    >
                      <SelectValue placeholder="Selecione um template" />
                    </SelectTrigger>
                    <SelectContent>
                      {emailTemplates.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.nome ?? item.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setEmailTemplateDialogOpen(true)}
                  >
                    <Plus className="mr-1.5 size-3.5" /> Criar novo template
                  </Button>
                </div>
                <LinkTrackingToggle
                  value={trackLinks}
                  onChange={setTrackLinks}
                  content={previewContent}
                  channel="email"
                />
                <p className="text-xs text-muted-foreground">
                  Estimativa: {num(cost)} destinatário(s).
                </p>
                <MessageVariablePicker
                  channel="email"
                  readOnly
                  label="Variáveis aceitas nos templates de e-mail"
                />
              </div>
            )}
            {channel === "voice" && (
              <div className="space-y-3">
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={voiceMode === "asset" ? "default" : "outline"}
                    onClick={() => {
                      setVoiceMode("asset");
                      setVoiceSourceId("");
                    }}
                  >
                    Áudio fixo
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={voiceMode === "script" ? "default" : "outline"}
                    onClick={() => {
                      setVoiceMode("script");
                      setVoiceSourceId("");
                    }}
                  >
                    Script TTS
                  </Button>
                </div>
                <div className="space-y-2">
                  <Label id={fieldIds.voiceSourceLabel}>
                    {voiceMode === "asset" ? "Áudio da biblioteca" : "Script ativo"}
                  </Label>
                  <Select value={voiceSourceId} onValueChange={setVoiceSourceId}>
                    <SelectTrigger
                      id={fieldIds.voiceSource}
                      aria-labelledby={fieldIds.voiceSourceLabel}
                      aria-invalid={submitAttempted && !voiceSourceId}
                      aria-describedby={fieldIds.validation}
                    >
                      <SelectValue placeholder="Selecione uma opção" />
                    </SelectTrigger>
                    <SelectContent>
                      {(voiceMode === "asset" ? assets : scripts).map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      if (voiceMode === "asset") setVoiceUploadDialogOpen(true);
                      else setVoiceScriptDialogOpen(true);
                    }}
                  >
                    <Plus className="mr-1.5 size-3.5" />
                    {voiceMode === "asset" ? "Enviar novo áudio" : "Criar novo script"}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Estimativa: {num(cost)} chamada(s). O limite por campanha é 200 destinatários.
                </p>
                {voiceMode === "script" && (
                  <MessageVariablePicker
                    channel="voice"
                    readOnly
                    label="Variáveis aceitas nos scripts de voz"
                  />
                )}
              </div>
            )}
            {invalidVariables.length > 0 && (
              <p
                className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
                role="alert"
              >
                <AlertTriangle className="size-4 shrink-0" />
                Variáveis não reconhecidas: {invalidVariables.join(", ")}
              </p>
            )}
            <div className="space-y-2">
              <Label>Quando disparar</Label>
              <div className="flex gap-2" role="group" aria-label="Momento do disparo">
                <Button
                  type="button"
                  size="sm"
                  variant={when === "now" ? "default" : "outline"}
                  aria-pressed={when === "now"}
                  onClick={() => setWhen("now")}
                >
                  <Send className="mr-1.5 size-3.5" />
                  Agora
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={when === "schedule" ? "default" : "outline"}
                  aria-pressed={when === "schedule"}
                  onClick={() => setWhen("schedule")}
                >
                  <CalendarClock className="mr-1.5 size-3.5" />
                  Agendar
                </Button>
              </div>
              {when === "schedule" && (
                <>
                  <Input
                    id={fieldIds.schedule}
                    name="campaign-schedule"
                    type="datetime-local"
                    value={scheduledAt}
                    onChange={(event) => setScheduledAt(event.target.value)}
                    aria-invalid={
                      submitAttempted &&
                      when === "schedule" &&
                      (!scheduledAt || new Date(scheduledAt).getTime() < Date.now() + 60_000)
                    }
                    aria-describedby={fieldIds.validation}
                  />
                  {channel === "voice" && (
                    <p className="text-xs text-muted-foreground">
                      O áudio fica preparado na fila; o despacho automático depende do gate
                      operacional de voz.
                    </p>
                  )}
                </>
              )}
            </div>
            <label
              className="flex cursor-pointer items-start gap-3 rounded-lg border border-amber-500/35 bg-amber-500/5 p-3 text-sm"
              htmlFor={fieldIds.risk}
            >
              <Checkbox
                id={fieldIds.risk}
                checked={riskConfirmed}
                onCheckedChange={(value) => setRiskConfirmed(value === true)}
                aria-describedby={fieldIds.validation}
              />
              <span>
                <strong>Confirmo a revisão de risco.</strong>
                <br />
                <span className="text-xs text-muted-foreground">
                  Público, conteúdo, custo estimado, consentimento e horário foram revisados.
                </span>
              </span>
            </label>
            {validationIssues.length > 0 && (
              <div
                id={fieldIds.validation}
                className="rounded-lg border border-amber-500/35 bg-amber-500/5 p-3 text-sm"
                role="status"
                aria-live="polite"
              >
                <p className="font-medium">
                  {submitAttempted ? "Para continuar, corrija:" : "Itens pendentes para envio:"}
                </p>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
                  {validationIssues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <Card className="h-fit border-primary/25">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <MetaIcon className={`size-4 ${channelMeta[channel].tone}`} />
                Prévia e validação
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Badge variant="outline">{channelMeta[channel].label}</Badge>
              <p>
                <strong>{num(recipients)}</strong> destinatário(s)
              </p>
              <p>
                <strong>
                  {channel === "sms"
                    ? `${num(cost)} créditos`
                    : channel === "voice"
                      ? `${num(cost)} chamadas`
                      : `${num(cost)} e-mails`}
                </strong>{" "}
                estimados
              </p>
              <div className="rounded-lg bg-muted/50 p-3 text-xs">
                <p className="mb-1 font-medium">Conteúdo</p>
                <p className="max-h-36 overflow-auto whitespace-pre-wrap text-muted-foreground">
                  {channel === "voice" && voiceMode === "asset"
                    ? (assets.find((item) => item.id === voiceSourceId)?.name ??
                      "Selecione um áudio")
                    : previewContent || "Selecione o conteúdo para visualizar"}
                </p>
              </div>
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <CheckCircle2 className="size-3.5 text-emerald-500" />
                Consentimentos são verificados antes do envio.
              </p>
            </CardContent>
          </Card>
        </div>
        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row">
          <Button className="w-full sm:w-auto" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            className="w-full sm:w-auto"
            disabled={
              submit.isPending ||
              !draftId ||
              draftState === "dirty" ||
              draftState === "saving" ||
              draftState === "error"
            }
            onClick={() => {
              setSubmitAttempted(true);
              submit.mutate();
            }}
            aria-describedby={validationIssues.length ? fieldIds.validation : undefined}
          >
            {submit.isPending
              ? "Processando..."
              : when === "schedule"
                ? "Confirmar agendamento"
                : "Confirmar e enviar"}
          </Button>
        </DialogFooter>
      </DialogContent>
      <SmsTemplateDialog
        open={smsTemplateDialogOpen}
        onOpenChange={setSmsTemplateDialogOpen}
        initialContent={smsContent}
        onCreated={(template) => {
          setSmsTemplateId(template.id);
          setSmsContent(template.content);
        }}
      />
      <TemplateEditorDialog
        open={emailTemplateDialogOpen}
        onOpenChange={setEmailTemplateDialogOpen}
        editing={emptyEmailTemplate}
        onSave={(template) => saveVisualEmailTemplate.mutate(template)}
      />
      <VoiceAssetUploadDialog
        open={voiceUploadDialogOpen}
        onOpenChange={setVoiceUploadDialogOpen}
        onCreated={(asset) => {
          setVoiceMode("asset");
          setVoiceSourceId(asset.id);
        }}
      />
      <ScriptFormDialog
        open={voiceScriptDialogOpen}
        onOpenChange={setVoiceScriptDialogOpen}
        defaultStatus="active"
        onSaved={(script) => {
          setVoiceMode("script");
          setVoiceSourceId(script.id);
        }}
      />
    </Dialog>
  );
}
