import { useEffect, useMemo, useRef, useState } from "react";
import { CHANNEL_IDENTITY } from "@/components/identity/identity";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle,
  CheckCircle2,
  Mail,
  MessageSquare,
  Phone,
  Plus,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";

import type { Json } from "@/integrations/supabase/types";

import { MessageVariablePicker } from "@/components/message-variable-picker";
import { SmsTemplateDialog } from "@/components/sms/sms-template-dialog";
import { ScriptFormDialog } from "@/components/ligacoes/script-form-dialog";
import { VoiceAssetUploadDialog } from "@/components/ligacoes/voice-asset-upload-dialog";
import {
  TemplateEditorDialog,
  type EditorTemplate,
} from "@/components/email/template-editor-dialog";
import { SegmentedFilter } from "@/components/players/segmented-filter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { cn } from "@/lib/utils";
import { bulkDispatchCalls, listCallScripts } from "@/lib/calls.functions";
import { tenantSafeChannelError } from "@/lib/channel-error";
import {
  getCampaignDraft,
  saveCampaignDraft,
  submitCampaignDraft,
  type CampaignDraft,
  type CampaignDraftPayload,
} from "@/lib/campaign-drafts.functions";
import {
  listEmailTemplates,
  saveEmailCampaign,
  saveEmailTemplate,
  sendEmailCampaignNow,
} from "@/lib/email.functions";
import { brl, num } from "@/lib/format";
import { getBillingPrices } from "@/lib/billing/billing.functions";
import { countSmsSegments } from "@/lib/sms-segments";
import { unknownMessageVariables } from "@/lib/message-variables";
import { listJourneyVoiceAssets } from "@/lib/journey-voice-assets.functions";
import {
  resolveCampaignAudience,
  type ResolvedCampaignAudience,
} from "@/lib/sms-audiences.functions";
import { SYSTEM_SMS_AUDIENCES, type SmsAudienceCriteria } from "@/lib/sms-audience-criteria";
import { listSmsAudiences } from "@/lib/sms-audience-crud.functions";
import { listSmsTemplates } from "@/lib/sms-templates.functions";
import { previewSmsCampaignRecipients, scheduleBulkSms, sendBulkSms } from "@/lib/sms.functions";
import { fromBrtInput, toBrtInput } from "@/components/journeys/journey-editor-config";
import { getComposerOptions } from "@/lib/house-config.functions";
import { COMPOSER_OPTIONS_QUERY_KEY } from "@/components/house-config/house-config-query";
import { ShortDomainSelect } from "@/components/house-config/short-domain-select";
import {
  EmailSenderSelect,
  EMAIL_BLOCKED_WARNING,
} from "@/components/house-config/email-sender-select";
import {
  EmailBlockedNotice,
  ShortenerFallbackNotice,
} from "@/components/house-config/composer-notices";
import { LinkInsertMenu } from "@/components/house-config/link-insert-menu";
import { UNRESOLVED_REASONS, type UnresolvedReason } from "@/lib/campaign-recipients";
import {
  alreadySentSuffix,
  campaignPausedForBalanceMessage,
  type EmailCampaignRunResult,
} from "@/lib/email-campaign-messages";
import {
  EXTERNAL_LIST_MAX_PHONES,
  externalListBlockedVariables,
  externalListVariablesError,
  parsePhoneList,
} from "@/lib/campaign-external-list";
import { PHONE_LIST_FILE_ACCEPT, readPhoneListFile } from "@/lib/phone-list-file";
import { requestConfirmation, requestTextInput } from "@/components/system-dialog-host";
import {
  campaignSendLabel,
  requiresTypedConfirmation,
  typedCountMatches,
} from "./campaign-send-confirmation";

type Channel = "sms" | "email" | "voice";
type AudienceOption = { id: string; name: string; criteria: SmsAudienceCriteria; system?: boolean };
type ResolvedAudience = ResolvedCampaignAudience;

/** Audience option of SMS campaigns to numbers that are not players. */
const EXTERNAL_LIST_ID = "external:list";

const channelMeta: Record<Channel, { label: string; icon: typeof MessageSquare }> = {
  sms: { label: "SMS", icon: MessageSquare },
  email: { label: "E-mail", icon: Mail },
  voice: { label: "Voz", icon: Phone },
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
};

