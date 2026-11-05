// "E-mail" tab's senders list: pick one of the house's e-mail domains, give
// the sender a local part / from name / optional reply-to, and mark it as
// default. Flags senders sitting on a domain that isn't verified yet (the
// domain section above is what actually verifies them).
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Send } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DataCard } from "@/components/ui-premium";
import { Badge } from "@/components/ui/badge";
import { DemoDisabledTooltip } from "@/components/demo-disabled-tooltip";
import { useIsDemoTenant } from "@/hooks/use-is-demo-tenant";
import { requestConfirmation } from "@/components/system-dialog-host";
import {
  getHouseConfig,
  removeEmailSenderForHouse,
  saveEmailSenderForHouse,
} from "@/lib/house-config.functions";
import {
  HOUSE_CONFIG_QUERY_KEY,
  invalidateHouseConfigQueries,
} from "@/components/house-config/house-config-query";

/** Shape the "Remover" confirmation needs from a sender row. */
export type RemovableSender = { id: string; fromName: string; fromEmail: string };

/** Pure so the exact copy (title/description/label) is testable without
 * rendering: the "Remover" button never calls the mutation directly. */
export function buildRemoveSenderConfirmOptions(sender: RemovableSender) {
  return {
    title: "Remover remetente?",
    description: `O remetente ${sender.fromName} <${sender.fromEmail}> deixa de poder ser usado em novas campanhas e jornadas de e-mail.`,
    confirmLabel: "Remover remetente",
    destructive: true,
  } as const;
}

/** Confirms before removing (never calls `remove` without an explicit yes).
 * `confirm` is injected so this is testable without the real dialog host. */
export async function confirmAndRemoveSender(
  sender: RemovableSender,
  deps: {
    confirm: (options: ReturnType<typeof buildRemoveSenderConfirmOptions>) => Promise<boolean>;
    remove: (id: string) => void;
  },
): Promise<void> {
  const confirmed = await deps.confirm(buildRemoveSenderConfirmOptions(sender));
  if (confirmed) deps.remove(sender.id);
}

export function EmailSendersSection({ variant = "page" }: { variant?: "page" | "wizard" }) {
  const isDemo = useIsDemoTenant();
  const qc = useQueryClient();
  const getConfig = useServerFn(getHouseConfig);
  const saveFn = useServerFn(saveEmailSenderForHouse);
  const removeFn = useServerFn(removeEmailSenderForHouse);

  const query = useQuery({ queryKey: HOUSE_CONFIG_QUERY_KEY, queryFn: () => getConfig() });
  const config = query.data;
  const canEdit = config?.canEdit ?? false;
  const emailDomains = (config?.domains ?? []).filter((d) => d.kind === "email");
  const senders = config?.senders ?? [];
  const hasVerifiedEmailDomain = emailDomains.some((d) => d.status === "verified");

  const [domainId, setDomainId] = useState<string>("");
  const [localPart, setLocalPart] = useState("");
  const [fromName, setFromName] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [isDefault, setIsDefault] = useState(false);

  const formRef = useRef<HTMLDivElement>(null);
  const localPartInputRef = useRef<HTMLInputElement>(null);

  // Scrolls to the sender form and focuses "Endereço", for the "Agora crie
  // um remetente" hint shown once the domain is verified and there's no
  // sender yet.
  function focusSenderForm() {
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    localPartInputRef.current?.focus();
  }

  // Config, composer pickers and setup status (wizard summary / checklist).
  const refresh = () => invalidateHouseConfigQueries(qc);

  const save = useMutation({
    mutationFn: () =>
      saveFn({
        data: {
          domainId,
          localPart,
          fromName,
          replyTo: replyTo.trim() || undefined,
          isDefault,
        },
      }),
    onSuccess: () => {
      toast.success("Remetente salvo");
      setLocalPart("");
      setFromName("");
      setReplyTo("");
      setIsDefault(false);
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => removeFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Remetente removido");
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const selectedDomain = emailDomains.find((d) => d.id === domainId);

  const content = (
    <div className="space-y-6">
      <div className="space-y-2">
        {senders.length === 0 && (
          <p className="text-sm text-muted-foreground">Nenhum remetente cadastrado ainda.</p>
        )}
        {canEdit && hasVerifiedEmailDomain && senders.length === 0 && (
          <button
            type="button"
            onClick={focusSenderForm}
            className="w-full rounded-lg border border-dashed border-primary/40 bg-primary/5 p-3 text-left text-sm text-foreground transition-colors hover:bg-primary/10"
          >
            Domínio verificado. Agora crie um remetente para enviar campanhas e jornadas por
            e-mail.
          </button>
        )}
        {senders.map((s) => (
          <div
            key={s.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/40 bg-background/30 p-3"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">
                {s.fromName} &lt;{s.fromEmail}&gt;
              </p>
              {!s.domainVerified && (
                <p className="text-xs text-amber-300">Domínio ainda não verificado</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              {s.isDefault && <Badge variant="outline">Padrão</Badge>}
              {canEdit && (
                <DemoDisabledTooltip active={isDemo}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    disabled={isDemo}
                    onClick={() =>
                      void confirmAndRemoveSender(s, {
                        confirm: requestConfirmation,
                        remove: remove.mutate,
                      })
                    }
                  >
                    Remover
                  </Button>
                </DemoDisabledTooltip>
              )}
            </div>
          </div>
        ))}
      </div>

      {canEdit && (
        <div ref={formRef} className="space-y-3 rounded-lg border border-border/40 bg-background/30 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>Domínio de e-mail</Label>
              <Select value={domainId} onValueChange={setDomainId}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecione um domínio" />
                </SelectTrigger>
                <SelectContent>
                  {emailDomains.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.hostname}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Endereço</Label>
              <div className="flex items-center gap-1">
                <Input
                  ref={localPartInputRef}
                  value={localPart}
                  onChange={(e) => setLocalPart(e.target.value)}
                  placeholder="promo"
                  className="max-w-[140px]"
                />
                <span className="text-sm text-muted-foreground">
                  @{selectedDomain?.hostname ?? "..."}
                </span>
              </div>
            </div>
            <div>
              <Label>Nome do remetente</Label>
              <Input
                value={fromName}
                onChange={(e) => setFromName(e.target.value)}
                placeholder="Promo SuaCasa"
              />
            </div>
            <div>
              <Label>Responder para (opcional)</Label>
              <Input
                type="email"
                value={replyTo}
                onChange={(e) => setReplyTo(e.target.value)}
                placeholder="atendimento@suacasa.bet.br"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={isDefault} onCheckedChange={setIsDefault} />
            <Label>Remetente padrão</Label>
          </div>
          <DemoDisabledTooltip active={isDemo}>
            <Button
              type="button"
              size="sm"
              disabled={isDemo || !domainId || !localPart.trim() || !fromName.trim() || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? "Salvando…" : "Salvar remetente"}
            </Button>
          </DemoDisabledTooltip>
        </div>
      )}
    </div>
  );

  if (variant === "wizard") return content;

  return (
    <DataCard
      title="Remetentes de e-mail"
      description="Quem envia as campanhas e jornadas de e-mail da casa."
      icon={<Send className="h-4 w-4" />}
    >
      {content}
    </DataCard>
  );
}
