import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { brl, timeAgo } from "@/lib/format";
import {
  LogIn,
  LogOut,
  ArrowDownToLine,
  ArrowUpFromLine,
  Dice5,
  UserPlus,
  Gamepad2,
  Activity,
} from "lucide-react";
import { PageHeader } from "@/components/ui-premium";

export const Route = createFileRoute("/eventos")({
  component: EventosPage,
});

const config: Record<
  string,
  { icon: React.ElementType; color: string; label: string }
> = {
  login: { icon: LogIn, color: "text-sky-400 bg-sky-500/15 border-sky-500/30", label: "Login" },
  logout: { icon: LogOut, color: "text-zinc-400 bg-zinc-500/15 border-zinc-500/30", label: "Logout" },
  deposito: {
    icon: ArrowDownToLine,
    color: "text-emerald-400 bg-emerald-500/15 border-emerald-500/30",
    label: "Depósito",
  },
  saque: {
    icon: ArrowUpFromLine,
    color: "text-amber-400 bg-amber-500/15 border-amber-500/30",
    label: "Saque",
  },
  aposta: { icon: Dice5, color: "text-violet-400 bg-violet-500/15 border-violet-500/30", label: "Aposta" },
  cadastro: {
    icon: UserPlus,
    color: "text-primary bg-primary/15 border-primary/30",
    label: "Cadastro",
  },
  jogo: {
    icon: Gamepad2,
    color: "text-fuchsia-400 bg-fuchsia-500/15 border-fuchsia-500/30",
    label: "Jogo",
  },
};

function EventosPage() {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
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
  });

  useEffect(() => {
    const ch = supabase
      .channel("events-feed")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "events" },
        () => qc.invalidateQueries({ queryKey: ["events"] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [qc]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Stream de Eventos"
        subtitle="Atividade dos players em tempo real — logins, depósitos, jogos e mais"
        icon={<Activity className="h-5 w-5 text-primary-foreground" />}
      />
      <Card className="border-border/50 bg-card/60 backdrop-blur">
      <CardContent className="p-0">
        <div className="flex items-center justify-between border-b border-border/60 px-5 py-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px] shadow-emerald-400/70 animate-pulse" />
            Stream em tempo real
          </div>
          <div className="text-xs text-muted-foreground">
            {data?.length ?? 0} eventos recentes
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
            const cfg = config[e.tipo] ?? config.login;
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
                    <Badge variant="outline" className={`text-[10px] py-0 ${cfg.color}`}>
                      {cfg.label}
                    </Badge>
                    {e.metadata?.jogo && (
                      <span className="text-xs text-muted-foreground">
                        · {e.metadata.jogo}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {e.players?.player_external_id ?? ""} · {timeAgo(e.created_at)}
                  </div>
                </div>
                {e.valor != null && (
                  <div className="text-sm font-semibold tabular-nums">
                    {brl(Number(e.valor))}
                  </div>
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
    </div>
  );
}