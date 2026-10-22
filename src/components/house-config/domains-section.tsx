// "Encurtador" / "E-mail" domains tab: lists the house's domains of one
// `kind`, lets an admin add a new one, and wires each row's actions
// (verify now, send DNS instructions, set default, remove with a usages
// confirmation) to the server functions from Task 5. `DomainDetail` stays
// presentational; all the mutations and dialogs live here.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ChevronDown, ChevronRight, Globe, Mail, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { DataCard } from "@/components/ui-premium";
import { DemoDisabledTooltip } from "@/components/demo-disabled-tooltip";
import { useIsDemoTenant } from "@/hooks/use-is-demo-tenant";
import {
  addHouseDomain,
  computeShortenerPending,
  getHouseConfig,
  getHouseDomainUsages,
  purgeHouseDomain,
  refreshHouseDomain,
  removeHouseDomain,
  sendDnsInstructions,
  setDefaultHouseDomain,
} from "@/lib/house-config.functions";
import type { DnsRecord, DomainKind } from "@/lib/house-config";
import {
  HOUSE_CONFIG_QUERY_KEY,
  invalidateHouseConfigQueries,
} from "@/components/house-config/house-config-query";
import { DomainDetail } from "@/components/house-config/domain-detail";

const KIND_LABEL: Record<DomainKind, { title: string; placeholder: string; icon: typeof Globe }> = {
  shortener: { title: "Encurtador", placeholder: "go.suacasa.bet.br", icon: Globe },
  email: { title: "Domínios de e-mail", placeholder: "mail.suacasa.bet.br", icon: Mail },
};

