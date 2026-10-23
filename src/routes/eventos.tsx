import { Link, createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { POLL_INTERVALS, UpdatedAgo } from "@/hooks/use-updated-ago";
import { useActiveTenant } from "@/hooks/use-active-tenant";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { brl, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { describeEventType, type EventTypeDisplay } from "@/lib/webhook-events";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  Dice5,
  Gamepad2,
  Gift,
  LogIn,
  LogOut,
  UserPlus,
} from "lucide-react";
import { DataCard } from "@/components/ui-premium/data-card";
import { EmptyState } from "@/components/ui-premium/empty-state";
import { Page, PageHeader } from "@/components/ui-premium/page-header";

export const Route = createFileRoute("/eventos")({
  component: EventosPage,
});

// Neutral icons; colour only where it means something (money in/out, failure).
type EventStyle = { icon: React.ElementType; tone: string };

const NEUTRAL = "bg-secondary text-muted-foreground";
const NEUTRAL_STYLE: EventStyle = { icon: Activity, tone: NEUTRAL };
const FAILED_TONE = "bg-danger/10 text-danger";

const SLUG_STYLES: Record<string, EventStyle> = {
  login: { icon: LogIn, tone: NEUTRAL },
  logout: { icon: LogOut, tone: NEUTRAL },
  cadastro: { icon: UserPlus, tone: NEUTRAL },
  aposta: { icon: Dice5, tone: NEUTRAL },
  bet: { icon: Dice5, tone: NEUTRAL },
};

const CATEGORY_STYLES: Record<NonNullable<EventTypeDisplay["categoria"]>, EventStyle> = {
  Usuário: { icon: UserPlus, tone: NEUTRAL },
  Depósito: { icon: ArrowDownToLine, tone: "bg-success/10 text-success" },
  Saque: { icon: ArrowUpFromLine, tone: "bg-warning/10 text-warning" },
  Jogo: { icon: Gamepad2, tone: NEUTRAL },
  Bônus: { icon: Gift, tone: NEUTRAL },
};

/** Label from WEBHOOK_EVENTS (single source); unknown types show as a neutral "Evento". */
function eventConfig(tipo: string | null | undefined) {
  const display = describeEventType(tipo);
  const style =
    SLUG_STYLES[(tipo ?? "").trim().toLowerCase()] ??
    (display.categoria ? CATEGORY_STYLES[display.categoria] : NEUTRAL_STYLE);
  return {
    icon: style.icon,
    tone: display.failed ? FAILED_TONE : style.tone,
    label: display.label,
  };
}

function EventosPage() {
  // The feed belongs to the house chosen in the header, even for people who see several.
  const { active } = useActiveTenant();
  const tenantId = active?.id ?? null;
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
          <ul className="divide-y divide-border">
            {events.map((e: any) => {
              const cfg = eventConfig(e.tipo);
              const Icon = cfg.icon;
              return (
                <li key={e.id} className="flex items-center gap-3 px-4 py-3 sm:gap-4 sm:px-5">
                  <div
                    className={cn(
                      "flex size-9 shrink-0 items-center justify-center rounded-lg",
                      cfg.tone,
                    )}
                    aria-hidden="true"
                  >
                    <Icon className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-baseline gap-x-2 text-body">
                      <span className="truncate font-medium">
                        {e.players?.nome ?? "Jogador sem cadastro"}
                      </span>
                      <span className="text-muted-foreground">{cfg.label}</span>
                      {e.metadata?.jogo && (
                        <span className="truncate text-meta text-muted-foreground">
                          · {e.metadata.jogo}
                        </span>
                      )}
                    </p>
                    <p className="text-meta text-muted-foreground">
                      {e.players?.player_external_id ? `ID ${e.players.player_external_id} · ` : ""}
                      {timeAgo(e.created_at)}
                    </p>
                  </div>
                  {e.valor != null && (
                    <p className="shrink-0 text-body font-semibold tabular-nums">
                      {brl(Number(e.valor))}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </DataCard>
    </Page>
  );
}
