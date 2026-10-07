import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Mail,
  MessageSquare,
  Phone,
  Send,
} from "lucide-react";
import { toast } from "sonner";

import { LinkTrackingToggle } from "@/components/link-tracking-toggle";
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
import { listEmailTemplates, saveEmailCampaign, sendEmailCampaignNow } from "@/lib/email.functions";
import { num } from "@/lib/format";
import { listJourneyVoiceAssets } from "@/lib/journey-voice-assets.functions";
import { resolveSmsCampaignAudience } from "@/lib/sms-audiences.functions";
import { SYSTEM_SMS_AUDIENCES, type SmsAudienceCriteria } from "@/lib/sms-audience-criteria";
import { listSmsAudiences } from "@/lib/sms-audience-crud.functions";
import { listSmsTemplates } from "@/lib/sms-templates.functions";
import { scheduleBulkSms, sendBulkSms } from "@/lib/sms.functions";

type Channel = "sms" | "email" | "voice";
type AudienceOption = { id: string; name: string; criteria: SmsAudienceCriteria; system?: boolean };
type ResolvedAudience = {
  phones: string[];
  total: number;
  emailPlayerIds: string[];
  emailRecipientTotal?: number;
};

const variablePattern = /\{([a-zA-Z0-9_]+)\}/g;
const allowedVariables = new Set([
  "primeiro_nome",
  "nome",
  "telefone",
  "email",
  "saldo",
  "saldo_atual",
  "ultimo_login",
  "dias_sem_login",
  "ultimo_jogo",
  "dias_sem_jogar",
  "ultimo_deposito",
  "dias_sem_depositar",
  "total_depositado",
  "total_sacado",
  "lucro",
  "categoria",
  "status_lead",
  "expert",
  "nome_expert",
  "link",
  "link_deposito",
  "cashback_amount",
  "cashback_valor",
  "cashback_pago_em",
]);

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

