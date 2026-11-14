// U3 de ESCOPO_ORIGEM_UTM_2026-11-14: os jogadores por trás de uma linha da aba Origem.
import { Link } from "@tanstack/react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Download, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useMoney } from "@/hooks/use-tenant-currency";
import { channelLabel, originPlayersCsv, type OriginFilters } from "@/lib/origin-breakdown";
import { getOriginPlayers } from "@/lib/origin.functions";

const PAGE = 50;
const CSV_MAX = 2000;
const BOM = String.fromCharCode(0xfeff);

export type PlayersTarget = { title: string; filters: OriginFilters } | null;

export function OriginPlayersSheet({
  target,
  range,
  onClose,
}: {
  target: PlayersTarget;
  range: { from: string; to: string };
  onClose: () => void;
}) {
  const fetchPlayers = useServerFn(getOriginPlayers);
  const { money, currency } = useMoney();
  const [exporting, setExporting] = useState(false);
  const filters = target?.filters ?? {};

  const query = useInfiniteQuery({
    queryKey: ["origin-players", range.from, range.to, JSON.stringify(filters)],
    enabled: target != null,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      fetchPlayers({
        data: {
          from: range.from,
          to: range.to,
          filters,
          includeCrm: false,
          limit: PAGE,
          offset: pageParam,
        },
      }),
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((sum, page) => sum + page.rows.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });

  const rows = query.data?.pages.flatMap((page) => page.rows) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;

  const exportCsv = async () => {
    setExporting(true);
    try {
      const all = await fetchPlayers({
        data: {
          from: range.from,
          to: range.to,
          filters,
          includeCrm: false,
          limit: CSV_MAX,
          offset: 0,
        },
      });
      const csv = originPlayersCsv(all.rows, currency);
      const blob = new Blob([`${BOM}${csv}`], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `origem-jogadores-${range.from}-a-${range.to}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (all.total > CSV_MAX) {
        toast.message(`O arquivo traz os ${CSV_MAX} jogadores com mais depósito de ${all.total}.`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível exportar");
    } finally {
      setExporting(false);
    }
  };

  return (
    <Sheet open={target != null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="break-words">{target?.title}</SheetTitle>
          <SheetDescription>
            {query.isLoading
              ? "Carregando…"
              : `${total} ${total === 1 ? "cadastro" : "cadastros"} do período, do maior depósito para o menor.`}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-3 flex justify-end">
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            disabled={exporting || total === 0}
            onClick={() => void exportCsv()}
          >
            {exporting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            Exportar jogadores
          </Button>
        </div>

        {query.error && (
          <p role="alert" className="mt-3 text-sm text-warning">
            Não foi possível carregar os jogadores.
            {query.error instanceof Error && query.error.message ? ` (${query.error.message})` : ""}
          </p>
        )}

        <ul className="mt-3 space-y-2">
          {rows.map((player) => {
            const origin = [player.source, player.medium, player.campaign]
              .filter(Boolean)
              .join(" · ");
            return (
              <li key={player.id} className="rounded-xl border border-border p-3">
                <div className="flex items-start justify-between gap-2">
                  <Link
                    to="/players/$playerId"
                    params={{ playerId: player.id }}
                    search={{ id: undefined, focus: undefined }}
                    className="min-w-0 truncate font-medium hover:underline"
                  >
                    {player.nome || "Sem nome"}
                  </Link>
                  <span className="shrink-0 text-meta text-muted-foreground">
                    {new Date(player.createdAt).toLocaleDateString("pt-BR")}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-meta text-muted-foreground">
                  {channelLabel(player.channel)}
                  {origin && ` · ${origin}`}
                  {player.affiliate && ` · afiliado ${player.expert ?? player.affiliate}`}
                  {!player.affiliate && player.referral && ` · indicação ${player.referral}`}
                </p>
                <dl className="mt-2 grid grid-cols-3 gap-2 text-[13px]">
                  <div>
                    <dt className="text-meta text-muted-foreground">1º depósito</dt>
                    <dd className="tabular-nums">{player.ftd ? money(player.ftdValue) : "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-meta text-muted-foreground">Depósitos</dt>
                    <dd className="tabular-nums">{money(player.deposits)}</dd>
                  </div>
                  <div>
                    <dt className="text-meta text-muted-foreground">Líquido</dt>
                    <dd className="tabular-nums">{money(player.deposits - player.withdrawals)}</dd>
                  </div>
                </dl>
              </li>
            );
          })}
        </ul>

        {query.hasNextPage && (
          <div className="mt-3 flex justify-center">
            <Button
              variant="outline"
              size="sm"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? "Carregando…" : "Carregar mais"}
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