export function ChannelCampaignComposer({
  open,
  onOpenChange,
  onCreated,
  initialChannel = "sms",
  initialDraftId = null,
  initialAudienceId = "",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  initialChannel?: Channel;
  initialDraftId?: string | null;
  initialAudienceId?: string;
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
  const previewSmsRecipients = useServerFn(previewSmsCampaignRecipients);
  const saveEmail = useServerFn(saveEmailCampaign);
  const sendEmail = useServerFn(sendEmailCampaignNow);
  const dispatchVoice = useServerFn(bulkDispatchCalls);
  const createEmailTemplate = useServerFn(saveEmailTemplate);
  const getComposerOpts = useServerFn(getComposerOptions);

  const composerOptions = useQuery({
    queryKey: COMPOSER_OPTIONS_QUERY_KEY,
    queryFn: () => getComposerOpts(),
    enabled: open,
  });
  const siteUrl = composerOptions.data?.siteUrl ?? null;
  const quickLinks = composerOptions.data?.quickLinks ?? [];
  const shortDomains = composerOptions.data?.shortDomains ?? [];
  const shortenerPending = composerOptions.data?.shortenerPending ?? false;
  const emailSenders = composerOptions.data?.senders ?? [];
  // Only a confirmed-empty sender list blocks sending — while the query is
  // still loading or failed, we don't know yet, so we don't block on it.
  const emailBlocked = composerOptions.isSuccess && emailSenders.length === 0;
  const getPrices = useServerFn(getBillingPrices);

  const [channel, setChannel] = useState<Channel>(initialChannel);
  const [name, setName] = useState("");
  const [audienceId, setAudienceId] = useState(initialAudienceId);
  const [audienceCriteria, setAudienceCriteria] = useState<SmsAudienceCriteria | null>(null);
  const [audience, setAudience] = useState<ResolvedAudience | null>(null);
  // External list: pasted text and the text read from an uploaded file. The
  // numbers are never saved as players nor in the draft.
  const [externalText, setExternalText] = useState("");
  const [externalFile, setExternalFile] = useState<{ name: string; text: string } | null>(null);
  const [externalFileLoading, setExternalFileLoading] = useState(false);
  const externalFileRef = useRef<HTMLInputElement>(null);
  const [smsTemplateId, setSmsTemplateId] = useState("");
  const [smsContent, setSmsContent] = useState("");
  const smsContentRef = useRef<HTMLTextAreaElement>(null);
  const [emailTemplateId, setEmailTemplateId] = useState("");
  // null = "padrão da casa" (the tenant's current default verified domain/sender).
  const [shortDomainId, setShortDomainId] = useState<string | null>(null);
  const [senderId, setSenderId] = useState<string | null>(null);
  const [voiceMode, setVoiceMode] = useState<"script" | "asset">("asset");
  const [voiceSourceId, setVoiceSourceId] = useState("");
  const [when, setWhen] = useState<"now" | "schedule">("now");
  const [scheduledAt, setScheduledAt] = useState("");
  const trackLinks = true;
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
  const pricesQuery = useQuery({
    queryKey: ["billing-prices"],
    queryFn: () => getPrices(),
    enabled: open,
    staleTime: 5 * 60_000,
  });
  const smsPrice = pricesQuery.data?.sms ?? null;
  const smsExempt = smsPrice?.exempt ?? false;
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
      version?: number;
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
    setAudienceId(initialAudienceId);
    setAudienceCriteria(null);
    setAudience(null);
    setExternalText("");
    setExternalFile(null);
    setSmsTemplateId("");
    setSmsContent("");
    setEmailTemplateId("");
    setShortDomainId(null);
    setSenderId(null);
    setVoiceMode("asset");
    setVoiceSourceId("");
    setWhen("now");
    setScheduledAt("");
    setSubmitAttempted(false);
    setDraftId(null);
    setDraftVersion(null);
    setDraftState("idle");
    submitted.current = false;
    hydratedDraftId.current = null;
    idempotencyKey.current = crypto.randomUUID();
  }, [open, initialChannel, initialDraftId, initialAudienceId]);

  useEffect(() => {
    const draft = draftQuery.data as CampaignDraft | undefined;
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
    setShortDomainId((payload.shortDomainId as string | null | undefined) ?? null);
    setSenderId((payload.senderId as string | null | undefined) ?? null);
    setVoiceMode(payload.voiceMode === "script" ? "script" : "asset");
    setVoiceSourceId(draft.assetId ?? "");
    setWhen(draft.scheduledAt ? "schedule" : "now");
    setScheduledAt(toBrtInput(draft.scheduledAt));
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

  useEffect(() => {
    if (!open || initialDraftId || !initialAudienceId) return;
    const selected = audienceOptions.find((item) => item.id === initialAudienceId);
    if (!selected) return;
    setAudienceId(selected.id);
    setAudienceCriteria(selected.criteria);
    audienceMutation.mutate({ criteria: selected.criteria, channel });
  }, [audienceOptions, channel, initialAudienceId, initialDraftId, open]);

  const activeEmailTemplate = emailTemplates.find((item) => item.id === emailTemplateId);
  const activeScript = scripts.find((item) => item.id === voiceSourceId);
  const previewContent =
    channel === "sms"
      ? smsContent
      : channel === "email"
        ? (activeEmailTemplate?.body_html ?? activeEmailTemplate?.corpo ?? "")
        : (activeScript?.content ?? "");
  const invalidVariables = unknownMessageVariables(previewContent, channel);
  const isExternalList = channel === "sms" && audienceId === EXTERNAL_LIST_ID;
  const externalList = useMemo(
    () => parsePhoneList(`${externalText}\n${externalFile?.text ?? ""}`),
    [externalText, externalFile],
  );
  const externalBlockedVariables = isExternalList ? externalListBlockedVariables(smsContent) : [];
  const recipients = isExternalList ? externalList.phones.length : (audience?.eligibleTotal ?? 0);
  // ENV-06: a campanha de SMS só envia a quem corresponde a um jogador
  // cadastrado; os demais são reportados. A prévia usa o mesmo resolvedor do envio.
  // Lista externa: o inverso — só vai para quem ainda NÃO é jogador.
  const smsPhones = isExternalList ? externalList.phones : (audience?.eligibleIdentifiers ?? []);
  const smsRecipientPreview = useQuery({
    queryKey: [
      "sms-campaign-recipient-preview",
      audienceId,
      smsPhones.length,
      smsPhones[0] ?? "",
      smsPhones[smsPhones.length - 1] ?? "",
    ],
    queryFn: () =>
      previewSmsRecipients({
        data: {
          phones: smsPhones,
          recipientSource: isExternalList ? "external_list" : "players",
        },
      }),
    enabled: open && channel === "sms" && smsPhones.length > 0,
    staleTime: 60_000,
    retry: false,
  });
  const smsPreview = channel === "sms" ? smsRecipientPreview.data : undefined;
  const sendableRecipients = smsPreview ? smsPreview.resolved : recipients;
  const smsSegmentInfo = countSmsSegments(smsContent);
  const parts = smsSegmentInfo.segments;
  const cost = channel === "sms" ? sendableRecipients * parts : recipients;
  const smsCostBrl = smsPrice == null ? null : parts * smsPrice.unitPrice;
  const channelLimitError =
    channel === "voice" && recipients > 200
      ? "Voz aceita até 200 destinatários por campanha."
      : null;
  // The input is read in Brasília time, whatever the browser's timezone.
  const scheduleIso = fromBrtInput(scheduledAt);
  const scheduleTooSoon = !scheduleIso || Date.parse(scheduleIso) < Date.now() + 60_000;
  const validationIssues = [
    !name.trim() ? "Informe o nome da campanha." : null,
    isExternalList
      ? recipients === 0
        ? "Cole ou envie uma lista com números de celular válidos."
        : null
      : !audience || recipients === 0
        ? "Escolha um público com destinatários elegíveis."
        : null,
    isExternalList && recipients > EXTERNAL_LIST_MAX_PHONES
      ? `A lista aceita até ${num(EXTERNAL_LIST_MAX_PHONES)} números por campanha.`
      : null,
    externalBlockedVariables.length ? externalListVariablesError(externalBlockedVariables) : null,
    channel === "sms" && !smsContent.trim() ? "Escreva ou selecione a mensagem de SMS." : null,
    channel === "email" && !emailTemplateId ? "Selecione um template de e-mail." : null,
    channel === "voice" && !voiceSourceId
      ? voiceMode === "script"
        ? "Selecione um roteiro."
        : "Selecione um áudio da biblioteca."
      : null,
    when === "schedule" && !scheduledAt ? "Escolha a data e hora do agendamento." : null,
    when === "schedule" && scheduledAt && scheduleTooSoon
      ? "O agendamento deve ter pelo menos um minuto de antecedência."
      : null,
    ...(invalidVariables.length
      ? [`Variáveis não reconhecidas: ${invalidVariables.join(", ")}`]
      : []),
    channelLimitError,
    smsPreview && recipients > 0 && smsPreview.resolved === 0
      ? isExternalList
        ? "Nenhum número da lista pode receber: todos já são jogadores ou foram bloqueados."
        : "Nenhum destinatário deste público corresponde a um jogador cadastrado."
      : null,
  ].filter((issue): issue is string => Boolean(issue));

  // D-36: the "revisão de risco" checkbox is gone (the server never required it).
  // Above TYPED_CONFIRMATION_THRESHOLD the send still asks to type the count,
  // read at click time, so it always matches what is about to go out.

  const draftPayload = useMemo<CampaignDraftPayload>(
    () => ({
      channel,
      name,
      audienceId: audienceId || null,
      audienceCriteria: (audienceCriteria as unknown as Record<string, Json>) ?? null,
      assetId:
        channel === "sms"
          ? smsTemplateId || null
          : channel === "email"
            ? emailTemplateId || null
            : voiceSourceId || null,
      assetKind:
        channel === "sms" ? "sms_template" : channel === "email" ? "email_template" : voiceMode,
      assetSnapshot: (channel === "sms"
        ? { content: smsContent }
        : channel === "email"
          ? activeEmailTemplate
            ? {
                name: activeEmailTemplate.nome ?? activeEmailTemplate.name,
                subject: activeEmailTemplate.subject ?? activeEmailTemplate.assunto ?? "",
                bodyHtml: activeEmailTemplate.body_html ?? activeEmailTemplate.corpo ?? "",
              }
            : null
          : activeScript
            ? { name: activeScript.name, content: activeScript.content }
            : { name: assets.find((item) => item.id === voiceSourceId)?.name ?? "" }) as Record<
        string,
        Json
      > | null,
      content: channel === "sms" ? smsContent : previewContent,
      scheduledAt: when === "schedule" ? fromBrtInput(scheduledAt) : null,
      trackLinks,
      payload: {
        smsTemplateId,
        emailTemplateId,
        shortDomainId,
        senderId,
        voiceMode,
      },
    }),
    [
      channel,
      name,
      audienceId,
      audienceCriteria,
      smsTemplateId,
      smsContent,
      emailTemplateId,
      shortDomainId,
      senderId,
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
    onSuccess: (savedResult) => {
      const saved = savedResult as CampaignDraft;
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
    mutationFn: async (confirmedCount?: number) => {
      if (!name.trim()) throw new Error("Informe o nome da campanha.");
      // The audience changed after the typed confirmation: ask again for the new count.
      if (requiresTypedConfirmation(sendableRecipients) && confirmedCount !== sendableRecipients)
        throw new Error(
          "A quantidade de destinatários mudou depois da confirmação. Nada foi enviado; confirme de novo.",
        );
      if (isExternalList) {
        if (recipients === 0)
          throw new Error("Cole ou envie uma lista com números de celular válidos.");
        if (externalBlockedVariables.length)
          throw new Error(externalListVariablesError(externalBlockedVariables));
      } else if (!audience || recipients === 0)
        throw new Error("Escolha um público com destinatários elegíveis.");
      if (invalidVariables.length)
        throw new Error(`Variáveis inválidas: ${invalidVariables.join(", ")}`);
      if (channelLimitError) throw new Error(channelLimitError);
      if (when === "schedule" && !scheduledAt)
        throw new Error("Escolha a data e hora do agendamento.");
      if (when === "schedule" && scheduleTooSoon)
        throw new Error("O agendamento deve ter pelo menos um minuto de antecedência.");
      if (channel === "email" && emailBlocked) throw new Error(EMAIL_BLOCKED_WARNING);
      const scheduleAt = when === "schedule" ? (fromBrtInput(scheduledAt) ?? undefined) : undefined;

      if (channel === "sms") {
        if (!smsContent.trim()) throw new Error("Escreva ou selecione a mensagem de SMS.");
        const payload = {
          phones: isExternalList ? externalList.phones : audience!.eligibleIdentifiers,
          recipientSource: isExternalList ? ("external_list" as const) : ("players" as const),
          content: smsContent,
          campaignName: name,
          route: "iGaming" as const,
          ratePerMinute: 1000,
          trackLinks,
          templateId: smsTemplateId || undefined,
          conversionObjective: "conversion" as const,
          shortDomainId,
        };
        const result =
          when === "schedule"
            ? scheduleSms({
                data: {
                  ...payload,
                  scheduledAt: scheduleAt!,
                  // Público dinâmico: o worker recalcula quem se enquadra no horário do envio.
                  audienceCriteria: isExternalList ? undefined : (audienceCriteria ?? undefined),
                },
              })
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
            senderId,
            shortDomainId,
            agendadoPara: scheduleAt ?? null,
            status: when === "schedule" ? "agendada" : "enviando",
            targetPlayerIds: audience!.eligiblePlayerIds,
            extraEmails: [],
            trackLinks,
            conversionObjective: "conversion",
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
      if (!voiceSourceId) throw new Error("Selecione um roteiro ou áudio da biblioteca.");
      const completed = await dispatchVoice({
        data: {
          campaign_name: name,
          scheduled_at: scheduleAt,
          script_id: voiceMode === "script" ? voiceSourceId : undefined,
          asset_id: voiceMode === "asset" ? voiceSourceId : undefined,
          targets: audience!.eligibleIdentifiers.map((phone) => ({ phone_number: phone })),
        },
      });
      if (draftId) await submitDraft({ data: { id: draftId } });
      submitted.current = true;
      return completed;
    },
    onSuccess: (result) => {
      const unresolvedCount = Number(
        (result as { unresolvedCount?: number } | null | undefined)?.unresolvedCount ?? 0,
      );
      const emailRun =
        channel === "email" && when !== "schedule"
          ? (result as EmailCampaignRunResult | null | undefined)
          : null;
      if (emailRun?.pausadaPorSaldo) {
        // PG3: the e-mail run stopped at the first send the wallet refused.
        toast.warning(campaignPausedForBalanceMessage(emailRun));
        onCreated();
        onOpenChange(false);
        return;
      }
      toast.success(
        when === "schedule"
          ? "Campanha agendada"
          : `Campanha enviada para processamento${emailRun ? alreadySentSuffix(emailRun) : ""}`,
        unresolvedCount > 0
          ? {
              description: `${num(unresolvedCount)} destinatário(s) não receberão. Veja “Não enviados” no relatório da campanha.`,
            }
          : undefined,
      );
      onCreated();
      onOpenChange(false);
    },
    onError: (error: Error) => toast.error(tenantSafeChannelError(error)),
  });

  // O X, o clique fora e o botão Cancelar passam pela mesma verificação.
  const requestClose = async () => {
    if (draftState === "dirty" || draftState === "saving") {
      const leave = await requestConfirmation({
        title: "Fechar a campanha?",
        description:
          "Ainda há alterações sendo salvas. Se fechar agora, as últimas mudanças podem não entrar no rascunho.",
        confirmLabel: "Fechar mesmo assim",
        cancelLabel: "Continuar editando",
        destructive: true,
      });
      if (!leave) return;
    }
    onOpenChange(false);
  };

  const confirmAndSubmit = async () => {
    setSubmitAttempted(true);
    // The audience is still being (re)calculated: the count on screen is not final.
    if (audienceMutation.isPending || smsRecipientPreview.isFetching) return;
    let confirmedCount: number | undefined;
    if (validationIssues.length === 0 && requiresTypedConfirmation(sendableRecipients)) {
      const count = sendableRecipients;
      const typed = await requestTextInput({
        title: when === "schedule" ? "Confirmar agendamento em massa" : "Confirmar envio em massa",
        description: `${campaignSendLabel({ channel, when, recipients: count, cost, smsUnitPrice: smsPrice?.unitPrice, smsExempt })}. Para confirmar, digite a quantidade de destinatários. Depois de iniciado, o envio não pode ser desfeito.`,
        label: `Digite ${num(count)} para confirmar`,
        placeholder: num(count),
        confirmLabel: when === "schedule" ? "Agendar" : "Enviar",
      });
      if (typed === null) return;
      if (!typedCountMatches(typed, count)) {
        toast.error("O número digitado não confere. Nada foi enviado.");
        return;
      }
      confirmedCount = count;
    }
    submit.mutate(confirmedCount);
  };

  const MetaIcon = channelMeta[channel].icon;
  const audienceName = audienceOptions.find((item) => item.id === audienceId)?.name ?? null;
  // D-36: one block for everything the operator should know before sending —
  // what is still missing (blocks the send) and who will be left out (does not).
  const audienceWarnings = [
    isExternalList && externalList.invalidCount > 0
      ? `${num(externalList.invalidCount)} número(s) inválido(s) ignorado(s)${
          externalList.invalid.length
            ? ` (ex.: ${externalList.invalid.slice(0, 3).join(", ")})`
            : ""
        }.`
      : null,
    isExternalList && externalList.duplicates > 0
      ? `${num(externalList.duplicates)} número(s) repetido(s) na lista recebem uma única vez.`
      : null,
    !isExternalList && audience && audience.excludedTotal > 0
      ? `${num(audience.excludedTotal)} ${audience.excludedTotal === 1 ? "jogador fica" : "jogadores ficam"} de fora por cadastro inválido, sem contato ou sem consentimento.`
      : null,
  ].filter((item): item is string => Boolean(item));
  // Same conditions under which UnresolvedRecipientsNotice renders something.
  const showSmsRecipientCheck =
    channel === "sms" &&
    smsPhones.length > 0 &&
    ((smsRecipientPreview.isFetching && !smsPreview) ||
      smsRecipientPreview.isError ||
      (smsPreview?.unresolvedCount ?? 0) > 0);
  const hasNotices =
    validationIssues.length > 0 || audienceWarnings.length > 0 || showSmsRecipientCheck;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) void requestClose();
        else onOpenChange(next);
      }}
    >
      <DialogContent className="flex h-dvh max-h-dvh w-full max-w-none flex-col gap-0 overflow-hidden p-0 sm:h-auto sm:max-h-[92dvh] sm:w-[calc(100vw-2rem)] sm:max-w-4xl sm:rounded-2xl">
        <DialogHeader className="shrink-0 space-y-1 border-b border-border px-4 py-4 pr-12 text-left sm:px-6">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <DialogTitle className="text-section">Nova campanha</DialogTitle>
            <span
              className={cn(
                "text-meta",
                draftState === "error" ? "text-danger" : "text-muted-foreground",
              )}
              aria-live="polite"
            >
              {draftState === "saving" || draftState === "dirty"
                ? "Salvando rascunho…"
                : draftState === "error"
                  ? "Não foi possível salvar o rascunho"
                  : draftState === "saved"
                    ? "Rascunho salvo"
                    : "Preparando rascunho"}
            </span>
          </div>
          <DialogDescription className="text-body">
            Escolha o canal, o público e a mensagem. O rascunho é salvo enquanto você edita.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6 sm:py-5">
          <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_280px]">
            <div className="min-w-0 space-y-5">
              <div className="space-y-2">
                <Label>Canal</Label>
                <SegmentedFilter
                  label="Canal da campanha"
                  value={channel}
                  onValueChange={(item) => {
                    setChannel(item);
                    // The external phone list is an SMS-only audience.
                    if (audienceId === EXTERNAL_LIST_ID && item !== "sms") setAudienceId("");
                    const selected = audienceOptions.find((option) => option.id === audienceId);
                    if (selected) {
                      setAudienceCriteria(selected.criteria);
                      audienceMutation.mutate({ criteria: selected.criteria, channel: item });
                    }
                  }}
                  items={(Object.keys(channelMeta) as Channel[]).map((item) => ({
                    value: item,
                    label: channelMeta[item].label,
                  }))}
                />
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
                    if (value === EXTERNAL_LIST_ID) setAudienceCriteria(null);
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
                    {channel === "sms" ? (
                      <SelectItem value={EXTERNAL_LIST_ID}>
                        Lista de números · quem ainda não é jogador
                      </SelectItem>
                    ) : null}
                    {audienceOptions.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.system
                          ? item.id === "system:all-leads"
                            ? `Público automático · ${item.name}`
                            : `Nível · ${item.name}`
                          : item.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {audienceMutation.isPending ? (
                  <p className="text-meta text-muted-foreground" aria-live="polite">
                    Calculando o público…
                  </p>
                ) : null}
                {isExternalList ? (
                  <div className="space-y-2">
                    <Textarea
                      name="external-phone-list"
                      rows={4}
                      value={externalText}
                      onChange={(event) => setExternalText(event.target.value)}
                      placeholder="Cole os números: um por linha ou separados por vírgula ou ponto e vírgula"
                      aria-label="Números da lista"
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        ref={externalFileRef}
                        type="file"
                        accept={PHONE_LIST_FILE_ACCEPT}
                        className="hidden"
                        onChange={async (event) => {
                          const file = event.target.files?.[0];
                          event.target.value = "";
                          if (!file) return;
                          setExternalFileLoading(true);
                          try {
                            setExternalFile({
                              name: file.name,
                              text: await readPhoneListFile(file),
                            });
                          } catch (error) {
                            toast.error(
                              error instanceof Error
                                ? error.message
                                : "Não foi possível ler o arquivo.",
                            );
                          } finally {
                            setExternalFileLoading(false);
                          }
                        }}
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={externalFileLoading}
                        onClick={() => externalFileRef.current?.click()}
                      >
                        <Upload className="mr-1.5 size-3.5" aria-hidden="true" />
                        {externalFileLoading ? "Lendo arquivo…" : "Enviar arquivo (CSV, TXT, XLS)"}
                      </Button>
                      {externalFile ? (
                        <Badge variant="secondary" className="gap-1">
                          {externalFile.name}
                          <button
                            type="button"
                            aria-label="Remover arquivo"
                            onClick={() => setExternalFile(null)}
                          >
                            <X className="size-3" aria-hidden="true" />
                          </button>
                        </Badge>
                      ) : null}
                    </div>
                    <p className="text-meta text-muted-foreground">
                      {num(externalList.phones.length)} número(s) válido(s). Os números não são
                      salvos como jogadores e quem já é jogador da casa fica de fora. Se a pessoa
                      clicar no link e se cadastrar com o mesmo telefone, o cadastro e os depósitos
                      entram no relatório da campanha.
                    </p>
                  </div>
                ) : null}
                {channel === "sms" && when === "schedule" && audienceCriteria ? (
                  <p className="text-meta text-muted-foreground">
                    No horário agendado o público é recalculado: entra quem passou a se enquadrar e
                    sai quem deixou de se enquadrar.
                  </p>
                ) : null}
              </div>
              {channel !== "voice" ? (
                <p className="text-meta text-muted-foreground">
                  <span className="font-medium text-foreground">Rastreamento automático.</span>{" "}
                  Envios, cliques, cadastros, login ou jogo, primeiro depósito e depósitos aprovados
                  aparecem no relatório da campanha.
                </p>
              ) : null}
              {channel === "sms" && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label id={fieldIds.smsTemplateLabel}>Template de SMS</Label>
                    <div className="flex flex-col gap-2 sm:flex-row">
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
                          className="sm:flex-1"
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
                        variant="outline"
                        onClick={() => setSmsTemplateDialogOpen(true)}
                      >
                        <Plus /> Novo template
                      </Button>
                    </div>
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
                    <LinkInsertMenu
                      siteUrl={siteUrl}
                      quickLinks={quickLinks}
                      textareaRef={smsContentRef}
                      value={smsContent}
                      onChange={setSmsContent}
                    />
                    <p className="text-meta text-muted-foreground">
                      {Array.from(smsContent).length} caracteres · {smsSegmentInfo.encoding} ·{" "}
                      {parts} segmento{parts === 1 ? "" : "s"} ·{" "}
                      {smsExempt
                        ? "casa isenta"
                        : smsCostBrl == null
                          ? "—"
                          : `${brl(smsCostBrl)} por jogador`}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label>Domínio do encurtador</Label>
                    <ShortenerFallbackNotice
                      isSuccess={composerOptions.isSuccess}
                      isError={composerOptions.isError}
                      shortenerPending={shortenerPending}
                      hasVerifiedDomain={shortDomains.length > 0}
                    />
                    <ShortDomainSelect
                      domains={shortDomains}
                      value={shortDomainId}
                      onChange={setShortDomainId}
                    />
                  </div>
                </div>
              )}
              {channel === "email" && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label id={fieldIds.emailTemplateLabel}>Template de e-mail</Label>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Select value={emailTemplateId} onValueChange={setEmailTemplateId}>
                        <SelectTrigger
                          id={fieldIds.emailTemplate}
                          aria-labelledby={fieldIds.emailTemplateLabel}
                          aria-invalid={submitAttempted && !emailTemplateId}
                          aria-describedby={fieldIds.validation}
                          className="sm:flex-1"
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
                        variant="outline"
                        onClick={() => setEmailTemplateDialogOpen(true)}
                      >
                        <Plus /> Novo template
                      </Button>
                    </div>
                  </div>
                  <MessageVariablePicker
                    channel="email"
                    readOnly
                    label="Variáveis aceitas nos templates de e-mail"
                  />
                  <div className="space-y-2">
                    <Label>Remetente</Label>
                    <EmailBlockedNotice
                      isSuccess={composerOptions.isSuccess}
                      isError={composerOptions.isError}
                      hasVerifiedSender={emailSenders.length > 0}
                    />
                    <EmailSenderSelect
                      senders={emailSenders}
                      value={senderId}
                      onChange={setSenderId}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Domínio do encurtador</Label>
                    <ShortenerFallbackNotice
                      isSuccess={composerOptions.isSuccess}
                      isError={composerOptions.isError}
                      shortenerPending={shortenerPending}
                      hasVerifiedDomain={shortDomains.length > 0}
                    />
                    <ShortDomainSelect
                      domains={shortDomains}
                      value={shortDomainId}
                      onChange={setShortDomainId}
                    />
                  </div>
                </div>
              )}
              {channel === "voice" && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>Conteúdo da ligação</Label>
                    <SegmentedFilter
                      label="Conteúdo da ligação"
                      value={voiceMode}
                      onValueChange={(mode) => {
                        setVoiceMode(mode);
                        setVoiceSourceId("");
                      }}
                      items={[
                        { value: "asset", label: "Áudio gravado" },
                        { value: "script", label: "Roteiro (voz gerada)" },
                      ]}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label id={fieldIds.voiceSourceLabel}>
                      {voiceMode === "asset" ? "Áudio da biblioteca" : "Roteiro"}
                    </Label>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Select value={voiceSourceId} onValueChange={setVoiceSourceId}>
                        <SelectTrigger
                          id={fieldIds.voiceSource}
                          aria-labelledby={fieldIds.voiceSourceLabel}
                          aria-invalid={submitAttempted && !voiceSourceId}
                          aria-describedby={fieldIds.validation}
                          className="sm:flex-1"
                        >
                          <SelectValue placeholder="Selecione uma opção" />
                        </SelectTrigger>
                        <SelectContent>
                          {(voiceMode === "asset" ? assets : scripts).map((item) => (
                            <SelectItem key={item.id} value={item.id}>
                              {item.name}
                              {voiceMode === "script" && "version" in item
                                ? ` · v${item.version ?? 1}`
                                : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          if (voiceMode === "asset") setVoiceUploadDialogOpen(true);
                          else setVoiceScriptDialogOpen(true);
                        }}
                      >
                        <Plus />
                        {voiceMode === "asset" ? "Enviar áudio" : "Novo roteiro"}
                      </Button>
                    </div>
                  </div>
                  <p className="text-meta text-muted-foreground">
                    Até 200 jogadores por campanha de voz.
                    {voiceMode === "script" && activeScript
                      ? ` Roteiro v${activeScript.version ?? 1} · ${previewContent.length} caracteres. A voz é gerada a partir do texto e um roteiro repetido reaproveita o áudio já gerado.`
                      : ""}
                  </p>
                  {voiceMode === "script" && (
                    <MessageVariablePicker
                      channel="voice"
                      readOnly
                      label="Variáveis aceitas nos roteiros de voz"
                    />
                  )}
                </div>
              )}
              <div className="space-y-2">
                <Label>Quando enviar</Label>
                <SegmentedFilter
                  label="Quando enviar"
                  value={when}
                  onValueChange={setWhen}
                  items={[
                    { value: "now", label: "Agora" },
                    { value: "schedule", label: "Agendar" },
                  ]}
                />
                {when === "schedule" && (
                  <>
                    <Input
                      id={fieldIds.schedule}
                      name="campaign-schedule"
                      type="datetime-local"
                      value={scheduledAt}
                      onChange={(event) => setScheduledAt(event.target.value)}
                      aria-invalid={
                        submitAttempted && when === "schedule" && (!scheduledAt || scheduleTooSoon)
                      }
                      aria-describedby={fieldIds.validation}
                      aria-label="Data e hora do agendamento, horário de Brasília"
                      className="sm:max-w-xs"
                    />
                    <p className="text-meta text-muted-foreground">
                      Horário de Brasília, independente do fuso do seu computador.
                      {channel === "voice"
                        ? " As ligações ficam preparadas na fila e saem quando o envio automático de voz estiver ativo."
                        : ""}
                    </p>
                  </>
                )}
              </div>
              {hasNotices && (
                <div
                  id={fieldIds.validation}
                  className="rounded-xl border border-border bg-secondary/40 p-3 text-body"
                  role="status"
                  aria-live="polite"
                >
                  {validationIssues.length > 0 && (
                    <>
                      <p className="flex items-center gap-2 font-medium">
                        <AlertTriangle
                          className="size-4 shrink-0 text-warning"
                          aria-hidden="true"
                        />
                        {submitAttempted ? "Para continuar, corrija:" : "Falta para enviar:"}
                      </p>
                      <ul className="mt-1 list-disc space-y-0.5 pl-6 text-muted-foreground">
                        {validationIssues.map((issue) => (
                          <li key={issue}>{issue}</li>
                        ))}
                      </ul>
                    </>
                  )}
                  {(audienceWarnings.length > 0 || showSmsRecipientCheck) && (
                    <div
                      className={cn(
                        "space-y-1 text-meta text-muted-foreground",
                        validationIssues.length > 0 && "mt-3 border-t border-border pt-3",
                      )}
                    >
                      {audienceWarnings.map((warning) => (
                        <p key={warning}>{warning}</p>
                      ))}
                      {showSmsRecipientCheck ? (
                        <UnresolvedRecipientsNotice
                          loading={smsRecipientPreview.isFetching && !smsPreview}
                          failed={smsRecipientPreview.isError}
                          preview={smsPreview}
                        />
                      ) : null}
                    </div>
                  )}
                </div>
              )}
            </div>

            <aside
              className="h-fit space-y-3 rounded-xl border border-border bg-card p-4 text-body"
              aria-label="Resumo da campanha"
            >
              <h3 className="flex items-center gap-2 text-section">
                <MetaIcon
                  className={cn("size-4", CHANNEL_IDENTITY[channel].text)}
                  aria-hidden="true"
                />
                Resumo · {channelMeta[channel].label}
              </h3>
              <div>
                <p className="text-meta text-muted-foreground">Destinatários</p>
                <p className="text-kpi-sm tabular-nums" aria-live="polite">
                  {audienceMutation.isPending ? "…" : num(sendableRecipients)}
                </p>
                {isExternalList ? (
                  <p className="text-meta text-muted-foreground">
                    Lista de números · {num(externalList.phones.length)} válido(s)
                  </p>
                ) : null}
                {audience && audienceName && !isExternalList ? (
                  <p className="text-meta text-muted-foreground">
                    {audienceName} · {num(audience.total)}{" "}
                    {audience.total === 1 ? "jogador" : "jogadores"} no público
                  </p>
                ) : null}
              </div>
              {channel === "sms" ? (
                <div>
                  <p className="text-meta text-muted-foreground">Custo estimado</p>
                  <p className="font-medium tabular-nums">
                    {smsExempt
                      ? "Casa isenta"
                      : `${num(cost)} segmento${cost === 1 ? "" : "s"} · ${
                          smsPrice == null ? "—" : brl(cost * smsPrice.unitPrice)
                        }`}
                  </p>
                </div>
              ) : null}
              <div>
                <p className="text-meta text-muted-foreground">Conteúdo</p>
                <p className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap rounded-lg bg-secondary/50 p-2.5 text-meta text-muted-foreground">
                  {channel === "voice" && voiceMode === "asset"
                    ? (assets.find((item) => item.id === voiceSourceId)?.name ??
                      "Selecione um áudio")
                    : previewContent || "Selecione o conteúdo para visualizar"}
                </p>
              </div>
              <p className="flex items-center gap-2 text-meta text-muted-foreground">
                <CheckCircle2 className="size-3.5 shrink-0 text-success" aria-hidden="true" />
                Consentimentos são verificados antes do envio.
              </p>
            </aside>
          </div>
        </div>

        <DialogFooter className="shrink-0 flex-col-reverse gap-2 border-t border-border px-4 py-3 sm:flex-row sm:px-6">
          <Button className="w-full sm:w-auto" variant="ghost" onClick={() => void requestClose()}>
            Cancelar
          </Button>
          <Button
            className="h-auto min-h-9 w-full whitespace-normal py-2 sm:w-auto"
            disabled={
              submit.isPending ||
              audienceMutation.isPending ||
              smsRecipientPreview.isFetching ||
              !draftId ||
              draftState === "dirty" ||
              draftState === "saving" ||
              draftState === "error" ||
              (channel === "email" && emailBlocked)
            }
            onClick={() => void confirmAndSubmit()}
            aria-describedby={validationIssues.length ? fieldIds.validation : undefined}
          >
            {submit.isPending
              ? "Processando..."
              : campaignSendLabel({
                  channel,
                  when,
                  recipients: sendableRecipients,
                  cost,
                  smsUnitPrice: smsPrice?.unitPrice,
                  smsExempt,
                })}
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

type SmsRecipientPreview = {
  total: number;
  resolved: number;
  unresolvedCount: number;
  unresolvedByReason: Record<UnresolvedReason, number>;
  duplicates: number;
};

const UNRESOLVED_NOTICE_TEXT: Record<UnresolvedReason, string> = {
  sem_cadastro: "sem cadastro não receberão",
  telefone_invalido: "com telefone inválido não receberão",
  sem_consentimento: "sem consentimento para SMS não receberão",
  grupo_controle: "no grupo de controle de uma jornada não receberão",
  ja_jogador: "já são jogadores da casa e não receberão",
};

/** ENV-06 — avisa, antes do envio/agendamento, quem ficará fora da campanha. */
function UnresolvedRecipientsNotice({
  loading,
  failed,
  preview,
}: {
  loading: boolean;
  failed: boolean;
  preview: SmsRecipientPreview | undefined;
}) {
  if (loading) return <p>Verificando o cadastro dos destinatários…</p>;
  if (failed)
    return (
      <p>Não foi possível verificar os cadastros agora; a verificação será refeita no envio.</p>
    );
  if (!preview || preview.unresolvedCount === 0) return null;
  const reasons = UNRESOLVED_REASONS.filter((reason) => preview.unresolvedByReason[reason] > 0);
  return (
    <div>
      <ul className="space-y-0.5 font-medium text-foreground">
        {reasons.map((reason) => (
          <li key={reason}>
            {num(preview.unresolvedByReason[reason])} destinatário(s){" "}
            {UNRESOLVED_NOTICE_TEXT[reason]}
          </li>
        ))}
      </ul>
      <p className="mt-1">
        {/* The sendable count is shown once, in the summary (D-36). */}
        {preview.resolved > 0
          ? "Os demais recebem normalmente."
          : "Nenhum destinatário desta lista pode receber."}{" "}
        A lista fica no relatório da campanha, em “Não enviados”.
        {preview.duplicates > 0
          ? ` ${num(preview.duplicates)} repetido(s) recebem uma única vez.`
          : ""}
      </p>
    </div>
  );
}
