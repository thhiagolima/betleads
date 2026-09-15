import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ListOrdered, Loader2, Pause, Phone, Play, RefreshCw, X } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  listCallQueue,
  cancelCallQueueItem,
  updateCallQueueStatus,
  dispatchCallQueueItem,
} from "@/lib/calls.functions";
import { QUEUE_STATUS_LABEL } from "./shared";

export function QueueTab() {
  const qc = useQueryClient();
  const listFn = useServerFn(listCallQueue);
  const cancelFn = useServerFn(cancelCallQueueItem);
  const statusFn = useServerFn(updateCallQueueStatus);
  const dispatchFn = useServerFn(dispatchCallQueueItem);

  const { data, isLoading } = useQuery({
    queryKey: ["call-queue"],
    queryFn: () => listFn({ data: { limit: 100 } }),
    refetchInterval: 5000,
  });

  const cancelMut = useMutation({
    mutationFn: (id: string) => cancelFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Item cancelado");
      qc.invalidateQueries({ queryKey: ["call-queue"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Erro ao cancelar"),
  });

  const statusMut = useMutation({
    mutationFn: (v: { id: string; status: any }) => statusFn({ data: v }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["call-queue"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Erro ao atualizar"),
  });

  const dispatchMut = useMutation({
    mutationFn: (id: string) => dispatchFn({ data: { call_queue_id: id } }),
    onSuccess: (r: any) => {
      if (r?.pending) toast.info("Ligação pendente para retentativa");
      else toast.success("Ligação disparada");
      qc.invalidateQueries({ queryKey: ["call-queue"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Erro ao disparar"),
  });

  const items = data?.items ?? [];

  const retryAllMut = useMutation({
    mutationFn: async () => {
      const pending = items.filter(
        (it: any) =>
          it.status === "audio_ready" &&
          (it.provider_status === "provider_unavailable" || !it.provider_status),
      );
      let ok = 0;
      let fail = 0;
      for (const it of pending) {
        try {
          const r: any = await dispatchFn({ data: { call_queue_id: it.id } });
          if (r?.pending) fail += 1;
          else ok += 1;
        } catch {
          fail += 1;
        }
      }
      return { ok, fail, total: pending.length };
    },
    onSuccess: (r) => {
      if (r.total === 0) toast.info("Nenhuma ligação pendente para retentar");
      else if (r.fail === 0) toast.success(`${r.ok} ligação(ões) disparada(s)`);
      else toast.warning(`${r.ok} disparadas, ${r.fail} ainda falhando`);
      qc.invalidateQueries({ queryKey: ["call-queue"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Erro ao retentar"),
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ListOrdered className="h-5 w-5 text-primary" />
              Fila de ligações
            </CardTitle>
            <CardDescription>
              Itens preparados aguardando provedor de telefonia.
            </CardDescription>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => retryAllMut.mutate()}
            disabled={retryAllMut.isPending}
            className="gap-2"
          >
            {retryAllMut.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Retentar pendentes
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Carregando...</p>
        ) : items.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            Nenhum item na fila.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Telefone</TableHead>
                <TableHead>Áudio</TableHead>
                <TableHead>Horário</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((it: any) => (
                <TableRow key={it.id}>
                  <TableCell>
                    <Badge variant="outline">
                      {QUEUE_STATUS_LABEL[it.status] ?? it.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">{it.phone_number ?? "—"}</TableCell>
                  <TableCell>
                    {it.audio_url ? (
                      <audio controls src={it.audio_url} className="h-8 w-44" />
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(it.scheduled_at).toLocaleString("pt-BR")}
                  </TableCell>
                  <TableCell className="text-right">
                    {it.status === "audio_ready" && (
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => dispatchMut.mutate(it.id)}
                        disabled={dispatchMut.isPending}
                        title="Disparar agora"
                      >
                        <Phone className="h-4 w-4 text-primary" />
                      </Button>
                    )}
                    {it.status === "paused" ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() =>
                          statusMut.mutate({ id: it.id, status: "audio_ready" })
                        }
                        title="Retomar"
                      >
                        <Play className="h-4 w-4" />
                      </Button>
                    ) : (
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() =>
                          statusMut.mutate({ id: it.id, status: "paused" })
                        }
                        title="Pausar"
                        disabled={["cancelled", "completed", "failed"].includes(it.status)}
                      >
                        <Pause className="h-4 w-4" />
                      </Button>
                    )}
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => cancelMut.mutate(it.id)}
                      disabled={["cancelled", "completed"].includes(it.status)}
                      title="Cancelar"
                    >
                      <X className="h-4 w-4 text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}