export function ChannelCampaignComposer({
  open,
  onOpenChange,
  onCreated,
  initialChannel = "sms",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  initialChannel?: Channel;
}) {
  const resolveAudience = useServerFn(resolveSmsCampaignAudience);
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

  const [channel, setChannel] = useState<Channel>(initialChannel);
  const [name, setName] = useState("");
  const [audienceId, setAudienceId] = useState("");
  const [audience, setAudience] = useState<ResolvedAudience | null>(null);
  const [smsTemplateId, setSmsTemplateId] = useState("");
  const [smsContent, setSmsContent] = useState("");
  const [emailTemplateId, setEmailTemplateId] = useState("");
  const [voiceMode, setVoiceMode] = useState<"script" | "asset">("asset");
  const [voiceSourceId, setVoiceSourceId] = useState("");
  const [when, setWhen] = useState<"now" | "schedule">("now");
  const [scheduledAt, setScheduledAt] = useState("");
  const [trackLinks, setTrackLinks] = useState(true);
  const [riskConfirmed, setRiskConfirmed] = useState(false);

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
      ativo?: boolean;
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
    if (!open) return;
    setChannel(initialChannel);
    setName("");
    setAudienceId("");
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
  }, [open, initialChannel]);

  const audienceMutation = useMutation({
    mutationFn: (criteria: SmsAudienceCriteria) => resolveAudience({ data: { criteria } }),
    onSuccess: (result) => setAudience(result),
    onError: (error: Error) => toast.error(error.message),
  });

  const activeEmailTemplate = emailTemplates.find((item) => item.id === emailTemplateId);
  const activeScript = scripts.find((item) => item.id === voiceSourceId);
  const previewContent =
    channel === "sms"
      ? smsContent
      : channel === "email"
        ? (activeEmailTemplate?.body_html ?? "")
        : (activeScript?.content ?? "");
  const invalidVariables = unknownVariables(previewContent);
  const recipients =
    channel === "email" ? (audience?.emailPlayerIds.length ?? 0) : (audience?.phones.length ?? 0);
  const parts = smsParts(smsContent);
  const cost = channel === "sms" ? recipients * parts : recipients;
  const channelLimitError =
    channel === "voice" && recipients > 200
      ? "Voz aceita até 200 destinatários por campanha."
      : null;

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
          phones: audience.phones,
          content: smsContent,
          campaignName: name,
          route: "iGaming" as const,
          ratePerMinute: 1000,
          trackLinks,
          templateId: smsTemplateId || undefined,
        };
        return when === "schedule"
          ? scheduleSms({ data: { ...payload, scheduledAt: scheduleAt! } })
          : sendSms({ data: payload });
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
            targetPlayerIds: audience.emailPlayerIds,
            extraEmails: [],
            trackLinks,
          },
        } as never);
        return when === "schedule"
          ? created
          : sendEmail({ data: { campaignId: (created as { id: string }).id } } as never);
      }
      if (!voiceSourceId) throw new Error("Selecione um script ou áudio da biblioteca.");
      return dispatchVoice({
        data: {
          campaign_name: name,
          scheduled_at: scheduleAt,
          script_id: voiceMode === "script" ? voiceSourceId : undefined,
          asset_id: voiceMode === "asset" ? voiceSourceId : undefined,
          targets: audience.phones.map((phone) => ({ phone_number: phone })),
        },
      });
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
    onError: (error: Error) => toast.error(error.message),
  });

  const MetaIcon = channelMeta[channel].icon;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[94vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Composer de campanha</DialogTitle>
          <DialogDescription>
            Planeje, revise e dispare SMS, e-mail ou voz em um único fluxo.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-5 md:grid-cols-[1fr_280px]">
          <div className="space-y-5">
            <div className="grid grid-cols-3 gap-2">
              {(Object.keys(channelMeta) as Channel[]).map((item) => {
                const Icon = channelMeta[item].icon;
                return (
                  <Button
                    key={item}
                    type="button"
                    variant={channel === item ? "default" : "outline"}
                    className="h-auto py-3"
                    onClick={() => {
                      setChannel(item);
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
              <Label>Nome da campanha</Label>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Ex.: Bônus de fim de semana"
              />
            </div>
            <div className="space-y-2">
              <Label>Público</Label>
              <Select
                value={audienceId}
                onValueChange={(value) => {
                  setAudienceId(value);
                  setAudience(null);
                  const selected = audienceOptions.find((item) => item.id === value);
                  if (selected) audienceMutation.mutate(selected.criteria);
                }}
              >
                <SelectTrigger>
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
              <p className="rounded-lg bg-muted/60 px-3 py-2 text-sm">
                <strong>{audienceMutation.isPending ? "Calculando..." : num(recipients)}</strong>{" "}
                destinatário(s) elegível(is)
                {audience && (
                  <span className="text-muted-foreground">
                    {" "}
                    de {num(audience.total)} jogador(es)
                  </span>
                )}
              </p>
            </div>
            {channel === "sms" && (
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label>Template SMS</Label>
                  <Select
                    value={smsTemplateId}
                    onValueChange={(value) => {
                      setSmsTemplateId(value);
                      const template = smsTemplates.find((item) => item.id === value);
                      if (template) setSmsContent(template.content);
                    }}
                  >
                    <SelectTrigger>
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
                </div>
                <div className="space-y-2">
                  <Label>Mensagem</Label>
                  <Textarea
                    rows={5}
                    value={smsContent}
                    onChange={(event) => setSmsContent(event.target.value)}
                    placeholder="Olá {primeiro_nome}, seu bônus está liberado."
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
                  <Label>Template de e-mail</Label>
                  <Select value={emailTemplateId} onValueChange={setEmailTemplateId}>
                    <SelectTrigger>
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
                  <Label>{voiceMode === "asset" ? "Áudio da biblioteca" : "Script ativo"}</Label>
                  <Select value={voiceSourceId} onValueChange={setVoiceSourceId}>
                    <SelectTrigger>
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
                </div>
                <p className="text-xs text-muted-foreground">
                  Estimativa: {num(cost)} chamada(s). O limite por campanha é 200 destinatários.
                </p>
              </div>
            )}
            {invalidVariables.length > 0 && (
              <p className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                <AlertTriangle className="size-4 shrink-0" />
                Variáveis não reconhecidas: {invalidVariables.join(", ")}
              </p>
            )}
            <div className="space-y-2">
              <Label>Quando disparar</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={when === "now" ? "default" : "outline"}
                  onClick={() => setWhen("now")}
                >
                  <Send className="mr-1.5 size-3.5" />
                  Agora
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={when === "schedule" ? "default" : "outline"}
                  onClick={() => setWhen("schedule")}
                >
                  <CalendarClock className="mr-1.5 size-3.5" />
                  Agendar
                </Button>
              </div>
              {when === "schedule" && (
                <>
                  <Input
                    type="datetime-local"
                    value={scheduledAt}
                    onChange={(event) => setScheduledAt(event.target.value)}
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
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-amber-500/35 bg-amber-500/5 p-3 text-sm">
              <Checkbox
                checked={riskConfirmed}
                onCheckedChange={(value) => setRiskConfirmed(value === true)}
              />
              <span>
                <strong>Confirmo a revisão de risco.</strong>
                <br />
                <span className="text-xs text-muted-foreground">
                  Público, conteúdo, custo estimado, consentimento e horário foram revisados.
                </span>
              </span>
            </label>
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
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            disabled={
              submit.isPending ||
              !riskConfirmed ||
              !name.trim() ||
              !audience ||
              recipients === 0 ||
              Boolean(invalidVariables.length) ||
              Boolean(channelLimitError)
            }
            onClick={() => submit.mutate()}
          >
            {submit.isPending
              ? "Processando..."
              : when === "schedule"
                ? "Confirmar agendamento"
                : "Confirmar e enviar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