export function DomainsSection({
  kind,
  variant = "page",
}: {
  kind: DomainKind;
  variant?: "page" | "wizard";
}) {
  const isDemo = useIsDemoTenant();
  const qc = useQueryClient();
  const getConfig = useServerFn(getHouseConfig);
  const addFn = useServerFn(addHouseDomain);
  const refreshFn = useServerFn(refreshHouseDomain);
  const setDefaultFn = useServerFn(setDefaultHouseDomain);
  const removeFn = useServerFn(removeHouseDomain);
  const sendInstructionsFn = useServerFn(sendDnsInstructions);
  const usagesFn = useServerFn(getHouseDomainUsages);
  const purgeFn = useServerFn(purgeHouseDomain);

  const query = useQuery({ queryKey: HOUSE_CONFIG_QUERY_KEY, queryFn: () => getConfig() });
  const config = query.data;
  const canEdit = config?.canEdit ?? false;
  const domains = (config?.domains ?? []).filter((d) => d.kind === kind);
  // Only populated by the server when the caller is a super admin — everyone
  // else always sees an empty array (see `selectRemovedDomainsForSuperAdmin`).
  const removedDomains = (config?.removedDomains ?? []).filter((d) => d.kind === kind);

  const [newHostname, setNewHostname] = useState("");
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [removeDialogDomainId, setRemoveDialogDomainId] = useState<string | null>(null);
  const [instructionsDialogDomainId, setInstructionsDialogDomainId] = useState<string | null>(null);
  const [instructionsEmail, setInstructionsEmail] = useState("");
  const [removedListOpen, setRemovedListOpen] = useState(false);
  const [purgeDialogDomainId, setPurgeDialogDomainId] = useState<string | null>(null);

  // Config, composer pickers and setup status (wizard summary / checklist).
  const refresh = () => invalidateHouseConfigQueries(qc);

  const addDomain = useMutation({
    mutationFn: () => addFn({ data: { kind, hostname: newHostname } }),
    onSuccess: () => {
      toast.success("Domínio adicionado");
      setNewHostname("");
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const verifyNow = useMutation({
    mutationFn: (domainId: string) => {
      setVerifyingId(domainId);
      return refreshFn({ data: { domainId } });
    },
    onSuccess: () => refresh(),
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => setVerifyingId(null),
  });

  const setDefault = useMutation({
    mutationFn: (domainId: string) => setDefaultFn({ data: { domainId } }),
    onSuccess: () => {
      toast.success("Domínio padrão atualizado");
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const remove = useMutation({
    mutationFn: (domainId: string) => removeFn({ data: { domainId } }),
    onSuccess: () => {
      toast.success("Domínio removido");
      setRemoveDialogDomainId(null);
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const sendInstructions = useMutation({
    mutationFn: (vars: { domainId: string; to: string }) => sendInstructionsFn({ data: vars }),
    onSuccess: () => {
      toast.success("Instruções enviadas por e-mail");
      setInstructionsDialogDomainId(null);
      setInstructionsEmail("");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const purge = useMutation({
    mutationFn: (domainId: string) => purgeFn({ data: { domainId } }),
    onSuccess: () => {
      toast.success("Domínio apagado no provedor");
      setPurgeDialogDomainId(null);
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const usagesQuery = useQuery({
    queryKey: ["house-domain-usages", removeDialogDomainId],
    queryFn: () => usagesFn({ data: { domainId: removeDialogDomainId! } }),
    enabled: !!removeDialogDomainId,
  });

  function copyRecord(record: DnsRecord) {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      toast.error("Não foi possível copiar");
      return;
    }
    navigator.clipboard.writeText(record.value).then(
      () => toast.success("Valor copiado"),
      () => toast.error("Não foi possível copiar"),
    );
  }

  const meta = KIND_LABEL[kind];
  const shortenerPending = kind === "shortener" && computeShortenerPending(domains.map((d) => d.status));

  const content = (
    <div className="space-y-4">
      {shortenerPending && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          Seu domínio personalizado ainda não foi verificado — os links estão saindo pelo encurtador
          padrão do CRM.
        </p>
      )}

      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={newHostname}
            onChange={(e) => setNewHostname(e.target.value)}
            placeholder={meta.placeholder}
            className="max-w-xs"
          />
          <DemoDisabledTooltip active={isDemo}>
            <Button
              type="button"
              size="sm"
              disabled={isDemo || !newHostname.trim() || addDomain.isPending}
              onClick={() => addDomain.mutate()}
            >
              <Plus className="h-4 w-4" /> {addDomain.isPending ? "Adicionando…" : "Adicionar domínio"}
            </Button>
          </DemoDisabledTooltip>
        </div>
      )}

      <div className="space-y-3">
        {domains.map((d) => (
          <DomainDetail
            key={d.id}
            domain={d}
            canEdit={canEdit}
            verifying={verifyingId === d.id}
            isDemo={isDemo}
            onCopyRecord={copyRecord}
            onVerifyNow={() => verifyNow.mutate(d.id)}
            onSendInstructions={() => setInstructionsDialogDomainId(d.id)}
            onSetDefault={() => setDefault.mutate(d.id)}
            onRemove={() => setRemoveDialogDomainId(d.id)}
          />
        ))}
        {domains.length === 0 && (
          <p className="text-sm text-muted-foreground">Nenhum domínio cadastrado ainda.</p>
        )}
      </div>

      {variant === "page" && removedDomains.length > 0 && (
        <div className="space-y-2 rounded-lg border border-border/40 bg-background/20 p-3">
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setRemovedListOpen((open) => !open)}
          >
            {removedListOpen ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            Domínios removidos ({removedDomains.length})
          </button>
          {removedListOpen && (
            <div className="space-y-2">
              {removedDomains.map((d) => (
                <div
                  key={d.id}
                  className="flex flex-wrap items-center justify-between gap-2 text-sm"
                >
                  <span className="font-mono truncate text-muted-foreground">{d.hostname}</span>
                  <DemoDisabledTooltip active={isDemo}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      disabled={isDemo}
                      onClick={() => setPurgeDialogDomainId(d.id)}
                    >
                      Apagar no provedor
                    </Button>
                  </DemoDisabledTooltip>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <AlertDialog
        open={!!purgeDialogDomainId}
        onOpenChange={(open) => !open && setPurgeDialogDomainId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apagar domínio no provedor</AlertDialogTitle>
            <AlertDialogDescription>
              Essa ação é irreversível: o domínio é apagado na conta do provedor (Short.io ou
              Infobip) e links e histórico que ainda dependem dele deixam de funcionar.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={purge.isPending}
              onClick={() => purgeDialogDomainId && purge.mutate(purgeDialogDomainId)}
            >
              Apagar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!removeDialogDomainId}
        onOpenChange={(open) => !open && setRemoveDialogDomainId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover domínio</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  O domínio sai dos novos envios, mas continua existindo no provedor — campanhas e
                  jornadas já agendadas passam a usar o padrão da casa.
                </p>
                {usagesQuery.data &&
                  (usagesQuery.data.campaigns.length > 0 || usagesQuery.data.journeys.length > 0) && (
                    <p>
                      Em uso em:{" "}
                      {[...usagesQuery.data.campaigns, ...usagesQuery.data.journeys]
                        .map((u) => u.name)
                        .join(", ")}
                    </p>
                  )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={remove.isPending}
              onClick={() => removeDialogDomainId && remove.mutate(removeDialogDomainId)}
            >
              Remover
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={!!instructionsDialogDomainId}
        onOpenChange={(open) => !open && setInstructionsDialogDomainId(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enviar instruções por e-mail</DialogTitle>
            <DialogDescription>
              Enviamos os registros DNS deste domínio para quem cuida do DNS da casa.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>E-mail de destino</Label>
            <Input
              type="email"
              value={instructionsEmail}
              onChange={(e) => setInstructionsEmail(e.target.value)}
              placeholder="dns@suacasa.bet.br"
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              disabled={!instructionsEmail.trim() || sendInstructions.isPending}
              onClick={() =>
                instructionsDialogDomainId &&
                sendInstructions.mutate({ domainId: instructionsDialogDomainId, to: instructionsEmail })
              }
            >
              {sendInstructions.isPending ? "Enviando…" : "Enviar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );

  if (variant === "wizard") return content;

  return (
    <DataCard title={meta.title} icon={<meta.icon className="h-4 w-4" />}>
      {content}
    </DataCard>
  );
}
