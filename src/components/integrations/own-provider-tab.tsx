// Conta própria de provedor por casa — Task 13: aba "Canais" de
// Integrações. Só aparece para o admin da casa com pelo menos uma
// concessão (getOwnProviderState recusa quem não é admin; "sem item"
// também esconde a aba — ver `showOwnProviderTab`, usado em webhooks.tsx).
import { useState } from "react";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui-premium/empty-state";
import { tourAnchor } from "@/help/anchor";
import { getOwnProviderState, deactivateOwnProvider } from "@/lib/own-provider.functions";
import {
  OWN_PROVIDER_CHANNEL_LABEL,
  OWN_PROVIDER_LABEL,
  type OwnProviderChannel,
} from "@/lib/own-provider.shared";
import type { OwnProviderChannelState } from "@/lib/own-provider.server";
import { errorMessage, OwnProviderWizard } from "./own-provider-wizard";

export const OWN_PROVIDER_QUERY_KEY = ["own-provider", "channels"] as const;

/** Aba "Canais" só aparece com ao menos 1 canal liberado/pausado para a
 * casa; qualquer recusa do servidor (não é admin da casa) esconde a aba. */
export function showOwnProviderTab(
  data: OwnProviderChannelState[] | undefined,
  isError: boolean,
): boolean {
  if (isError) return false;
  return Boolean(data && data.length > 0);
}

export function useOwnProviderChannels(): UseQueryResult<OwnProviderChannelState[]> {
  const fn = useServerFn(getOwnProviderState);
  return useQuery({
    queryKey: OWN_PROVIDER_QUERY_KEY,
    queryFn: () => fn(),
    retry: false,
  });
}

/** "há 5 minutos" / "há 2 horas" / "há 3 dias" (singular quando = 1). */
function relativeTime(iso: string): string {
  const diffMs = Math.max(0, Date.now() - new Date(iso).getTime());
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec} segundo${sec === 1 ? "" : "s"}`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minuto${min === 1 ? "" : "s"}`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hora${hr === 1 ? "" : "s"}`;
  const day = Math.floor(hr / 24);
  return `${day} dia${day === 1 ? "" : "s"}`;
}

export function lastCallbackLabel(lastCallbackAt: string | null): string {
  if (!lastCallbackAt) {
    return "Nenhum retorno recebido ainda — confira o webhook no painel do provedor";
  }
  return `Último retorno recebido há ${relativeTime(lastCallbackAt)}`;
}

// ---------------------------------------------------------------------------
// Card por canal

export function OwnProviderChannelCard({
  state,
  onOpenWizard,
  onDeactivate,
  deactivating,
}: {
  state: OwnProviderChannelState;
  onOpenWizard: () => void;
  onDeactivate: () => void;
  deactivating: boolean;
}) {
  const channelLabel = OWN_PROVIDER_CHANNEL_LABEL[state.channel];
  const account = state.account;

  if (state.revoked) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {channelLabel}
            <Badge variant="outline">pausado</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {state.pendingDecision
              ? "Conta própria revogada pela BetLeads — aguardando decisão."
              : "Conta própria pausada."}
          </p>
          {state.usingOwnAccount && (
            <Button type="button" variant="outline" onClick={onDeactivate} disabled={deactivating}>
              Voltar para a rota da BetLeads
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  if (!account) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{channelLabel}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">Provedor: Plataforma BetLeads</p>
          <Button type="button" onClick={onOpenWizard} {...tourAnchor("webhooks.canais.usar-minha-conta")}>
            Usar minha conta
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (account.status !== "active") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{channelLabel}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">Provedor: Plataforma BetLeads</p>
          <p className="text-sm text-destructive">
            Esta conta foi desativada pela BetLeads. Fale com o suporte.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (state.usingOwnAccount) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{channelLabel}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm">{OWN_PROVIDER_LABEL[account.provider]}</p>
          <p className="text-sm text-muted-foreground">{lastCallbackLabel(account.lastCallbackAt)}</p>
          <Button
            type="button"
            variant="outline"
            onClick={onDeactivate}
            disabled={deactivating}
            {...tourAnchor("webhooks.canais.voltar-plataforma")}
          >
            Voltar para a rota da BetLeads
          </Button>
        </CardContent>
      </Card>
    );
  }

  // Conta cadastrada e ativa, mas ainda não ligada ao canal.
  return (
    <Card>
      <CardHeader>
        <CardTitle>{channelLabel}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">Provedor: Plataforma BetLeads</p>
        <Button type="button" onClick={onOpenWizard}>
          Usar minha conta
        </Button>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Contêiner da aba

export function OwnProviderTab() {
  const { data, isLoading } = useOwnProviderChannels();
  const qc = useQueryClient();
  const deactivateFn = useServerFn(deactivateOwnProvider);
  const [wizardChannel, setWizardChannel] = useState<OwnProviderChannel | null>(null);

  const deactivate = useMutation({
    mutationFn: (channel: OwnProviderChannel) => deactivateFn({ data: { channel } }),
    onSuccess: () => {
      toast.success("Canal voltou para a rota da BetLeads");
      void qc.invalidateQueries({ queryKey: OWN_PROVIDER_QUERY_KEY });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const states = data ?? [];
  const wizardState = states.find((s) => s.channel === wizardChannel) ?? null;

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Carregando…</p>;
  }

  if (states.length === 0) {
    return (
      <EmptyState
        title="Conta própria não liberada"
        description="Fale com a BetLeads para liberar a conta própria de um canal."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        {states.map((state) => (
          <OwnProviderChannelCard
            key={state.channel}
            state={state}
            onOpenWizard={() => setWizardChannel(state.channel)}
            onDeactivate={() => deactivate.mutate(state.channel)}
            deactivating={deactivate.isPending}
          />
        ))}
      </div>
      {wizardState && (
        <Dialog open onOpenChange={(open) => !open && setWizardChannel(null)}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Usar minha conta — {OWN_PROVIDER_CHANNEL_LABEL[wizardState.channel]}</DialogTitle>
            </DialogHeader>
            <OwnProviderWizard
              state={wizardState}
              onDone={() => {
                setWizardChannel(null);
                void qc.invalidateQueries({ queryKey: OWN_PROVIDER_QUERY_KEY });
              }}
            />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
