import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CHANNEL_IDENTITY } from "@/components/identity/identity";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle,
  Bell,
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

import { tourAnchor } from "@/help/anchor";
import { Term } from "@/components/help/term";
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
import { type CampaignDraft, type CampaignDraftPayload } from "@/lib/campaign-drafts.functions";
import { useCampaignDataSource } from "@/hooks/use-campaign-data-source";
import { useEnabledChannels } from "@/hooks/use-enabled-channels";
import {
  bulkDispatchExpertCalls,
  getExpertCampaignUsage,
  getExpertComposerOptions,
  resolveExpertCampaignAudience,
  saveExpertEmailCampaign,
  scheduleExpertBulkSms,
  sendExpertBulkSms,
} from "@/lib/expert-campaigns.functions";
import { listExpertTemplates } from "@/lib/expert-templates.functions";
import {
  EXPERT_USAGE_QUERY_KEY,
  expertCapBlockReason,
  expertEstimatedCost,
  remainingAfterSend,
  type ExpertCampaignUsageData,
} from "@/lib/expert-campaign-usage";
import {
  listEmailTemplates,
  saveEmailCampaign,
  saveEmailTemplate,
  sendEmailCampaignNow,
} from "@/lib/email.functions";
import { brl, num } from "@/lib/format";
import { getBillingPrices } from "@/lib/billing/billing.functions";
import { countSmsSegments, toGsm7Text } from "@/lib/sms-segments";
import { unknownMessageVariables } from "@/lib/message-variables";
import { listJourneyVoiceAssets } from "@/lib/journey-voice-assets.functions";
import {
  resolveCampaignAudience,
  type ResolvedCampaignAudience,
} from "@/lib/sms-audiences.functions";
import { SYSTEM_SMS_AUDIENCES, type SmsAudienceCriteria } from "@/lib/sms-audience-criteria";
import { listSmsTemplates } from "@/lib/sms-templates.functions";
import { previewSmsCampaignRecipients, scheduleBulkSms, sendBulkSms } from "@/lib/sms.functions";
import { SmsSendAccountSelect, useSmsSendAccounts } from "@/components/sms/sms-send-account-select";
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
  campaignContinuesInBatchesMessage,
  campaignInterruptedMessage,
  campaignPausedForBalanceMessage,
  type EmailCampaignRunResult,
} from "@/lib/email-campaign-messages";
import {
  externalListBlockedVariables,
  externalListVariablesError,
  parsePhoneList,
} from "@/lib/campaign-external-list";
import { PHONE_LIST_FILE_ACCEPT, readPhoneListFile } from "@/lib/phone-list-file";
import { requestConfirmation, requestTextInput } from "@/components/system-dialog-host";
import {
  campaignSendLabel,
  expertCampaignSendLabel,
  requiresTypedConfirmation,
  typedCountMatches,
} from "./campaign-send-confirmation";
import {
  WebpushCampaignFields,
  buildWebpushScheduleInput,
  type WebpushAudienceKind,
} from "./webpush-campaign-fields";
import { getWebpushIntegrationFn } from "@/lib/webpush/webpush.functions";
import {
  countWebpushAudienceFn,
  scheduleWebpushCampaignFn,
} from "@/lib/webpush/campaigns.functions";
import { validateCampaignContent } from "@/lib/webpush/shared";

type Channel = "sms" | "email" | "voice" | "webpush";
/** Channels that still go through `resolveCampaignAudience`/`resolveExpertCampaignAudience`
 *  (an identifier-based audience resolved to eligible players). Web push counts
 *  subscriptions instead (`countWebpushAudienceFn`), never this resolver. */
type AudienceResolvedChannel = "sms" | "email" | "voice";
type AudienceOption = {
  id: string;
  name: string;
  criteria: SmsAudienceCriteria;
  system?: boolean;
  /** Expert list only: "casa" = house audience, read-only (total-access expert). */
  owner?: "meu" | "casa";
};
type ResolvedAudience = ResolvedCampaignAudience;

/** Audience option of SMS campaigns to numbers that are not players. */
const EXTERNAL_LIST_ID = "external:list";

const channelMeta: Record<Channel, { label: string; icon: typeof MessageSquare }> = {
  sms: { label: "SMS", icon: MessageSquare },
  email: { label: "E-mail", icon: Mail },
  voice: { label: "Voz", icon: Phone },
  webpush: { label: "Web Push", icon: Bell },
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
  cost: "campaign-cost",
  approval: "campaign-approval-notice",
};

/** Notice of the expert's approval mode, next to the submit button. */
export const EXPERT_APPROVAL_NOTICE =
  "O admin precisa aprovar antes do disparo; o agendamento vale a partir da aprovação.";

