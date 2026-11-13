import { Link, createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { POLL_INTERVALS, UpdatedAgo } from "@/hooks/use-updated-ago";
import { useActiveTenant } from "@/hooks/use-active-tenant";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { timeAgo } from "@/lib/format";
import { useMoney } from "@/hooks/use-tenant-currency";
import {
  describeEventType,
  eventTransactionRef,
  shortTransactionRef,
  type EventTypeDisplay,
} from "@/lib/webhook-events";
import { IdentityIcon } from "@/components/identity/identity-badge";
import { EVENT_IDENTITY, type EventKind } from "@/components/identity/identity";
import { Activity } from "lucide-react";
import { DataCard } from "@/components/ui-premium/data-card";
import { EmptyState } from "@/components/ui-premium/empty-state";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { tourAnchor } from "@/help/anchor";

export const Route = createFileRoute("/eventos")({
  component: EventosPage,
});

// Identity colours: one colour + icon per event kind, the same as the ficha's
// timeline and the audience filter groups (deposit green, withdrawal blue…).
const SLUG_KIND: Record<string, EventKind> = {
  login: "login",
  logout: "logout",
  cadastro: "signup",
  aposta: "bet",
  bet: "bet",
};

const CATEGORY_KIND: Record<NonNullable<EventTypeDisplay["categoria"]>, EventKind> = {
  Usuário: "signup",
  Depósito: "deposit",
  Saque: "withdrawal",
  Jogo: "bet",
  Bônus: "bonus",
};

// No feed, "Depósito Pendente" é só um PIX gerado: o jogador pode gerar
// vários e pagar um. O nome do endpoint (WEBHOOK_EVENTS) fica igual.
const FEED_LABEL: Record<string, string> = {
  "deposito-pendente": "PIX gerado",
};

/** Label from WEBHOOK_EVENTS (single source); unknown types show as a neutral "Evento". */
function eventConfig(tipo: string | null | undefined) {
  const slug = (tipo ?? "").trim().toLowerCase();
  const display = describeEventType(tipo);
  const kind: EventKind = display.failed
    ? "failed"
    : (SLUG_KIND[slug] ?? (display.categoria ? CATEGORY_KIND[display.categoria] : "other"));
  return {
    tone: EVENT_IDENTITY[kind],
    label: FEED_LABEL[slug] ?? display.label,
    categoria: display.categoria,
  };
}

/** Número do PIX/saque na casa, para diferenciar transações iguais em sequência. */
function transactionText(categoria: EventTypeDisplay["categoria"], metadata: unknown) {
  if (categoria !== "Depósito" && categoria !== "Saque") return null;
  const ref = eventTransactionRef(metadata);
  if (!ref) return null;
  return `${categoria === "Depósito" ? "PIX" : "Saque"} ${shortTransactionRef(ref)}`;
}

/** Hora do evento em Brasília; com a data quando não é de hoje. */
function clockTime(iso: string) {
  const at = new Date(iso);
  const day = (d: Date) => d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const time = at.toLocaleTimeString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
  });
  if (day(at) === day(new Date())) return time;
  const date = at.toLocaleDateString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
  });
  return `${date} ${time}`;
}

function EventosPage() {
  // The feed belongs to the house chosen in the header, even for people who see several.
  const { active } = useActiveTenant();
  const tenantId = active?.id ?? null;
  const { money } = useMoney();
  const { data, isLoading, isError, refetch, dataUpdatedAt } = useQuery({
    queryKey: ["events", tenantId],
    enabled: Boolean(tenantId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("events")
        .select("id, tipo, valor, metadata, created_at, players(nome, player_external_id)")
        .eq("tenant_id", tenantId!)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data ?? [];
    },
    // REP-05: `events` saiu da publicação Realtime (escrita alta). O feed
    // passa a buscar os 100 mais recentes a cada 15 s com a aba visível.
    staleTime: 10_000,
    refetchInterval: POLL_INTERVALS.liveList,
    refetchOnWindowFocus: true,
  });
  const events = data ?? [];
  // 100 rows make a very long page on a phone: show 30, the rest on demand.
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? events : events.slice(0, 30);
  const loading = isLoading || !tenantId;

  return (
    <Page className="max-w-5xl">
      <PageHeader subtitle="O que os jogadores fizeram por último: cadastros, logins, depósitos, saques e jogos." />
      <DataCard
        title="Últimos 100 eventos"
        description={
          <>
            Atualiza sozinho a cada 15 s · <UpdatedAgo ts={dataUpdatedAt} />
          </>
        }
        bodyClassName="p-0 sm:p-0"
      >
        {loading ? (
          <div className="space-y-2 p-4 sm:p-5" aria-busy="true" aria-label="Carregando eventos">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        ) : isError ? (
          <EmptyState
            title="Não foi possível carregar os eventos"
            description="Tente novamente em instantes."
            action={
              <Button size="sm" variant="outline" onClick={() => void refetch()}>
                Tentar novamente
              </Button>
            }
          />
        ) : events.length === 0 ? (
          <EmptyState
            icon={<Activity />}
            title="Nenhum evento recebido ainda"
            description="Os eventos chegam quando a plataforma de apostas está conectada."
            action={
              <Button size="sm" variant="outline" asChild>
                <Link to="/webhooks">Abrir Integrações</Link>
              </Button>
            }
          />
        ) : (
          <>
            <ul className="divide-y divide-border" {...tourAnchor("eventos.lista")}>
              {visible.map((e: any) => {
                const cfg = eventConfig(e.tipo);
                const transaction = transactionText(cfg.categoria, e.metadata);
                return (
                  <li key={e.id} className="flex items-center gap-3 px-4 py-3 sm:gap-4 sm:px-5">
                    <IdentityIcon tone={cfg.tone} />
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-baseline gap-x-2 text-body">
                        <span className="truncate font-medium">
                          {e.players?.nome ?? "Jogador sem cadastro"}
                        </span>
                        <span className={cfg.tone.text}>{cfg.label}</span>
                        {e.metadata?.jogo && (
                          <span className="truncate text-meta text-muted-foreground">
                            · {e.metadata.jogo}
                          </span>
                        )}
                      </p>
                      <p className="text-meta text-muted-foreground">
                        {[
                          transaction,
                          e.players?.player_external_id
                            ? `ID ${e.players.player_external_id}`
                            : null,
                          `${clockTime(e.created_at)} · ${timeAgo(e.created_at)}`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </div>
                    {e.valor != null && (
                      <p className="shrink-0 text-body font-semibold tabular-nums">
                        {money(Number(e.valor))}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
            {events.length > visible.length && (
              <div className="border-t border-border p-3 text-center">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowAll(true)}
                  {...tourAnchor("eventos.mostrar-mais")}
                >
                  Mostrar mais {events.length - visible.length}
                </Button>
              </div>
            )}
          </>
        )}
      </DataCard>
    </Page>
  );
}
