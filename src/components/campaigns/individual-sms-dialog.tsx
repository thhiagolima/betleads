import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Send, UserRound } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { LinkTrackingToggle } from "@/components/link-tracking-toggle";
import { previewTrackedText, smsPartsForLength } from "@/lib/link-tracking-preview";
import { sendBulkSms } from "@/lib/sms.functions";

function smsParts(length: number) {
  if (!length) return 0;
  return length <= 160 ? 1 : Math.ceil(length / 153);
}

function renderMessage(message: string, name: string, phone: string) {
  const fullName = name.trim();
  const firstName = fullName.split(/\s+/)[0] ?? "";
  return message
    .replaceAll("{nome}", fullName)
    .replaceAll("{primeiro_nome}", firstName)
    .replaceAll("{telefone}", phone);
}

export function IndividualSmsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const send = useServerFn(sendBulkSms);
  const queryClient = useQueryClient();
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("Olá {primeiro_nome}, temos uma novidade para você.");
  const [trackLinks, setTrackLinks] = useState(true);
  const digits = phone.replace(/\D/g, "");
  const previewContent = previewTrackedText(message, trackLinks);
  const parts = smsPartsForLength(previewContent.length);
  const preview = useMemo(() => renderMessage(message, name || "Cliente", digits), [message, name, digits]);
  const mutation = useMutation({
    mutationFn: () => send({ data: { phones: [digits], content: renderMessage(message, name, digits), campaignName: `Individual: ${name.trim() || digits}`, route: "iGaming", ratePerMinute: 1000, trackLinks } }),
    onSuccess: () => {
      toast.success("SMS enviado para processamento");
      queryClient.invalidateQueries({ queryKey: ["sms-scheduled-campaigns"] });
      queryClient.invalidateQueries({ queryKey: ["sms-compact-dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["sms-credits"] });
      setPhone(""); setName(""); onOpenChange(false);
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const canSend = digits.length >= 10 && message.trim().length > 0;

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-xl">
      <DialogHeader><DialogTitle>Envio individual por SMS</DialogTitle><DialogDescription>Informe o número, escreva a mensagem e envie agora.</DialogDescription></DialogHeader>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5"><Label>Telefone</Label><Input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="(11) 98765-4321" inputMode="tel" /></div>
          <div className="space-y-1.5"><Label>Nome (opcional)</Label><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Rafael" /></div>
        </div>
        <div className="space-y-1.5"><div className="flex items-center justify-between"><Label>Mensagem</Label><span className="text-xs text-muted-foreground">{previewContent.length} caracteres · {parts} parte{parts === 1 ? "" : "s"}</span></div><Textarea rows={5} value={message} onChange={(event) => setMessage(event.target.value)} /><div className="flex flex-wrap gap-1.5"><Button type="button" variant="outline" size="sm" onClick={() => setMessage((value) => `${value}{primeiro_nome}`)}>+ primeiro nome</Button><Button type="button" variant="outline" size="sm" onClick={() => setMessage((value) => `${value}{nome}`)}>+ nome</Button><Button type="button" variant="outline" size="sm" onClick={() => setMessage((value) => `${value}{telefone}`)}>+ telefone</Button></div></div>
        <LinkTrackingToggle value={trackLinks} onChange={setTrackLinks} content={message} channel="sms" />
        <div className="rounded-xl border border-primary/25 bg-primary/5 p-4"><div className="mb-2 flex items-center gap-2 text-sm font-medium"><UserRound className="h-4 w-4 text-primary" />Prévia para o celular</div><p className="text-sm leading-relaxed">{preview}</p></div>
      </div>
      <DialogFooter><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancelar</Button><Button disabled={!canSend || mutation.isPending} onClick={() => mutation.mutate()}><Send className="mr-2 h-4 w-4" />{mutation.isPending ? "Enviando…" : `Enviar · ${parts} crédito${parts === 1 ? "" : "s"}`}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
