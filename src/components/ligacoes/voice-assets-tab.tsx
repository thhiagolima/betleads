import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Archive, Pencil, Play, Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { VoiceAssetUploadDialog } from "@/components/ligacoes/voice-asset-upload-dialog";
import { requestConfirmation } from "@/components/system-dialog-host";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  deleteJourneyVoiceAsset,
  getJourneyVoiceAssetPreview,
  listJourneyVoiceAssets,
  updateJourneyVoiceAsset,
} from "@/lib/journey-voice-assets.functions";

type VoiceAsset = {
  id: string;
  name: string;
  storage_path: string;
  content_type: string;
  size_bytes: number;
  duration_seconds: number | null;
  tags: string[];
  language: string;
  source: "upload" | "tts" | "import";
  is_archived: boolean;
  created_at: string;
  updated_at: string;
};

type AssetFilter = "active" | "archived" | "all";

export function VoiceAssetsTab() {
  const queryClient = useQueryClient();
  const list = useServerFn(listJourneyVoiceAssets);
  const preview = useServerFn(getJourneyVoiceAssetPreview);
  const update = useServerFn(updateJourneyVoiceAsset);
  const remove = useServerFn(deleteJourneyVoiceAsset);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<AssetFilter>("active");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [editing, setEditing] = useState<VoiceAsset | null>(null);
  const [name, setName] = useState("");
  const [tags, setTags] = useState("");
  const [language, setLanguage] = useState("pt-BR");
  const assets = useQuery({
    queryKey: ["journey-voice-assets"],
    queryFn: () => list(),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["journey-voice-assets"] });
  const rows = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    return ((assets.data?.assets ?? []) as VoiceAsset[]).filter((asset) => {
      const stateMatches =
        filter === "all" ||
        (filter === "active" && !asset.is_archived) ||
        (filter === "archived" && asset.is_archived);
      const searchMatches =
        `${asset.name} ${asset.tags.join(" ")} ${asset.language} ${asset.source}`
          .toLowerCase()
          .includes(normalized);
      return stateMatches && searchMatches;
    });
  }, [assets.data, filter, search]);
  const play = useMutation({
    mutationFn: (id: string) => preview({ data: { id } }),
    onSuccess: ({ url }) => {
      const audio = new Audio(url);
      void audio.play();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const save = useMutation({
    mutationFn: (asset: VoiceAsset) =>
      update({
        data: {
          id: asset.id,
          name,
          tags: tags
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
          language,
          isArchived: asset.is_archived,
        },
      }),
    onSuccess: () => {
      setEditing(null);
      refresh();
      toast.success("Metadados atualizados");
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const archive = useMutation({
    mutationFn: (asset: VoiceAsset) =>
      update({
        data: {
          id: asset.id,
          name: asset.name,
          tags: asset.tags,
          language: asset.language,
          isArchived: !asset.is_archived,
        },
      }),
    onSuccess: () => {
      refresh();
      toast.success("Estado do áudio atualizado");
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const deleteAsset = useMutation({
    mutationFn: (asset: VoiceAsset) => remove({ data: { id: asset.id } }),
    onSuccess: () => {
      refresh();
      toast.success("Áudio e objeto de armazenamento excluídos");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  async function confirmDelete(asset: VoiceAsset) {
    const confirmed = await requestConfirmation({
      title: "Excluir áudio permanentemente?",
      description:
        "O arquivo será removido do armazenamento. Áudios referenciados não podem ser excluídos; nesses casos, arquive o item.",
      confirmLabel: "Excluir áudio",
      destructive: true,
    });
    if (confirmed) deleteAsset.mutate(asset);
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
          <div>
            <CardTitle>Biblioteca de áudios</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Ativos fixos reutilizáveis em jornadas e campanhas de voz.
            </p>
          </div>
          <Button onClick={() => setUploadOpen(true)}>
            <Plus className="mr-2 size-4" /> Novo áudio
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-64 flex-1">
              <Search className="absolute left-3 top-3 size-4 text-muted-foreground" />
              <Input
                className="pl-9"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Buscar por nome, tag, idioma ou origem"
              />
            </div>
            {(["active", "archived", "all"] as const).map((value) => (
              <Button
                key={value}
                size="sm"
                variant={filter === value ? "default" : "outline"}
                onClick={() => setFilter(value)}
              >
                {value === "active" ? "Ativos" : value === "archived" ? "Arquivados" : "Todos"}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {assets.isLoading && <p className="text-sm text-muted-foreground">Carregando áudios…</p>}
      {!assets.isLoading && rows.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
            <p className="font-medium">Nenhum áudio encontrado</p>
            <p className="text-sm text-muted-foreground">
              Envie o primeiro ativo ou ajuste a busca e o filtro.
            </p>
            <Button onClick={() => setUploadOpen(true)}>
              <Plus className="mr-2 size-4" /> Enviar áudio
            </Button>
          </CardContent>
        </Card>
      )}

      {rows.map((asset) => (
        <Card key={asset.id} className={asset.is_archived ? "opacity-60" : ""}>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium">{asset.name}</p>
                <Badge variant="outline">
                  {asset.source === "tts"
                    ? "TTS"
                    : asset.source === "import"
                      ? "Importado"
                      : "Upload"}
                </Badge>
                {asset.is_archived && <Badge variant="secondary">Arquivado</Badge>}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {asset.language} · {asset.duration_seconds ? `${asset.duration_seconds}s · ` : ""}
                {Math.round(asset.size_bytes / 1024)} KB · {asset.tags.join(", ") || "sem tags"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Atualizado em {new Date(asset.updated_at).toLocaleString("pt-BR")}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => play.mutate(asset.id)}>
                <Play className="mr-1 size-3.5" /> Ouvir
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setEditing(asset);
                  setName(asset.name);
                  setTags(asset.tags.join(", "));
                  setLanguage(asset.language);
                }}
              >
                <Pencil className="mr-1 size-3.5" /> Editar
              </Button>
              <Button size="sm" variant="outline" onClick={() => archive.mutate(asset)}>
                <Archive className="mr-1 size-3.5" />
                {asset.is_archived ? "Reativar" : "Arquivar"}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Excluir ${asset.name}`}
                onClick={() => void confirmDelete(asset)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}

      {editing && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Editar metadados</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-3">
            <div>
              <Label htmlFor="asset-edit-name">Nome</Label>
              <Input
                id="asset-edit-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="asset-edit-tags">Tags</Label>
              <Input
                id="asset-edit-tags"
                value={tags}
                onChange={(event) => setTags(event.target.value)}
                placeholder="vip, recuperação"
              />
            </div>
            <div>
              <Label htmlFor="asset-edit-language">Idioma</Label>
              <Input
                id="asset-edit-language"
                value={language}
                onChange={(event) => setLanguage(event.target.value)}
              />
            </div>
            <div className="flex gap-2 md:col-span-3">
              <Button
                onClick={() => save.mutate(editing)}
                disabled={save.isPending || !name.trim()}
              >
                Salvar
              </Button>
              <Button variant="ghost" onClick={() => setEditing(null)}>
                Cancelar
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <VoiceAssetUploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onCreated={() => refresh()}
      />
    </div>
  );
}
