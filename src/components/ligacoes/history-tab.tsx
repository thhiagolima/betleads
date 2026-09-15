import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  History as HistoryIcon,
  Download,
  ChevronDown,
  ChevronRight,
  Bug,
  RefreshCw,
  Loader2,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  listCallHistory,
  listAudioGenerations,
  refreshCallDispatchStatus,
} from "@/lib/calls.functions";
import { HISTORY_STATUS_LABEL } from "./shared";

export function HistoryTab() {
  const [view, setView] = useState<"calls" | "audios">("audios");
  const [openId, setOpenId] = useState<string | null>(null);
  const histFn = useServerFn(listCallHistory);
  const audioFn = useServerFn(listAudioGenerations);
  const refreshFn = useServerFn(refreshCallDispatchStatus);
  const qc = useQueryClient();

  const refreshMut = useMutation({
    mutationFn: (id: string) => refreshFn({ data: { call_history_id: id } }),
    onSuccess: (res: any) => {
      toast.success(
        `Status atualizado: ${res.voice_status ?? res.bc_status ?? "—"}`,
      );
      qc.invalidateQueries({ queryKey: ["call-history"] });
      qc.invalidateQueries({ queryKey: ["call-queue"] });
    },
    onError: (e: any) =>
      toast.error(e?.message ?? "Falha ao consultar status"),
  });

  const hist = useQuery({
    queryKey: ["call-history"],
    queryFn: () => histFn({ data: { limit: 100 } }),
    enabled: view === "calls",
  });
  const audios = useQuery({
    queryKey: ["audio-generations"],
    queryFn: () => audioFn({ data: { limit: 100 } }),
    enabled: view === "audios",
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HistoryIcon className="h-5 w-5 text-primary" />
          Histórico
        </CardTitle>
        <CardDescription>Ligações realizadas e áudios gerados.</CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs value={view} onValueChange={(v: any) => setView(v)}>
          <TabsList>
            <TabsTrigger value="audios">Áudios gerados</TabsTrigger>
            <TabsTrigger value="calls">Ligações</TabsTrigger>
          </TabsList>

          <TabsContent value="audios" className="mt-4">
            {audios.isLoading ? (
              <p className="py-8 text-center text-sm text-muted-foreground">Carregando...</p>
            ) : (audios.data?.generations ?? []).length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                Nenhum áudio gerado ainda.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Status</TableHead>
                    <TableHead>Voz</TableHead>
                    <TableHead>Texto</TableHead>
                    <TableHead>Áudio</TableHead>
                    <TableHead>Criado</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(audios.data?.generations ?? []).map((g: any) => (
                    <TableRow key={g.id}>
                      <TableCell>
                        <Badge
                          variant={
                            g.generation_status === "ready"
                              ? "default"
                              : g.generation_status === "failed"
                                ? "destructive"
                                : "secondary"
                          }
                        >
                          {g.generation_status}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-[11px] text-muted-foreground">
                        {g.voice_id?.slice(0, 8)}...
                      </TableCell>
                      <TableCell className="max-w-md truncate text-xs">
                        {g.rendered_text}
                      </TableCell>
                      <TableCell>
                        {g.audio_url ? (
                          <div className="flex items-center gap-1">
                            <audio controls src={g.audio_url} className="h-8 w-40" />
                            <Button size="icon" variant="ghost" asChild>
                              <a href={g.audio_url} download target="_blank" rel="noreferrer">
                                <Download className="h-4 w-4" />
                              </a>
                            </Button>
                          </div>
                        ) : g.error_message ? (
                          <span className="text-xs text-destructive">{g.error_message}</span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(g.created_at).toLocaleString("pt-BR")}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TabsContent>

          <TabsContent value="calls" className="mt-4">
            {hist.isLoading ? (
              <p className="py-8 text-center text-sm text-muted-foreground">Carregando...</p>
            ) : (hist.data?.history ?? []).length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                Sem ligações registradas ainda — integre um provedor de telefonia.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8"></TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Provedor</TableHead>
                    <TableHead>Telefone</TableHead>
                    <TableHead>Duração</TableHead>
                    <TableHead>Gravação</TableHead>
                    <TableHead>Criado</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(hist.data?.history ?? []).map((h: any) => {
                    const isOpen = openId === h.id;
                    return (
                    <Fragment key={h.id}>
                    <TableRow>
                      <TableCell className="p-0 pl-2">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6"
                          onClick={() => setOpenId(isOpen ? null : h.id)}
                        >
                          {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                        </Button>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">
                          {HISTORY_STATUS_LABEL[h.status] ?? h.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">{h.provider ?? "—"}</TableCell>
                      <TableCell className="text-xs font-mono">{h.to_phone ?? "—"}</TableCell>
                      <TableCell className="text-xs">
                        {h.duration_seconds ? `${h.duration_seconds}s` : "—"}
                      </TableCell>
                      <TableCell>
                        {h.recording_url ? (
                          <audio controls src={h.recording_url} className="h-8 w-40" />
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(h.created_at).toLocaleString("pt-BR")}
                      </TableCell>
                    </TableRow>
                    {isOpen && (
                      <TableRow>
                        <TableCell colSpan={7} className="bg-muted/30">
                          <div className="space-y-2 p-3 text-xs">
                            <div className="flex items-center gap-2 font-medium">
                              <Bug className="h-3.5 w-3.5" /> Debug do disparo
                              <Button
                                size="sm"
                                variant="outline"
                                className="ml-auto h-7 gap-1 text-xs"
                                onClick={() => refreshMut.mutate(h.id)}
                                disabled={refreshMut.isPending}
                              >
                                {refreshMut.isPending && refreshMut.variables === h.id ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <RefreshCw className="h-3 w-3" />
                                )}
                                Atualizar status
                              </Button>
                            </div>
                            <div className="grid gap-2 md:grid-cols-2">
                              <div>
                                <p className="text-muted-foreground">HTTP status BusinessCode</p>
                                <p className="font-mono">{h.provider_status_code ?? "—"}</p>
                              </div>
                              <div>
                                <p className="text-muted-foreground">provider_call_id (idempotency)</p>
                                <p className="font-mono break-all">{h.provider_call_id ?? "—"}</p>
                              </div>
                            </div>
                            {h.audio_url && (
                              <div>
                                <p className="mb-1 text-muted-foreground">URL do áudio enviado ao provedor</p>
                                <div className="flex items-center gap-2">
                                  <a
                                    href={h.audio_url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="truncate text-primary hover:underline"
                                  >
                                    {h.audio_url}
                                  </a>
                                  <audio controls src={h.audio_url} className="h-7 w-48" />
                                </div>
                              </div>
                            )}
                            <div>
                              <p className="mb-1 text-muted-foreground">Resposta crua da BusinessCode</p>
                              <pre className="max-h-60 overflow-auto rounded bg-background p-2 font-mono text-[11px]">
{JSON.stringify(h.provider_response ?? {}, null, 2)}
                              </pre>
                            </div>
                            {h.error_message && (
                              <div>
                                <p className="mb-1 text-muted-foreground">Mensagem de erro</p>
                                <p className="break-words text-rose-400">{h.error_message}</p>
                              </div>
                            )}
                            <p className="text-muted-foreground">
                              Se a URL do áudio não abrir no navegador, a BusinessCode também não consegue —
                              é preciso autorizar o host <code>yrhczavmbpqerfsfucgr.supabase.co</code> na
                              allowlist deles ou usar bucket público.
                            </p>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                    </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}