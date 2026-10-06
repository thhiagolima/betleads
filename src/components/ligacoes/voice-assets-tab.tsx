import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Archive, Play, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { deleteJourneyVoiceAsset, getJourneyVoiceAssetPreview, listJourneyVoiceAssets, updateJourneyVoiceAsset } from "@/lib/journey-voice-assets.functions";

export function VoiceAssetsTab() {
  const qc = useQueryClient(); const list = useServerFn(listJourneyVoiceAssets); const preview = useServerFn(getJourneyVoiceAssetPreview); const update = useServerFn(updateJourneyVoiceAsset); const remove = useServerFn(deleteJourneyVoiceAsset);
  const assets = useQuery({ queryKey: ["journey-voice-assets"], queryFn: () => list() });
  const refresh = () => qc.invalidateQueries({ queryKey: ["journey-voice-assets"] });
  const play = useMutation({ mutationFn: (id: string) => preview({ data: { id } }), onSuccess: ({ url }) => { const audio = new Audio(url); void audio.play(); }, onError: (e: Error) => toast.error(e.message) });
  const action = useMutation({ mutationFn: async ({ kind, asset }: any) => kind === "delete" ? remove({ data: { id: asset.id } }) : update({ data: { id: asset.id, name: asset.name, tags: asset.tags ?? [], language: asset.language ?? "pt-BR", isArchived: !asset.is_archived } }), onSuccess: refresh, onError: (e: Error) => toast.error(e.message) });
  return <div className="space-y-4"><Card><CardHeader><CardTitle>Biblioteca de áudios</CardTitle></CardHeader><CardContent className="text-sm text-muted-foreground">Envie novos áudios ao criar uma jornada. Aqui você pode ouvir, arquivar ou excluir ativos que não estejam em uso.</CardContent></Card>{(assets.data?.assets ?? []).map((asset: any) => <Card key={asset.id} className={asset.is_archived ? "opacity-60" : ""}><CardContent className="flex flex-wrap items-center justify-between gap-3 p-4"><div><p className="font-medium">{asset.name}</p><p className="text-xs text-muted-foreground">{asset.language} · {Math.round(asset.size_bytes / 1024)} KB · {(asset.tags ?? []).join(", ") || "sem tags"}</p></div><div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => play.mutate(asset.id)}><Play className="mr-1 h-3.5 w-3.5" />Ouvir</Button><Button size="sm" variant="outline" onClick={() => action.mutate({ kind: "archive", asset })}><Archive className="mr-1 h-3.5 w-3.5" />{asset.is_archived ? "Reativar" : "Arquivar"}</Button><Button size="sm" variant="ghost" onClick={() => action.mutate({ kind: "delete", asset })}><Trash2 className="h-3.5 w-3.5" /></Button></div></CardContent></Card>)}</div>;
}