/** Label of a saved/system audience in the select; the expert sees whose leads it covers. */
function audienceOptionLabel(item: AudienceOption, isExpert: boolean): string {
  if (item.system) {
    const base =
      item.id === "system:all-leads" ? `Público automático · ${item.name}` : `Nível · ${item.name}`;
    return isExpert ? `${base} (dos seus leads)` : base;
  }
  return isExpert && item.owner === "casa" ? `Da casa · ${item.name}` : item.name;
}

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
  // Ids tying the "Domínio do encurtador"/"Remetente" labels (which carry a
  // <Term>) to their selects.
  const fieldId = useId();
  const smsDomainId = `${fieldId}-sms-dominio`;
  const smsAccountFieldId = `${fieldId}-sms-conta`;
  const emailSenderFieldId = `${fieldId}-email-remetente`;
  const emailDomainId = `${fieldId}-email-dominio`;
  // House or expert data source, by the shell role (campaign-data-source.ts).
  // The expert sends the audience criteria and the server resolves it; the
  // house-only controls are hidden for the expert below.
  const source = useCampaignDataSource();
  const isExpert = source.isExpert;
  const { isEnabled } = useEnabledChannels();
  const resolveAudience = useServerFn(resolveCampaignAudience);
  const getDraft = source.getDraft;
  const saveDraft = source.saveDraft;
  const submitDraft = source.submitDraft;
  const listAudiences = source.listAudiences;
  const resolveExpertAudience = useServerFn(resolveExpertCampaignAudience);
  const sendExpertSms = useServerFn(sendExpertBulkSms);
  const scheduleExpertSms = useServerFn(scheduleExpertBulkSms);
  const saveExpertEmail = useServerFn(saveExpertEmailCampaign);
  const dispatchExpertVoice = useServerFn(bulkDispatchExpertCalls);
  const getExpertOptions = useServerFn(getExpertComposerOptions);
  const getExpertUsage = useServerFn(getExpertCampaignUsage);
  const listExpertTemplateFn = useServerFn(listExpertTemplates);
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
  const getWebpushIntegration = useServerFn(getWebpushIntegrationFn);
  const countWebpushAudience = useServerFn(countWebpushAudienceFn);
  const scheduleWebpushCampaign = useServerFn(scheduleWebpushCampaignFn);

  // Web push only shows up as a channel once the house's integration is enabled.
  const webpushIntegration = useQuery({
    queryKey: ["webpush-integration", "composer"],
    queryFn: () => getWebpushIntegration(),
    enabled: open && !isExpert,
  });
  const webpushAvailable =
    !isExpert && isEnabled("webpush") && webpushIntegration.data?.enabled === true;
  // Channels offered in the tab bar: web push needs the integration active
  // on top of the channel switch; the others follow the house's channel
  // switches directly.
  const visibleChannels = (Object.keys(channelMeta) as Channel[]).filter((item) =>
    item === "webpush" ? webpushAvailable : isEnabled(item),
  );

  const composerOptions = useQuery({
    queryKey: COMPOSER_OPTIONS_QUERY_KEY,
    queryFn: () => getComposerOpts(),
    enabled: open && !isExpert,
  });
  const expertOptions = useQuery({
    queryKey: ["expert-composer-options"],
    queryFn: () => getExpertOptions(),
    enabled: open && isExpert,
  });
  const expertUsage = useQuery({
    queryKey: EXPERT_USAGE_QUERY_KEY,
    queryFn: () => getExpertUsage(),
    enabled: open && isExpert,
  });
  const siteUrl = isExpert
    ? (expertOptions.data?.siteUrl ?? null)
    : (composerOptions.data?.siteUrl ?? null);
  const quickLinks = isExpert
    ? (expertOptions.data?.quickLinks ?? [])
    : (composerOptions.data?.quickLinks ?? []);
  const shortDomains = composerOptions.data?.shortDomains ?? [];
  const shortenerPending = composerOptions.data?.shortenerPending ?? false;
  const emailSenders = composerOptions.data?.senders ?? [];
  // Only a confirmed-empty sender list blocks sending — while the query is
  // still loading or failed, we don't know yet, so we don't block on it.
  // The expert always sends with the house's default sender (resolved on the server).
  const emailBlocked = !isExpert && composerOptions.isSuccess && emailSenders.length === 0;
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
  // House SMS only: account the campaign goes out through; null = "Padrão da casa".
  const [smsAccountId, setSmsAccountId] = useState<string | null>(null);
  const [senderId, setSenderId] = useState<string | null>(null);
  const [voiceMode, setVoiceMode] = useState<"script" | "asset">("asset");
  const [voiceSourceId, setVoiceSourceId] = useState("");
  const [webpushTitle, setWebpushTitle] = useState("");
  const [webpushBody, setWebpushBody] = useState("");
  const [webpushUrl, setWebpushUrl] = useState("");
  const [webpushImageUrl, setWebpushImageUrl] = useState("");
  const [webpushAudienceKind, setWebpushAudienceKind] = useState<WebpushAudienceKind>("todos");
  const [when, setWhen] = useState<"now" | "schedule">("now");
  const [scheduledAt, setScheduledAt] = useState("");
  const trackLinks = true;
  const [submitAttempted, setSubmitAttempted] = useState(false);
  /** Expert: the server's last refusal (link policy, cap…), shown inline. */
  const [serverError, setServerError] = useState<string | null>(null);
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
    queryKey: source.queryKeys.draft(initialDraftId),
    queryFn: () => getDraft({ data: { id: initialDraftId! } }),
    enabled: open && Boolean(initialDraftId),
  });

  const savedAudiences = useQuery({
    queryKey: source.queryKeys.audiences,
    queryFn: () => listAudiences(),
    enabled: open,
  });
  const pricesQuery = useQuery({
    queryKey: ["billing-prices"],
    queryFn: () => getPrices(),
    enabled: open && !isExpert,
    staleTime: 5 * 60_000,
  });
  const smsPrice = pricesQuery.data?.sms ?? null;
  const smsExempt = smsPrice?.exempt ?? false;
  // House SMS campaigns may pick one of the accounts the super admin linked to
  // the house; the expert always sends through the house default.
  const smsAccount = useSmsSendAccounts(smsAccountId, open && channel === "sms" && !isExpert);
  const smsAccountName = smsAccount.selectedName;
  const smsAccountError = channel === "sms" ? smsAccount.error : null;
  const smsTemplatesQuery = useQuery({
    queryKey: ["sms-templates"],
    queryFn: () => listSmsTemplateFn(),
    enabled: open && channel === "sms" && !isExpert,
  });
  // Expert: own message templates + the house's active SMS templates (Modelos).
  const expertSmsTemplatesQuery = useQuery({
    queryKey: ["expert-templates"],
    queryFn: () => listExpertTemplateFn(),
    enabled: open && channel === "sms" && isExpert,
  });
  const emailTemplatesQuery = useQuery({
    queryKey: ["email-templates"],
    queryFn: () => listEmailTemplateFn(),
    enabled: open && channel === "email" && !isExpert,
  });
  const scriptsQuery = useQuery({
    queryKey: ["call-scripts"],
    queryFn: () => listScripts(),
    enabled: open && channel === "voice" && !isExpert,
  });
  const assetsQuery = useQuery({
    queryKey: ["journey-voice-assets"],
    queryFn: () => listAssets(),
    enabled: open && channel === "voice" && !isExpert,
  });

  const audienceOptions = useMemo<AudienceOption[]>(
    () => [
      ...SYSTEM_SMS_AUDIENCES.map((item) => ({ ...item, system: true })),
      ...(
        (savedAudiences.data ?? []) as Array<{
          id: string;
          name: string;
          criteria: SmsAudienceCriteria;
          owner?: "meu" | "casa";
        }>
      ).map((item) => ({ ...item, system: false })),
    ],
    [savedAudiences.data],
  );

  const expertTemplates = expertSmsTemplatesQuery.data as
    | {
        meus: Array<{ id: string; nome: string; conteudo: string }>;
        casa: Array<{ id: string; nome: string; conteudo: string }>;
      }
    | undefined;
  const smsTemplates = (
    (isExpert
      ? [
          ...(expertTemplates?.meus ?? []).map((item) => ({
            id: item.id,
            name: item.nome,
            content: item.conteudo,
          })),
          ...(expertTemplates?.casa ?? []).map((item) => ({
            id: item.id,
            name: `Da casa · ${item.nome}`,
            content: item.conteudo,
          })),
        ]
      : (smsTemplatesQuery.data?.items ?? [])) as Array<{
      id: string;
      name: string;
      content: string;
      isActive?: boolean;
    }>
  ).filter((item) => item.isActive !== false);
  const emailTemplates = (
    (isExpert
      ? // Published house templates; the server copies the content at save time.
        (expertOptions.data?.emailTemplates ?? []).map((item) => ({
          id: item.id,
          nome: item.nome,
          subject: item.assunto,
        }))
      : (emailTemplatesQuery.data?.items ?? [])) as Array<{
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
    (isExpert
      ? (expertOptions.data?.callScripts ?? []).map((item) => ({ ...item, status: "active" }))
      : (scriptsQuery.data?.scripts ?? [])) as Array<{
      id: string;
      name: string;
      content: string;
      status: string;
      version?: number;
    }>
  ).filter((item) => item.status === "active");
  const assets = (
    (isExpert
      ? (expertOptions.data?.voiceAssets ?? []).map((item) => ({
          id: item.id,
          name: item.name,
          duration_seconds: item.durationSeconds,
        }))
      : (assetsQuery.data?.assets ?? [])) as Array<{
      id: string;
      name: string;
      is_archived?: boolean;
      duration_seconds?: number | null;
    }>
  ).filter((item) => !item.is_archived);
  // Expert voice cost depends on the audio length (read by the audience estimate).
  const expertVoiceSecondsRef = useRef<number | null>(null);
  expertVoiceSecondsRef.current =
    voiceMode === "asset"
      ? (assets.find((item) => item.id === voiceSourceId)?.duration_seconds ?? null)
      : null;

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
    setSmsAccountId(null);
    setSenderId(null);
    setVoiceMode("asset");
    setVoiceSourceId("");
    setWebpushTitle("");
    setWebpushBody("");
    setWebpushUrl("");
    setWebpushImageUrl("");
    setWebpushAudienceKind("todos");
    setWhen("now");
    setScheduledAt("");
    setSubmitAttempted(false);
    setServerError(null);
    setDraftId(null);
    setDraftVersion(null);
    setDraftState("idle");
    submitted.current = false;
    hydratedDraftId.current = null;
    idempotencyKey.current = crypto.randomUUID();
  }, [open, initialChannel, initialDraftId, initialAudienceId]);

  // The hub's `?newChannel=webpush` link (or a stale `initialChannel` prop)
  // can seed `channel` with "webpush" before the integration's enabled state
  // is known, or for a house/expert where it's disabled or never comes
  // available (expert: `webpushAvailable` is house-only, so it's always
  // false for them) — or with any channel the super admin has since turned
  // off for the house. Clamp back to a channel still offered as soon as
  // that's certain — the tab itself is already filtered out of the
  // SegmentedFilter, but the channel state must not silently stay on a tab
  // nobody can select.
  useEffect(() => {
    if (!open) return;
    if (channel === "webpush") {
      if (isExpert || (webpushIntegration.isSuccess && !webpushAvailable)) {
        // Fall back to a channel still offered; if none is, leave the state
        // as-is — there is nothing selectable and the content below warns
        // about it instead of silently picking a disabled channel.
        if (visibleChannels.length > 0) setChannel(visibleChannels[0]);
      }
      return;
    }
    if (!visibleChannels.includes(channel) && visibleChannels.length > 0) {
      setChannel(visibleChannels[0]);
    }
  }, [open, channel, isExpert, webpushIntegration.isSuccess, webpushAvailable, visibleChannels]);

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

  const webpushAudienceInput = useMemo(
    () =>
      webpushAudienceKind === "todos"
        ? ({ kind: "todos" } as const)
        : ({ kind: "filtro", criteria: audienceCriteria ?? {} } as const),
    [webpushAudienceKind, audienceCriteria],
  );
  const webpushCountQuery = useQuery({
    queryKey: ["webpush-audience-count", webpushAudienceKind, JSON.stringify(audienceCriteria)],
    queryFn: () => countWebpushAudience({ data: { audience: webpushAudienceInput } }),
    enabled:
      open &&
      channel === "webpush" &&
      (webpushAudienceKind === "todos" || Boolean(audienceCriteria)),
  });
  const webpushCounts = channel === "webpush" ? webpushCountQuery.data : undefined;
  const webpushExempt = webpushCounts?.unitPrice === 0;

  const audienceMutation = useMutation({
    mutationFn: ({
      criteria,
      channel,
    }: {
      criteria: SmsAudienceCriteria;
      channel: AudienceResolvedChannel;
    }) =>
      isExpert
        ? // Counts only (no identifier lists) + the estimated cost.
          (resolveExpertAudience({
            data: {
              criteria: criteria as unknown as Record<string, unknown>,
              channel,
              voiceSeconds: channel === "voice" ? expertVoiceSecondsRef.current : null,
            },
          }) as Promise<ResolvedAudience>)
        : resolveAudience({ data: { criteria, channel } }),
    onSuccess: (result) => setAudience(result),
    onError: (error: Error) => toast.error(tenantSafeChannelError(error)),
  });

  // Expert voice: a different audio changes the estimated cost (server estimate).
  useEffect(() => {
    if (!open || !isExpert || channel !== "voice" || !audienceCriteria) return;
    audienceMutation.mutate({ criteria: audienceCriteria, channel });
  }, [voiceSourceId, voiceMode]);

  useEffect(() => {
    if (!open || initialDraftId || !initialAudienceId || channel === "webpush") return;
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
        : channel === "webpush"
          ? ""
          : (activeScript?.content ?? "");
  const invalidVariables =
    channel === "webpush" ? [] : unknownMessageVariables(previewContent, channel);
  const isExternalList = !isExpert && channel === "sms" && audienceId === EXTERNAL_LIST_ID;
  const externalList = useMemo(
    () => parsePhoneList(`${externalText}\n${externalFile?.text ?? ""}`),
    [externalText, externalFile],
  );
  const externalBlockedVariables = isExternalList ? externalListBlockedVariables(smsContent) : [];
  const recipients =
    channel === "webpush"
      ? (webpushCounts?.subscriptions ?? 0)
      : isExternalList
        ? externalList.phones.length
        : (audience?.eligibleTotal ?? 0);
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
    enabled: open && !isExpert && channel === "sms" && smsPhones.length > 0,
    staleTime: 60_000,
    retry: false,
  });
  const smsPreview = channel === "sms" ? smsRecipientPreview.data : undefined;
  const sendableRecipients = smsPreview ? smsPreview.resolved : recipients;
  const smsSegmentInfo = countSmsSegments(toGsm7Text(smsContent));
  const parts = smsSegmentInfo.segments;
  const cost =
    channel === "sms"
      ? sendableRecipients * parts
      : channel === "webpush"
        ? (webpushCounts?.estimatedCost ?? 0)
        : recipients;
  const smsCostBrl = smsPrice == null ? null : parts * smsPrice.unitPrice;
  // Expert: estimated cost for every channel and what the monthly cap allows.
  const expertUsageData = expertUsage.data as ExpertCampaignUsageData | undefined;
  const expertCost = isExpert
    ? expertEstimatedCost({
        // Web push is never offered to the expert (webpushAvailable is house-only).
        channel: channel as "sms" | "email" | "voice",
        recipients,
        smsSegments: parts,
        prices: expertOptions.data?.prices,
        serverEstimate: (audience as { estimatedCost?: number } | null)?.estimatedCost ?? null,
      })
    : null;
  const expertCapBlock = isExpert ? expertCapBlockReason(expertUsageData, expertCost ?? 0) : null;
  const expertRemainingAfter = isExpert
    ? remainingAfterSend(expertUsageData, expertCost ?? 0)
    : null;
  const approvalMode = isExpert && expertOptions.data?.envioModo === "aprovacao";
  // The input is read in Brasília time, whatever the browser's timezone.
  const scheduleIso = fromBrtInput(scheduledAt);
  const scheduleTooSoon = !scheduleIso || Date.parse(scheduleIso) < Date.now() + 60_000;
  const webpushContentError =
    channel === "webpush"
      ? (() => {
          try {
            validateCampaignContent({
              title: webpushTitle,
              body: webpushBody,
              url: webpushUrl,
              imageUrl: webpushImageUrl || null,
            });
            return null;
          } catch (error) {
            return error instanceof Error ? error.message : "Conteúdo inválido.";
          }
        })()
      : null;
  const validationIssues = [
    !name.trim() ? "Informe o nome da campanha." : null,
    channel === "webpush"
      ? (webpushAudienceKind === "filtro" && !audienceCriteria) || recipients === 0
        ? "Escolha um público com destinatários elegíveis."
        : null
      : isExternalList
        ? recipients === 0
          ? "Cole ou envie uma lista com números de celular válidos."
          : null
        : !audience || recipients === 0
          ? "Escolha um público com destinatários elegíveis."
          : null,
    externalBlockedVariables.length ? externalListVariablesError(externalBlockedVariables) : null,
    channel === "sms" && !smsContent.trim() ? "Escreva ou selecione a mensagem de SMS." : null,
    smsAccountError,
    channel === "email" && !emailTemplateId ? "Selecione um template de e-mail." : null,
    channel === "voice" && !voiceSourceId
      ? voiceMode === "script"
        ? "Selecione um roteiro."
        : "Selecione um áudio da biblioteca."
      : null,
    webpushContentError,
    when === "schedule" && !scheduledAt ? "Escolha a data e hora do agendamento." : null,
    when === "schedule" && scheduledAt && scheduleTooSoon
      ? "O agendamento deve ter pelo menos um minuto de antecedência."
      : null,
    ...(invalidVariables.length
      ? [`Variáveis não reconhecidas: ${invalidVariables.join(", ")}`]
      : []),
    expertCapBlock,
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
      // Web push has no draft (controller ruling): this payload is computed
      // but the autosave effect skips `channel === "webpush"` entirely.
      channel: channel as "sms" | "email" | "voice",
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
      queryClient.invalidateQueries({ queryKey: source.queryKeys.drafts });
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
    // Web push has no draft (controller ruling, Task 13 brief).
    if (!open || submitted.current || channel === "webpush" || (initialDraftId && !draftQuery.data))
      return;
    setDraftState("dirty");
    const timer = window.setTimeout(() => autosave.mutate(), 700);
    return () => window.clearTimeout(timer);
  }, [serializedDraft, open, channel, initialDraftId, draftQuery.data]);

  // A server refusal no longer applies once the campaign is edited.
  useEffect(() => {
    setServerError(null);
  }, [serializedDraft]);

  const submit = useMutation({
    mutationFn: async (confirmedCount?: number) => {
      // Defense in depth: the tab and the fields are already gated on
      // `webpushAvailable`, but a click racing the clamp effect (or a stale
      // `channel` captured just before the integration query settles) must
      // not reach `scheduleWebpushCampaignFn`.
      if (channel === "webpush" && !webpushAvailable)
        throw new Error("Web Push não está disponível para esta casa.");
      if (!name.trim()) throw new Error("Informe o nome da campanha.");
      // The audience changed after the typed confirmation: ask again for the new count.
      if (requiresTypedConfirmation(sendableRecipients) && confirmedCount !== sendableRecipients)
        throw new Error(
          "A quantidade de destinatários mudou depois da confirmação. Nada foi enviado; confirme de novo.",
        );
      if (channel === "webpush") {
        if ((webpushAudienceKind === "filtro" && !audienceCriteria) || recipients === 0)
          throw new Error("Escolha um público com destinatários elegíveis.");
      } else if (isExternalList) {
        if (recipients === 0)
          throw new Error("Cole ou envie uma lista com números de celular válidos.");
        if (externalBlockedVariables.length)
          throw new Error(externalListVariablesError(externalBlockedVariables));
      } else if (!audience || recipients === 0)
        throw new Error("Escolha um público com destinatários elegíveis.");
      if (invalidVariables.length)
        throw new Error(`Variáveis inválidas: ${invalidVariables.join(", ")}`);
      if (when === "schedule" && !scheduledAt)
        throw new Error("Escolha a data e hora do agendamento.");
      if (when === "schedule" && scheduleTooSoon)
        throw new Error("O agendamento deve ter pelo menos um minuto de antecedência.");
      if (channel === "email" && emailBlocked) throw new Error(EMAIL_BLOCKED_WARNING);
      const scheduleAt = when === "schedule" ? (fromBrtInput(scheduledAt) ?? undefined) : undefined;

      if (channel === "webpush") {
        const payload = buildWebpushScheduleInput({
          name,
          title: webpushTitle,
          body: webpushBody,
          url: webpushUrl,
          imageUrl: webpushImageUrl,
          audienceKind: webpushAudienceKind,
          audienceCriteria,
          scheduledAt: scheduleAt ?? null,
        });
        const completed = await scheduleWebpushCampaign({ data: payload });
        // No draft (controller ruling): nothing to submit here.
        submitted.current = true;
        return completed;
      }

      if (isExpert) {
        // The expert sends the audience criteria; the server re-resolves it
        // inside the expert's scope, checks the cap and the link policy, and
        // queues the campaign (pending approval in "aprovacao" mode).
        if (expertCapBlock) throw new Error(expertCapBlock);
        const criteria = (audienceCriteria ?? {}) as unknown as Record<string, unknown>;
        let completed: unknown;
        if (channel === "sms") {
          if (!smsContent.trim()) throw new Error("Escreva ou selecione a mensagem de SMS.");
          const base = { campaignName: name, content: smsContent, audienceCriteria: criteria };
          completed = scheduleAt
            ? await scheduleExpertSms({ data: { ...base, scheduledAt: scheduleAt } })
            : await sendExpertSms({ data: base });
        } else if (channel === "email") {
          if (!emailTemplateId) throw new Error("Selecione um template de e-mail.");
          completed = await saveExpertEmail({
            data: {
              nome: name,
              templateId: emailTemplateId,
              audienceCriteria: criteria,
              agendadoPara: scheduleAt ?? null,
              status: "agendada",
            },
          });
        } else {
          if (!voiceSourceId) throw new Error("Selecione um roteiro ou áudio da biblioteca.");
          completed = await dispatchExpertVoice({
            data: {
              campaign_name: name,
              scheduled_at: scheduleAt,
              script_id: voiceMode === "script" ? voiceSourceId : undefined,
              asset_id: voiceMode === "asset" ? voiceSourceId : undefined,
              audienceCriteria: criteria,
            },
          });
        }
        if (draftId) await submitDraft({ data: { id: draftId } });
        submitted.current = true;
        return completed;
      }

      if (channel === "sms") {
        if (!smsContent.trim()) throw new Error("Escreva ou selecione a mensagem de SMS.");
        if (smsAccountError) throw new Error(smsAccountError);
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
          // Only meaningful when the house has extra accounts; null = "Padrão da casa".
          providerAccountId: smsAccount.providerAccountId,
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
            // "Enviar agora" claims it from rascunho (claimEmailCampaignForSendNow).
            status: when === "schedule" ? "agendada" : "rascunho",
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
      if (isExpert) {
        const pending =
          (result as { approvalStatus?: string | null } | null | undefined)?.approvalStatus ===
          "pendente";
        toast.success(
          pending
            ? "Campanha enviada para aprovação"
            : when === "schedule"
              ? "Campanha agendada"
              : "Campanha na fila de envio",
          pending ? { description: EXPERT_APPROVAL_NOTICE } : undefined,
        );
        onCreated();
        onOpenChange(false);
        return;
      }
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
      if (emailRun?.interrompida) {
        toast.warning(campaignInterruptedMessage(emailRun));
        onCreated();
        onOpenChange(false);
        return;
      }
      if (emailRun?.continuaEmLotes) {
        toast.success(campaignContinuesInBatchesMessage(emailRun));
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
    onError: (error: Error) => {
      // Expert: the server's own message (link policy, cap, audience) stays on
      // screen next to the other notices, not only in a toast.
      if (isExpert) setServerError(error.message);
      toast.error(tenantSafeChannelError(error));
    },
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
    if (
      audienceMutation.isPending ||
      smsRecipientPreview.isFetching ||
      (channel === "webpush" && webpushCountQuery.isFetching)
    )
      return;
    let confirmedCount: number | undefined;
    if (validationIssues.length === 0 && requiresTypedConfirmation(sendableRecipients)) {
      const count = sendableRecipients;
      const sendSummary = isExpert
        ? expertCampaignSendLabel({ when, recipients: count, cost: expertCost, approval: false })
        : campaignSendLabel({
            channel,
            when,
            recipients: count,
            cost,
            smsUnitPrice: smsPrice?.unitPrice,
            smsExempt,
            webpushExempt,
          });
      const typed = await requestTextInput({
        title: when === "schedule" ? "Confirmar agendamento em massa" : "Confirmar envio em massa",
        description: `${sendSummary}${
          channel === "sms" && smsAccountName ? ` · Enviar por: ${smsAccountName}` : ""
        }. Para confirmar, digite a quantidade de destinatários. Depois de iniciado, o envio não pode ser desfeito.`,
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
      ? isExpert
        ? `${num(audience.excludedTotal)} ${audience.excludedTotal === 1 ? "lead fica" : "leads ficam"} de fora por cadastro inválido, sem contato ou sem consentimento.`
        : `${num(audience.excludedTotal)} ${audience.excludedTotal === 1 ? "jogador fica" : "jogadores ficam"} de fora por cadastro inválido, sem contato ou sem consentimento.`
      : null,
  ].filter((item): item is string => Boolean(item));
  const expertSubmitLabel = expertCampaignSendLabel({
    when,
    recipients: sendableRecipients,
    cost: expertCost,
    approval: approvalMode,
  });
  // Same conditions under which UnresolvedRecipientsNotice renders something.
  const showSmsRecipientCheck =
    channel === "sms" &&
    smsPhones.length > 0 &&
    ((smsRecipientPreview.isFetching && !smsPreview) ||
      smsRecipientPreview.isError ||
      (smsPreview?.unresolvedCount ?? 0) > 0);
  const hasNotices =
    validationIssues.length > 0 ||
    audienceWarnings.length > 0 ||
    showSmsRecipientCheck ||
    Boolean(serverError);
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
            {channel !== "webpush" && (
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
            )}
          </div>
          <DialogDescription className="text-body">
            {channel === "webpush"
              ? "Escolha o público e a mensagem da notificação."
              : "Escolha o canal, o público e a mensagem. O rascunho é salvo enquanto você edita."}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6 sm:py-5">
          <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_280px]">
            <div className="min-w-0 space-y-5">
              <div className="space-y-2">
                <Label>Canal</Label>
                <div {...tourAnchor("campanhas.compositor.canal")}>
                  <SegmentedFilter
                    label="Canal da campanha"
                    value={channel}
                    onValueChange={(item) => {
                      setChannel(item);
                      // The external phone list is an SMS-only audience.
                      if (audienceId === EXTERNAL_LIST_ID && item !== "sms") setAudienceId("");
                      // Web push counts subscriptions (countWebpushAudienceFn), it never
                      // goes through resolveCampaignAudience like the other channels.
                      if (item === "webpush") return;
                      const selected = audienceOptions.find((option) => option.id === audienceId);
                      if (selected) {
                        setAudienceCriteria(selected.criteria);
                        audienceMutation.mutate({ criteria: selected.criteria, channel: item });
                      }
                    }}
                    items={visibleChannels.map((item) => ({
                      value: item,
                      label: channelMeta[item].label,
                    }))}
                  />
                </div>
                {visibleChannels.length === 0 && (
                  <p className="rounded-md border border-warning/30 bg-warning/10 p-2 text-[12.5px] text-warning">
                    Nenhum canal está disponível para campanhas nesta casa.
                  </p>
                )}
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
                  {...tourAnchor("campanhas.compositor.nome")}
                />
              </div>
              {channel !== "webpush" && (
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
                    {...tourAnchor("campanhas.compositor.publico")}
                  >
                    <SelectValue placeholder="Selecione um público salvo" />
                  </SelectTrigger>
                  <SelectContent>
                    {channel === "sms" && !isExpert ? (
                      <SelectItem value={EXTERNAL_LIST_ID}>
                        Lista de números · quem ainda não é jogador
                      </SelectItem>
                    ) : null}
                    {audienceOptions.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {audienceOptionLabel(item, isExpert)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {isExpert ? (
                  <p className="text-meta text-muted-foreground">
                    Só os seus leads entram no envio, mesmo nos públicos da casa.
                  </p>
                ) : null}
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
                      {...tourAnchor("campanhas.compositor.lista-numeros")}
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
                        {...tourAnchor("campanhas.compositor.lista-arquivo")}
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
              )}
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
                          {...tourAnchor("campanhas.compositor.sms-template")}
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
                      {isExpert ? null : (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setSmsTemplateDialogOpen(true)}
                          {...tourAnchor("campanhas.compositor.sms-novo-template")}
                        >
                          <Plus /> Novo template
                        </Button>
                      )}
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
                      {...tourAnchor("campanhas.compositor.sms-mensagem")}
                    />
                    <div {...tourAnchor("campanhas.compositor.sms-variaveis")}>
                      <MessageVariablePicker
                        channel="sms"
                        textareaRef={smsContentRef}
                        value={smsContent}
                        onChange={setSmsContent}
                      />
                    </div>
                    <div {...tourAnchor("campanhas.compositor.links")}>
                      <LinkInsertMenu
                        siteUrl={siteUrl}
                        quickLinks={quickLinks}
                        textareaRef={smsContentRef}
                        value={smsContent}
                        onChange={setSmsContent}
                      />
                    </div>
                    <p className="text-meta text-muted-foreground">
                      {Array.from(smsContent).length} caracteres · {smsSegmentInfo.encoding} ·{" "}
                      {parts} segmento{parts === 1 ? "" : "s"} ·{" "}
                      {isExpert
                        ? expertOptions.data
                          ? `${brl(parts * expertOptions.data.prices.sms)} por lead`
                          : "—"
                        : smsExempt
                          ? "casa isenta"
                          : smsCostBrl == null
                            ? "—"
                            : `${brl(smsCostBrl)} por jogador`}
                    </p>
                  </div>
                  {isExpert ? null : (
                    <div className="space-y-2">
                      <Label htmlFor={smsDomainId}>
                        <Term id="encurtador">Domínio do encurtador</Term>
                      </Label>
                      <ShortenerFallbackNotice
                        isSuccess={composerOptions.isSuccess}
                        isError={composerOptions.isError}
                        shortenerPending={shortenerPending}
                        hasVerifiedDomain={shortDomains.length > 0}
                      />
                      <div {...tourAnchor("campanhas.compositor.sms-dominio")}>
                        <ShortDomainSelect
                          id={smsDomainId}
                          domains={shortDomains}
                          value={shortDomainId}
                          onChange={setShortDomainId}
                        />
                      </div>
                    </div>
                  )}
                  {smsAccount.showChoice ? (
                    <SmsSendAccountSelect
                      id={smsAccountFieldId}
                      choices={smsAccount.choices}
                      value={smsAccountId}
                      onChange={setSmsAccountId}
                      invalid={submitAttempted && Boolean(smsAccountError)}
                    />
                  ) : null}
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
                          {...tourAnchor("campanhas.compositor.email-template")}
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
                      {isExpert ? null : (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setEmailTemplateDialogOpen(true)}
                          {...tourAnchor("campanhas.compositor.email-novo-template")}
                        >
                          <Plus /> Novo template
                        </Button>
                      )}
                    </div>
                    {isExpert ? (
                      <p className="text-meta text-muted-foreground">
                        Templates publicados da casa. O conteúdo é copiado quando a campanha é salva
                        e sai com o remetente padrão da casa.
                      </p>
                    ) : null}
                  </div>
                  <div {...tourAnchor("campanhas.compositor.email-variaveis")}>
                    <MessageVariablePicker
                      channel="email"
                      readOnly
                      label="Variáveis aceitas nos templates de e-mail"
                    />
                  </div>
                  {isExpert ? null : (
                    <>
                      <div className="space-y-2">
                        <Label htmlFor={emailSenderFieldId}>
                          <Term id="remetente">Remetente</Term>
                        </Label>
                        <EmailBlockedNotice
                          isSuccess={composerOptions.isSuccess}
                          isError={composerOptions.isError}
                          hasVerifiedSender={emailSenders.length > 0}
                        />
                        <div {...tourAnchor("campanhas.compositor.email-remetente")}>
                          <EmailSenderSelect
                            id={emailSenderFieldId}
                            senders={emailSenders}
                            value={senderId}
                            onChange={setSenderId}
                          />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor={emailDomainId}>
                          <Term id="encurtador">Domínio do encurtador</Term>
                        </Label>
                        <ShortenerFallbackNotice
                          isSuccess={composerOptions.isSuccess}
                          isError={composerOptions.isError}
                          shortenerPending={shortenerPending}
                          hasVerifiedDomain={shortDomains.length > 0}
                        />
                        <div {...tourAnchor("campanhas.compositor.email-dominio")}>
                          <ShortDomainSelect
                            id={emailDomainId}
                            domains={shortDomains}
                            value={shortDomainId}
                            onChange={setShortDomainId}
                          />
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
              {channel === "voice" && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>Conteúdo da ligação</Label>
                    <div {...tourAnchor("campanhas.compositor.voz-modo")}>
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
                          {...tourAnchor("campanhas.compositor.voz-fonte")}
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
                      {isExpert ? null : (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => {
                            if (voiceMode === "asset") setVoiceUploadDialogOpen(true);
                            else setVoiceScriptDialogOpen(true);
                          }}
                          {...tourAnchor("campanhas.compositor.voz-novo")}
                        >
                          <Plus />
                          {voiceMode === "asset" ? "Enviar áudio" : "Novo roteiro"}
                        </Button>
                      )}
                    </div>
                  </div>
                  <p className="text-meta text-muted-foreground">
                    Até 200 jogadores por campanha de voz.
                    {voiceMode === "script" && activeScript
                      ? ` Roteiro v${activeScript.version ?? 1} · ${previewContent.length} caracteres. A voz é gerada a partir do texto e um roteiro repetido reaproveita o áudio já gerado.`
                      : ""}
                  </p>
                  {voiceMode === "script" && (
                    <div {...tourAnchor("campanhas.compositor.voz-variaveis")}>
                      <MessageVariablePicker
                        channel="voice"
                        readOnly
                        label="Variáveis aceitas nos roteiros de voz"
                      />
                    </div>
                  )}
                </div>
              )}
              {channel === "webpush" && webpushAvailable && (
                <WebpushCampaignFields
                  title={webpushTitle}
                  onTitleChange={setWebpushTitle}
                  body={webpushBody}
                  onBodyChange={setWebpushBody}
                  url={webpushUrl}
                  onUrlChange={setWebpushUrl}
                  imageUrl={webpushImageUrl}
                  onImageUrlChange={setWebpushImageUrl}
                  audienceKind={webpushAudienceKind}
                  onAudienceKindChange={setWebpushAudienceKind}
                  audienceOptions={audienceOptions}
                  audienceId={audienceId}
                  onAudienceChange={(id, criteria) => {
                    setAudienceId(id);
                    setAudienceCriteria(criteria);
                  }}
                  counts={webpushCounts}
                  countsLoading={webpushCountQuery.isFetching}
                  submitAttempted={submitAttempted}
                />
              )}
              <div className="space-y-2">
                <Label>Quando enviar</Label>
                <div {...tourAnchor("campanhas.compositor.quando")}>
                  <SegmentedFilter
                    label="Quando enviar"
                    value={when}
                    onValueChange={setWhen}
                    items={[
                      { value: "now", label: "Agora" },
                      { value: "schedule", label: "Agendar" },
                    ]}
                  />
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
                        submitAttempted && when === "schedule" && (!scheduledAt || scheduleTooSoon)
                      }
                      {...tourAnchor("campanhas.compositor.agendamento")}
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
                  {...tourAnchor("campanhas.compositor.avisos")}
                >
                  {serverError ? (
                    <p
                      className={cn(
                        "flex items-start gap-2 font-medium text-danger",
                        validationIssues.length > 0 && "mb-3 border-b border-border pb-3",
                      )}
                    >
                      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                      <span>
                        <span className="sr-only">Erro do servidor: </span>
                        {serverError}
                      </span>
                    </p>
                  ) : null}
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
              {...tourAnchor("campanhas.compositor.resumo")}
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
                  {(channel === "webpush" ? webpushCountQuery.isFetching : audienceMutation.isPending)
                    ? "…"
                    : num(sendableRecipients)}
                </p>
                {isExternalList ? (
                  <p className="text-meta text-muted-foreground">
                    Lista de números · {num(externalList.phones.length)} válido(s)
                  </p>
                ) : null}
                {audience && audienceName && !isExternalList ? (
                  <p className="text-meta text-muted-foreground">
                    {audienceName} · {num(audience.total)}{" "}
                    {isExpert
                      ? audience.total === 1
                        ? "lead"
                        : "leads"
                      : audience.total === 1
                        ? "jogador"
                        : "jogadores"}{" "}
                    no público
                  </p>
                ) : null}
              </div>
              {isExpert ? (
                <div id={fieldIds.cost} aria-live="polite">
                  <p className="text-meta text-muted-foreground">Custo estimado</p>
                  <p className="font-medium tabular-nums">
                    {audienceMutation.isPending || expertCost == null ? "—" : brl(expertCost)}
                  </p>
                  <p className="mt-1 text-meta text-muted-foreground">
                    {expertUsageData == null
                      ? "Carregando seu teto mensal…"
                      : expertUsageData.teto === null
                        ? "Sem teto mensal definido."
                        : `Restante do teto após este envio: ${brl(Math.max(0, expertRemainingAfter ?? 0))}`}
                  </p>
                </div>
              ) : null}
              {channel === "sms" && smsAccountName ? (
                <div>
                  <p className="text-meta text-muted-foreground">Enviar por</p>
                  <p className="font-medium">{smsAccountName}</p>
                </div>
              ) : null}
              {channel === "sms" && !isExpert ? (
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
              {channel === "webpush" ? (
                <div>
                  <p className="text-meta text-muted-foreground">Custo estimado</p>
                  <p className="font-medium tabular-nums">
                    {webpushCountQuery.isFetching
                      ? "—"
                      : webpushExempt
                        ? "Isento"
                        : brl(cost)}
                  </p>
                </div>
              ) : null}
              <div>
                <p className="text-meta text-muted-foreground">Conteúdo</p>
                <p className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap rounded-lg bg-secondary/50 p-2.5 text-meta text-muted-foreground">
                  {channel === "webpush"
                    ? webpushTitle || webpushBody
                      ? `${webpushTitle} — ${webpushBody}`
                      : "Selecione o conteúdo para visualizar"
                    : channel === "voice" && voiceMode === "asset"
                      ? (assets.find((item) => item.id === voiceSourceId)?.name ??
                        "Selecione um áudio")
                      : isExpert && channel === "email" && activeEmailTemplate
                      ? `${activeEmailTemplate.nome ?? activeEmailTemplate.name ?? ""}${
                          activeEmailTemplate.subject
                            ? ` · Assunto: ${activeEmailTemplate.subject}`
                            : ""
                        }`
                      : previewContent || "Selecione o conteúdo para visualizar"}
                </p>
              </div>
              {approvalMode ? (
                <p
                  id={fieldIds.approval}
                  className="rounded-lg border border-info/30 bg-info/10 p-2.5 text-meta text-info"
                >
                  {EXPERT_APPROVAL_NOTICE}
                </p>
              ) : null}
              <p className="flex items-center gap-2 text-meta text-muted-foreground">
                <CheckCircle2 className="size-3.5 shrink-0 text-success" aria-hidden="true" />
                Consentimentos são verificados antes do envio.
              </p>
            </aside>
          </div>
        </div>

        <DialogFooter className="shrink-0 flex-col-reverse gap-2 border-t border-border px-4 py-3 sm:flex-row sm:px-6">
          <Button
            className="w-full sm:w-auto"
            variant="ghost"
            onClick={() => void requestClose()}
            {...tourAnchor("campanhas.compositor.cancelar")}
          >
            Cancelar
          </Button>
          <Button
            className="h-auto min-h-9 w-full whitespace-normal py-2 sm:w-auto"
            disabled={
              submit.isPending ||
              visibleChannels.length === 0 ||
              (channel === "webpush" ? webpushCountQuery.isFetching : audienceMutation.isPending) ||
              smsRecipientPreview.isFetching ||
              // Web push has no draft (controller ruling): the draft gates below
              // don't apply to it.
              (channel !== "webpush" &&
                (!draftId ||
                  draftState === "dirty" ||
                  draftState === "saving" ||
                  draftState === "error")) ||
              (channel === "email" && emailBlocked) ||
              Boolean(expertCapBlock)
            }
            onClick={() => void confirmAndSubmit()}
            aria-describedby={
              [
                validationIssues.length ? fieldIds.validation : null,
                approvalMode ? fieldIds.approval : null,
                isExpert ? fieldIds.cost : null,
              ]
                .filter(Boolean)
                .join(" ") || undefined
            }
            {...tourAnchor("campanhas.compositor.enviar")}
          >
            {submit.isPending
              ? "Processando..."
              : isExpert
                ? expertSubmitLabel
                : campaignSendLabel({
                    channel,
                    when,
                    recipients: sendableRecipients,
                    cost,
                    smsUnitPrice: smsPrice?.unitPrice,
                    smsExempt,
                    webpushExempt,
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
