import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LinkTrackingToggle } from "@/components/link-tracking-toggle";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { listEmailTemplates, saveEmailCampaign, sendEmailCampaignNow } from "@/lib/email.functions";
import { num } from "@/lib/format";
import { listSmsAudiences } from "@/lib/sms-audience-crud.functions";
import { SYSTEM_SMS_AUDIENCES, type SmsAudienceCriteria } from "@/lib/sms-audience-criteria";
import { resolveSmsCampaignAudience } from "@/lib/sms-audiences.functions";

type AudienceOption = { id: string; name: string; criteria: SmsAudienceCriteria; system?: boolean };

export function NewEmailCampaignDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const listAudiences = useServerFn(listSmsAudiences);
  const listTemplates = useServerFn(listEmailTemplates);
  const resolveAudience = useServerFn(resolveSmsCampaignAudience);
  const saveCampaign = useServerFn(saveEmailCampaign);
  const sendCampaign = useServerFn(sendEmailCampaignNow);
  const [name, setName] = useState("");
  const [selectedAudienceId, setSelectedAudienceId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [emailPlayerIds, setEmailPlayerIds] = useState<string[]>([]);
  const [audienceTotal, setAudienceTotal] = useState(0);
  const [when, setWhen] = useState<"now" | "schedule">("now");
  const [scheduledAt, setScheduledAt] = useState("");
  const [trackLinks, setTrackLinks] = useState(true);

  const saved = useQuery({ queryKey: ["sms-audiences"], queryFn: () => listAudiences(), enabled: open });
  const templatesQuery = useQuery({ queryKey: ["email-templates"], queryFn: () => listTemplates(), enabled: open });
  const options: AudienceOption[] = open
    ? [
        ...SYSTEM_SMS_AUDIENCES.map((item) => ({ ...item, system: true })),
        ...(saved.data ?? []).map((item: any) => ({ id: item.id, name: item.name, criteria: item.criteria as SmsAudienceCriteria })),
      ]
    : [];
  const templates = (templatesQuery.data?.items ?? []).filter((template: any) => template.ativo !== false) as Array<{ id: string; nome: string }>;

  const audience = useMutation({
    mutationFn: (criteria: SmsAudienceCriteria) => resolveAudience({ data: { criteria } }),
    onSuccess: (result) => {
      setAudienceTotal(result.total);
      setEmailPlayerIds(result.emailPlayerIds ?? []);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  useEffect(() => {
    if (!open) return;
    setName("");
    setSelectedAudienceId("");
    setTemplateId("");
    setEmailPlayerIds([]);
    setAudienceTotal(0);
    setWhen("now");
    setScheduledAt("");
    setTrackLinks(true);
  }, [open]);

  const submit = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Dê um nome para a campanha");
      if (!templateId) throw new Error("Selecione um template de email");
      if (!emailPlayerIds.length) throw new Error("Este público não possui jogadores com email válido");
      if (when === "schedule" && !scheduledAt) throw new Error("Escolha a data do disparo");
      const template = templates.find((item) => item.id === templateId);
      const created: any = await saveCampaign({
        data: {
          nome: name,
          audienceMode: "leads",
          segmento: "Público salvo",
          template: template?.nome ?? "Template selecionado",
          smtp: "Remetente padrão",
          templateId,
          smtpId: null,
          agendadoPara: when === "schedule" ? new Date(scheduledAt).toISOString() : null,
          status: when === "schedule" ? "agendada" : "enviando",
          targetPlayerIds: emailPlayerIds,
          extraEmails: [],
          trackLinks,
        },
      } as any);
      if (when === "now") return sendCampaign({ data: { campaignId: created.id } } as any);
      return created;
    },
    onSuccess: () => {
      toast.success(when === "schedule" ? "Campanha de email agendada" : "Campanha de email enviada para processamento");
      onCreated();
      onOpenChange(false);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Nova campanha de email</DialogTitle>
          <DialogDescription>Escolha um público, um template e defina o momento do envio.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5"><Label>Nome da campanha</Label><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex: Bônus de boas-vindas" /></div>
          <div className="space-y-2">
            <div className="flex items-center justify-between"><Label>Público</Label><Button variant="link" size="sm" asChild><Link to="/publicos" onClick={() => onOpenChange(false)}>Criar novo público</Link></Button></div>
            <Select value={selectedAudienceId} onValueChange={(value) => {
              setSelectedAudienceId(value);
              const selected = options.find((item) => item.id === value);
              if (selected) audience.mutate(selected.criteria);
            }}>
              <SelectTrigger><SelectValue placeholder="Escolha um público" /></SelectTrigger>
              <SelectContent>{options.map((item) => <SelectItem key={item.id} value={item.id}>{item.system ? `Nível · ${item.name}` : item.name}</SelectItem>)}</SelectContent>
            </Select>
            <div className="rounded-lg bg-primary/10 px-3 py-2 text-sm text-primary">
              <strong>{audience.isPending ? "…" : num(audienceTotal)}</strong> jogadores neste público
              {!audience.isPending && <span className="ml-1 text-muted-foreground">· {num(emailPlayerIds.length)} com email válido</span>}
            </div>
          </div>
          <div className="space-y-1.5"><Label>Template de email</Label><Select value={templateId} onValueChange={setTemplateId}><SelectTrigger><SelectValue placeholder="Escolha um template" /></SelectTrigger><SelectContent>{templates.map((template) => <SelectItem key={template.id} value={template.id}>{template.nome}</SelectItem>)}</SelectContent></Select>{templates.length === 0 && <p className="text-xs text-muted-foreground">Crie um template antes de disparar uma campanha de email.</p>}</div>
          <LinkTrackingToggle value={trackLinks} onChange={setTrackLinks} content="" channel="email" />
          <div className="space-y-2"><Label>Quando disparar</Label><div className="flex gap-2"><Button size="sm" variant={when === "now" ? "default" : "outline"} onClick={() => setWhen("now")}>Disparar agora</Button><Button size="sm" variant={when === "schedule" ? "default" : "outline"} onClick={() => setWhen("schedule")}>Agendar</Button></div>{when === "schedule" && <Input type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} />}</div>
        </div>
        <DialogFooter><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancelar</Button><Button disabled={submit.isPending || !name.trim() || !templateId || !emailPlayerIds.length} onClick={() => submit.mutate()}>{submit.isPending ? "Salvando…" : when === "schedule" ? "Agendar disparo" : "Disparar agora"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
