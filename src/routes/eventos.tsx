import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { POLL_INTERVALS, UpdatedAgo } from "@/hooks/use-updated-ago";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { brl, timeAgo } from "@/lib/format";
import { describeEventType, type EventTypeDisplay } from "@/lib/webhook-events";
import {
  LogIn,
  LogOut,
  ArrowDownToLine,
  ArrowUpFromLine,
  Dice5,
  UserPlus,
  Gamepad2,
  Activity,
  Gift,
} from "lucide-react";
import { Page, PageHeader } from "@/components/ui-premium/page-header";

export const Route = createFileRoute("/eventos")({
  component: EventosPage,
});

type EventStyle = { icon: React.ElementType; color: string };

const NEUTRAL_STYLE: EventStyle = {
  icon: Activity,
  color: "text-zinc-400 bg-zinc-500/15 border-zinc-500/30",
};
const FAILED_COLOR = "text-danger bg-danger/15 border-danger/30";

const SLUG_STYLES: Record<string, EventStyle> = {
  login: { icon: LogIn, color: "text-sky-400 bg-sky-500/15 border-sky-500/30" },
  logout: { icon: LogOut, color: "text-zinc-400 bg-zinc-500/15 border-zinc-500/30" },
  cadastro: { icon: UserPlus, color: "text-primary bg-primary/15 border-primary/30" },
  aposta: { icon: Dice5, color: "text-violet-400 bg-violet-500/15 border-violet-500/30" },
  bet: { icon: Dice5, color: "text-violet-400 bg-violet-500/15 border-violet-500/30" },
};

const CATEGORY_STYLES: Record<NonNullable<EventTypeDisplay["categoria"]>, EventStyle> = {
  Usuário: { icon: UserPlus, color: "text-primary bg-primary/15 border-primary/30" },
  Depósito: {
    icon: ArrowDownToLine,
    color: "text-emerald-400 bg-emerald-500/15 border-emerald-500/30",
  },
  Saque: { icon: ArrowUpFromLine, color: "text-amber-400 bg-amber-500/15 border-amber-500/30" },
  Jogo: { icon: Gamepad2, color: "text-fuchsia-400 bg-fuchsia-500/15 border-fuchsia-500/30" },
  Bônus: { icon: Gift, color: "text-rose-400 bg-rose-500/15 border-rose-500/30" },
};

/** Label from WEBHOOK_EVENTS (single source); unknown types show as a neutral "Evento". */
function eventConfig(tipo: string | null | undefined) {
  const display = describeEventType(tipo);
  const style =
    SLUG_STYLES[(tipo ?? "").trim().toLowerCase()] ??
    (display.categoria ? CATEGORY_STYLES[display.categoria] : NEUTRAL_STYLE);
  return {
    icon: style.icon,
    color: display.failed ? FAILED_COLOR : style.color,
    label: display.label,
  };
}

function EventosPage() {
  const { data, isLoading, dataUpdatedAt } = useQuery({
    queryKey: ["events"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("events")
        .select("id, tipo, valor, metadata, created_at, players(nome, player_external_id)")
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

  return (
    <Page>
      <PageHeader subtitle="Atividade recente dos players — logins, depósitos, jogos e mais" />
      <Card className="border-border/50 bg-card/60 backdrop-blur">
        <CardContent className="p-0">
          <div className="flex items-center justify-between border-b border-border/60 px-5 py-3">
            <div className="flex items-center gap-2 text-sm">
              <span className="h-2 w-2 rounded-full bg-success animate-pulse" />
              Atualização automática a cada 15 s
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <UpdatedAgo ts={dataUpdatedAt} />
              <span>{data?.length ?? 0} eventos recentes</span>
            </div>
          </div>
          <div className="max-h-[calc(100vh-220px)] overflow-y-auto divide-y divide-border/40">
            {isLoading &&
              Array.from({ length: 10 }).map((_, i) => (
                <div key={i} className="px-5 py-3">
                  <Skeleton className="h-10 w-full" />
                </div>
              ))}
            {(data ?? []).map((e: any) => {
              const cfg = eventConfig(e.tipo);
              const Icon = cfg.icon;
              return (
                <div
                  key={e.id}
                  className="flex items-center gap-4 px-5 py-3 hover:bg-muted/30 transition-colors"
                >
                  <div
                    className={`flex h-9 w-9 items-center justify-center rounded-lg border ${cfg.color}`}
                  >
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-medium truncate">
                        {e.players?.nome ?? "Player desconhecido"}
                      </span>
                      <Badge
                        variant="outline"
                        className={`text-meta py-0 ${cfg.color}`}
                        title={e.tipo ?? undefined}
                      >
                        {cfg.label}
                      </Badge>
                      {e.metadata?.jogo && (
                        <span className="text-xs text-muted-foreground">· {e.metadata.jogo}</span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {e.players?.player_external_id ?? ""} · {timeAgo(e.created_at)}
                    </div>
                  </div>
                  {e.valor != null && (
                    <div className="text-sm font-semibold tabular-nums">{brl(Number(e.valor))}</div>
                  )}
                </div>
              );
            })}
            {!isLoading && (data ?? []).length === 0 && (
              <div className="p-10 text-center text-sm text-muted-foreground">
                Nenhum evento registrado ainda. Conecte um webhook para começar.
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </Page>
  );
}
