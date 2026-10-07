import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Mail, MessageSquare, Phone, Plus, Send, UserRound, X } from "lucide-react";
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
import { bulkDispatchCalls, listCallScripts } from "@/lib/calls.functions";
import { tenantSafeChannelError } from "@/lib/channel-error";
import { listEmailTemplates, saveEmailTemplate, sendTestEmail } from "@/lib/email.functions";
import { previewTrackedText, smsPartsForLength } from "@/lib/link-tracking-preview";
import { sendBulkSms } from "@/lib/sms.functions";
import { listSmsTemplates } from "@/lib/sms-templates.functions";
import { listJourneyVoiceAssets } from "@/lib/journey-voice-assets.functions";

type Channel = "sms" | "email" | "voice";

function renderMessage(message: string, name: string, phone: string) {
  const fullName = name.trim();
  const firstName = fullName.split(/\s+/)[0] ?? "";
  return message
    .replaceAll("{nome}", fullName)
    .replaceAll("{primeiro_nome}", firstName)
    .replaceAll("{telefone}", phone);
}

export function IndividualSmsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const sendSms = useServerFn(sendBulkSms);
  const sendEmail = useServerFn(sendTestEmail);
  const sendVoice = useServerFn(bulkDispatchCalls);
  const listScripts = useServerFn(listCallScripts);
  const listTemplates = useServerFn(listSmsTemplates);
  const listEmailTemplateFn = useServerFn(listEmailTemplates);
  const saveEmailTemplateFn = useServerFn(saveEmailTemplate);
  const listVoiceAssets = useServerFn(listJourneyVoiceAssets);
  const queryClient = useQueryClient();
  const [channel, setChannel] = useState<Channel>("sms");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("Mensagem da sua equipe");
  const [message, setMessage] = useState("Olá {primeiro_nome}, temos uma novidade para você.");
  const [templateId, setTemplateId] = useState("");
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [emailTemplateId, setEmailTemplateId] = useState("");
  const [emailTemplateDialogOpen, setEmailTemplateDialogOpen] = useState(false);
  const [scriptId, setScriptId] = useState("");
  const [voiceMode, setVoiceMode] = useState<"script" | "asset">("script");
  const [voiceAssetId, setVoiceAssetId] = useState("");
  const [voiceScriptDialogOpen, setVoiceScriptDialogOpen] = useState(false);
  const [voiceUploadDialogOpen, setVoiceUploadDialogOpen] = useState(false);
  const [trackLinks, setTrackLinks] = useState(true);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const digits = phone.replace(/\D/g, "");
  const previewContent = previewTrackedText(message, trackLinks);
  const parts = smsPartsForLength(previewContent.length);
  const preview = useMemo(
    () => renderMessage(message, name || "Cliente", digits),
    [message, name, digits],
  );

  const scripts = useQuery({
    queryKey: ["call-scripts", "individual"],
    queryFn: () => listScripts(),
    enabled: open && channel === "voice",
  });
  const templates = useQuery({
    queryKey: ["sms-templates"],
    queryFn: () => listTemplates(),
    enabled: open && channel === "sms",
  });
  const emailTemplates = useQuery({
    queryKey: ["email-templates"],
    queryFn: () => listEmailTemplateFn(),
    enabled: open && channel === "email",
  });
  const voiceAssets = useQuery({
    queryKey: ["journey-voice-assets"],
    queryFn: () => listVoiceAssets(),
    enabled: open && channel === "voice",
  });
  const saveVisualEmailTemplate = useMutation({
    mutationFn: (template: EditorTemplate) =>
      saveEmailTemplateFn({
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
    onSuccess: (result, template) => {
      queryClient.invalidateQueries({ queryKey: ["email-templates"] });
      setEmailTemplateId(result.id);
      setSubject(template.assunto);
      setMessage(template.corpo);
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
  const mutation = useMutation<unknown, Error, void>({
    mutationFn: () => {
      if (channel === "email") {
        return sendEmail({ data: { to: email, subject, html: message, trackLinks } });
      }
      if (channel === "voice") {
        return sendVoice({
          data: {
            campaign_name: `Teste individual: ${name.trim() || digits}`,
            script_id: voiceMode === "script" ? scriptId : undefined,
            asset_id: voiceMode === "asset" ? voiceAssetId : undefined,
            targets: [{ phone_number: digits }],
          },
        });
      }
      return sendSms({
        data: {
          phones: [digits],
          content: renderMessage(message, name, digits),
          campaignName: `Individual: ${name.trim() || digits}`,
          route: "iGaming",
          ratePerMinute: 1000,
          trackLinks,
          templateId: templateId || undefined,
        },
      });
    },
    onSuccess: () => {
      toast.success("Envio individual registrado para processamento");
      queryClient.invalidateQueries({ queryKey: ["sms-scheduled-campaigns"] });
      queryClient.invalidateQueries({ queryKey: ["sms-compact-dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["sms-credits"] });
      queryClient.invalidateQueries({ queryKey: ["call-queue"] });
      setPhone("");
      setEmail("");
      setName("");
      onOpenChange(false);
    },
    onError: (error: Error) => toast.error(tenantSafeChannelError(error)),
  });
  const canSend =
    channel === "email"
      ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && Boolean(subject.trim() && message.trim())
      : digits.length >= 10 &&
        (channel === "voice"
          ? Boolean(voiceMode === "script" ? scriptId : voiceAssetId)
          : Boolean(message.trim()));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Envio individual / teste</DialogTitle>
          <DialogDescription>
            Não é uma campanha. O envio respeita consentimento, janela de contato e fica registrado
            no histórico.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                ["sms", "SMS", MessageSquare],
                ["email", "E-mail", Mail],
                ["voice", "Voz", Phone],
              ] as const
            ).map(([value, label, Icon]) => (
              <Button
                key={value}
                type="button"
                variant={channel === value ? "default" : "outline"}
                onClick={() => setChannel(value)}
              >
                <Icon className="mr-1.5 size-4" /> {label}
              </Button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {channel === "email" ? (
              <div className="space-y-1.5">
                <Label>E-mail</Label>
                <Input
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="cliente@exemplo.com"
                  inputMode="email"
                />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label>Telefone</Label>
                <Input
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  placeholder="(11) 98765-4321"
                  inputMode="tel"
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label>Nome (opcional)</Label>
              <Input value={name} onChange={(event) => setName(event.target.value)} />
            </div>
          </div>
          {channel === "email" && (
            <div className="space-y-3 rounded-xl border bg-muted/20 p-3">
              <div className="space-y-1.5">
                <Label>Template de e-mail</Label>
                <Select
                  value={emailTemplateId}
                  onValueChange={(value) => {
                    setEmailTemplateId(value);
                    const selected = (emailTemplates.data?.items ?? []).find(
                      (item: { id: string }) => item.id === value,
                    ) as
                      | { assunto?: string; subject?: string; corpo?: string; body_html?: string }
                      | undefined;
                    if (selected) {
                      setSubject(selected.assunto ?? selected.subject ?? subject);
                      setMessage(selected.corpo ?? selected.body_html ?? message);
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Conteúdo manual" />
                  </SelectTrigger>
                  <SelectContent>
                    {(emailTemplates.data?.items ?? [])
                      .filter((item: { ativo?: boolean }) => item.ativo !== false)
                      .map((item: { id: string; nome?: string; name?: string }) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.nome ?? item.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setEmailTemplateDialogOpen(true)}
                >
                  <Plus className="mr-1.5 size-3.5" /> Criar template visual
                </Button>
                {emailTemplateId && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setEmailTemplateId("")}
                  >
                    <X className="mr-1.5 size-3.5" /> Usar como conteúdo manual
                  </Button>
                )}
              </div>
              <div className="space-y-1.5">
                <Label>Assunto</Label>
                <Input value={subject} onChange={(event) => setSubject(event.target.value)} />
              </div>
            </div>
          )}
          {channel === "voice" ? (
            <div className="space-y-3">
              <div className="flex gap-2" role="group" aria-label="Origem do áudio">
                <Button
                  type="button"
                  size="sm"
                  variant={voiceMode === "script" ? "default" : "outline"}
                  onClick={() => setVoiceMode("script")}
                >
                  Script TTS
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={voiceMode === "asset" ? "default" : "outline"}
                  onClick={() => setVoiceMode("asset")}
                >
                  Áudio fixo
                </Button>
              </div>
              <Label>{voiceMode === "script" ? "Script aprovado" : "Áudio da biblioteca"}</Label>
              <Select
                value={voiceMode === "script" ? scriptId : voiceAssetId}
                onValueChange={voiceMode === "script" ? setScriptId : setVoiceAssetId}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      voiceMode === "script" ? "Selecione um script" : "Selecione um áudio"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {(voiceMode === "script"
                    ? (
                        (scripts.data?.scripts ?? []) as Array<{
                          id: string;
                          name: string;
                          status: string;
                        }>
                      ).filter((item) => item.status === "active")
                    : (
                        (voiceAssets.data?.assets ?? []) as Array<{
                          id: string;
                          name: string;
                          is_archived?: boolean;
                        }>
                      ).filter((item) => !item.is_archived)
                  ).map((item) => (
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
                onClick={() =>
                  voiceMode === "script"
                    ? setVoiceScriptDialogOpen(true)
                    : setVoiceUploadDialogOpen(true)
                }
              >
                <Plus className="mr-1.5 size-3.5" />
                {voiceMode === "script" ? "Criar novo script" : "Enviar novo áudio"}
              </Button>
            </div>
          ) : (
            <div className="space-y-1.5">
              {channel === "sms" && (
                <div className="mb-4 space-y-2 rounded-xl border bg-muted/20 p-3">
                  <Label>Origem da mensagem</Label>
                  <Select
                    value={templateId}
                    onValueChange={(value) => {
                      setTemplateId(value);
                      const selected = templates.data?.items.find((item) => item.id === value);
                      if (selected) setMessage(selected.content);
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Mensagem manual" />
                    </SelectTrigger>
                    <SelectContent>
                      {(templates.data?.items ?? [])
                        .filter((item) => item.isActive)
                        .map((item) => (
                          <SelectItem key={item.id} value={item.id}>
                            {item.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setTemplateDialogOpen(true)}
                    >
                      <Plus className="mr-1.5 size-3.5" /> Criar template
                    </Button>
                    {templateId && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setTemplateId("")}
                      >
                        <X className="mr-1.5 size-3.5" /> Usar como mensagem manual
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Alterar o texto abaixo personaliza apenas este envio; o template salvo não é
                    modificado.
                  </p>
                </div>
              )}
              <div className="flex items-center justify-between">
                <Label>Mensagem</Label>
                {channel === "sms" && (
                  <span className="text-xs text-muted-foreground">
                    {previewContent.length} caracteres · {parts} parte{parts === 1 ? "" : "s"}
                  </span>
                )}
              </div>
              <Textarea
                ref={messageRef}
                rows={5}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
              />
              <MessageVariablePicker
                channel={channel}
                textareaRef={messageRef}
                value={message}
                onChange={setMessage}
              />
            </div>
          )}
          {channel !== "voice" && (
            <LinkTrackingToggle
              value={trackLinks}
              onChange={setTrackLinks}
              content={message}
              channel={channel}
            />
          )}
          {channel === "sms" && (
            <div className="rounded-xl border border-primary/25 bg-primary/5 p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                <UserRound className="h-4 w-4 text-primary" /> Prévia para o celular
              </div>
              <p className="text-sm leading-relaxed">{preview}</p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button disabled={!canSend || mutation.isPending} onClick={() => mutation.mutate()}>
            <Send className="mr-2 h-4 w-4" />
            {mutation.isPending
              ? "Enviando…"
              : channel === "sms"
                ? `Enviar · ${parts} crédito${parts === 1 ? "" : "s"}`
                : "Enviar teste"}
          </Button>
        </DialogFooter>
      </DialogContent>
      <SmsTemplateDialog
        open={templateDialogOpen}
        onOpenChange={setTemplateDialogOpen}
        initialContent={message}
        onCreated={(template) => {
          setTemplateId(template.id);
          setMessage(template.content);
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
          setVoiceAssetId(asset.id);
        }}
      />
      <ScriptFormDialog
        open={voiceScriptDialogOpen}
        onOpenChange={setVoiceScriptDialogOpen}
        defaultStatus="active"
        onSaved={(script) => {
          setVoiceMode("script");
          setScriptId(script.id);
        }}
      />
    </Dialog>
  );
}
