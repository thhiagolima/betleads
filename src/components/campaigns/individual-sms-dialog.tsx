import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Mail, MessageSquare, Phone, Plus, Send, UserRound, X } from "lucide-react";
import { toast } from "sonner";

import { LinkTrackingToggle } from "@/components/link-tracking-toggle";
import { MessageVariablePicker } from "@/components/message-variable-picker";
import { SmsTemplateDialog } from "@/components/sms/sms-template-dialog";
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
import { sendTestEmail } from "@/lib/email.functions";
import { previewTrackedText, smsPartsForLength } from "@/lib/link-tracking-preview";
import { sendBulkSms } from "@/lib/sms.functions";
import { listSmsTemplates } from "@/lib/sms-templates.functions";

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
  const queryClient = useQueryClient();
  const [channel, setChannel] = useState<Channel>("sms");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("Mensagem da sua equipe");
  const [message, setMessage] = useState("Olá {primeiro_nome}, temos uma novidade para você.");
  const [templateId, setTemplateId] = useState("");
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [scriptId, setScriptId] = useState("");
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
  const mutation = useMutation({
    mutationFn: () => {
      if (channel === "email") {
        return sendEmail({ data: { to: email, subject, html: message, trackLinks } });
      }
      if (channel === "voice") {
        return sendVoice({
          data: {
            campaign_name: `Teste individual: ${name.trim() || digits}`,
            script_id: scriptId,
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
      : digits.length >= 10 && (channel === "voice" ? Boolean(scriptId) : Boolean(message.trim()));

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
            <div className="space-y-1.5">
              <Label>Assunto</Label>
              <Input value={subject} onChange={(event) => setSubject(event.target.value)} />
            </div>
          )}
          {channel === "voice" ? (
            <div className="space-y-1.5">
              <Label>Script aprovado</Label>
              <Select value={scriptId} onValueChange={setScriptId}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecione um script" />
                </SelectTrigger>
                <SelectContent>
                  {(
                    (scripts.data?.scripts ?? []) as Array<{
                      id: string;
                      name: string;
                      status: string;
                    }>
                  )
                    .filter((item) => item.status === "active")
                    .map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
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
    </Dialog>
  );
}
