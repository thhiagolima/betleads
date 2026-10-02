import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { MessageVariablePicker } from "@/components/message-variable-picker";
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
import { listSmsAudiences } from "@/lib/sms-audience-crud.functions";
import { SYSTEM_SMS_AUDIENCES, type SmsAudienceCriteria } from "@/lib/sms-audience-criteria";
import { resolveSmsCampaignAudience } from "@/lib/sms-audiences.functions";
import { scheduleBulkSms, sendBulkSms } from "@/lib/sms.functions";
import { num } from "@/lib/format";

const SMS_VARIABLE_KEYS = [
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
  "id_push",
  "platform_user_id",
];

function smsParts(length: number) {
  if (!length) return 0;
  return length <= 160 ? 1 : Math.ceil(length / 153);
}

type AudienceOption = { id: string; name: string; criteria: SmsAudienceCriteria; system?: boolean };

type SavedAudience = {
  id: string;
  name: string;
  criteria: SmsAudienceCriteria;
};

type CampaignAudienceDraft = {
  source: "players";
  label: string;
  recipients: Array<{ phone: string; playerId?: string }>;
  missingPhone: number;
  createdAt: string;
};

export function NewSmsCampaignDialog({
  open,
  onOpenChange,
  onCreated,
  initialAudienceId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  initialAudienceId?: string;
}) {
  const resolveAudience = useServerFn(resolveSmsCampaignAudience);
  const send = useServerFn(sendBulkSms);
  const schedule = useServerFn(scheduleBulkSms);
  const listAudiences = useServerFn(listSmsAudiences);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [phones, setPhones] = useState<string[]>([]);
  const [audienceTotal, setAudienceTotal] = useState(0);
  const [draftAudience, setDraftAudience] = useState<CampaignAudienceDraft | null>(null);
  const [when, setWhen] = useState<"now" | "schedule">("now");
  const [scheduledAt, setScheduledAt] = useState("");

  const saved = useQuery({
    queryKey: ["sms-audiences"],
    queryFn: () => listAudiences(),
    enabled: open,
  });
  const options: AudienceOption[] = open
    ? [
        ...SYSTEM_SMS_AUDIENCES.map((item) => ({ ...item, system: true })),
        ...((saved.data ?? []) as SavedAudience[]).map((item) => ({
          id: item.id,
          name: item.name,
          criteria: item.criteria as SmsAudienceCriteria,
        })),
      ]
    : [];
  const audience = useMutation({
    mutationFn: (criteria: SmsAudienceCriteria) => resolveAudience({ data: { criteria } }),
    onSuccess: (result) => {
      setPhones(result.phones);
      setAudienceTotal(result.total);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  useEffect(() => {
    if (!open) return;
    setSelectedId("");
    setPhones([]);
    setAudienceTotal(0);
    setDraftAudience(null);

    const serialized = window.localStorage.getItem("betleads:campaignAudienceDraft");
    if (!serialized) return;

    try {
      const draft = JSON.parse(serialized) as CampaignAudienceDraft;
      const createdAt = new Date(draft.createdAt).getTime();
      const isFresh = Number.isFinite(createdAt) && Date.now() - createdAt < 30 * 60 * 1000;
      if (draft.source !== "players" || !isFresh || !Array.isArray(draft.recipients)) return;

      const recipientPhones = [
        ...new Set(draft.recipients.map((item) => item.phone.trim()).filter(Boolean)),
      ];
      if (!recipientPhones.length) return;

      setDraftAudience({
        ...draft,
        recipients: draft.recipients.filter((item) => item.phone.trim()),
      });
      setSelectedId("draft:players");
      setPhones(recipientPhones);
      setAudienceTotal(recipientPhones.length + Math.max(0, draft.missingPhone ?? 0));
      setName((current) => current || draft.label);
    } catch {
      // Ignora uma selecao temporaria invalida e segue com o modal normal.
    } finally {
      window.localStorage.removeItem("betleads:campaignAudienceDraft");
    }
  }, [open]);
  useEffect(() => {
    if (!open || !initialAudienceId || !options.length) return;
    const selected = options.find((item) => item.id === initialAudienceId);
    if (!selected) return;
    setSelectedId(selected.id);
    audience.mutate(selected.criteria);
  }, [open, initialAudienceId, options.length]);

  const submit = useMutation({
    mutationFn: async () => {
      if (!name.trim() || !message.trim() || !phones.length)
        throw new Error("Preencha a campanha e monte o público");
      if (when === "schedule") {
        if (!scheduledAt) throw new Error("Escolha a data do disparo");
        return schedule({
          data: {
            phones,
            content: message,
            campaignName: name,
            route: "iGaming",
            scheduledAt: new Date(scheduledAt).toISOString(),
            ratePerMinute: 1000,
          },
        });
      }
      return send({
        data: {
          phones,
          content: message,
          campaignName: name,
          route: "iGaming",
          ratePerMinute: 1000,
        },
      });
    },
    onSuccess: () => {
      toast.success(when === "schedule" ? "Campanha agendada" : "Campanha enviada para a fila");
      onCreated();
      onOpenChange(false);
      setPhones([]);
      setAudienceTotal(0);
      setName("");
      setMessage("");
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const parts = smsParts(message.length);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Nova campanha</DialogTitle>
          <DialogDescription>
            Escolha um público, escreva a mensagem e programe o disparo.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Nome da campanha</Label>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Ex: Cashback dobrado — sábado"
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Público</Label>
              <Button variant="link" size="sm" asChild>
                <Link to="/publicos" onClick={() => onOpenChange(false)}>
                  Criar novo público
                </Link>
              </Button>
            </div>
            <Select
              value={selectedId}
              onValueChange={(value) => {
                setSelectedId(value);
                if (value === "draft:players" && draftAudience) {
                  const recipientPhones = [
                    ...new Set(
                      draftAudience.recipients.map((item) => item.phone.trim()).filter(Boolean),
                    ),
                  ];
                  setPhones(recipientPhones);
                  setAudienceTotal(
                    recipientPhones.length + Math.max(0, draftAudience.missingPhone ?? 0),
                  );
                  return;
                }
                const selected = options.find((item) => item.id === value);
                if (selected) audience.mutate(selected.criteria);
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Escolha um público" />
              </SelectTrigger>
              <SelectContent>
                {draftAudience && (
                  <SelectItem value="draft:players">
                    Seleção de jogadores · {draftAudience.label}
                  </SelectItem>
                )}
                {options.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.system ? `Nível · ${item.name}` : item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="rounded-lg bg-primary/10 px-3 py-2 text-sm text-primary">
              <div>
                <strong>{audience.isPending ? "…" : num(audienceTotal)}</strong> jogadores
                correspondem a este público
              </div>
              {!audience.isPending && (
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {num(phones.length)} têm telefone válido e receberão a campanha
                </div>
              )}
            </div>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>Mensagem</Label>
              <MessageVariablePicker
                allowedKeys={SMS_VARIABLE_KEYS}
                onInsert={(value) => setMessage((current) => `${current}${value}`)}
              />
            </div>
            <Textarea
              rows={5}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Oi {nome}, seu bônus está liberado."
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>
                {message.length} caracteres · {parts} parte{parts === 1 ? "" : "s"}
              </span>
              <strong>{num(phones.length * parts)} créditos</strong>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Quando disparar</Label>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant={when === "now" ? "default" : "outline"}
                onClick={() => setWhen("now")}
              >
                Disparar agora
              </Button>
              <Button
                size="sm"
                variant={when === "schedule" ? "default" : "outline"}
                onClick={() => setWhen("schedule")}
              >
                Agendar
              </Button>
            </div>
            {when === "schedule" && (
              <Input
                type="datetime-local"
                value={scheduledAt}
                onChange={(event) => setScheduledAt(event.target.value)}
              />
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            disabled={submit.isPending || !phones.length || !message.trim() || !name.trim()}
            onClick={() => submit.mutate()}
          >
            {submit.isPending
              ? "Salvando…"
              : when === "schedule"
                ? "Agendar disparo"
                : "Disparar agora"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
