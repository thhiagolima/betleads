import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { FileAudio, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import {
  createJourneyVoiceUpload,
  finalizeJourneyVoiceUpload,
} from "@/lib/journey-voice-assets.functions";

const acceptedTypes = ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/ogg"] as const;
type AcceptedAudioType = (typeof acceptedTypes)[number];

async function readAudioDuration(file: File): Promise<number | undefined> {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<number | undefined>((resolve) => {
      const audio = document.createElement("audio");
      const timeout = window.setTimeout(() => resolve(undefined), 5_000);
      audio.preload = "metadata";
      audio.onloadedmetadata = () => {
        window.clearTimeout(timeout);
        resolve(
          Number.isFinite(audio.duration) ? Math.max(1, Math.round(audio.duration)) : undefined,
        );
      };
      audio.onerror = () => {
        window.clearTimeout(timeout);
        resolve(undefined);
      };
      audio.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function VoiceAssetUploadDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (asset: { id: string; name: string }) => void;
}) {
  const createUpload = useServerFn(createJourneyVoiceUpload);
  const finalizeUpload = useServerFn(finalizeJourneyVoiceUpload);
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [language, setLanguage] = useState("pt-BR");
  const [tags, setTags] = useState("");

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setName("");
    setLanguage("pt-BR");
    setTags("");
  }, [open]);

  const upload = useMutation({
    mutationFn: async () => {
      if (!file || !name.trim()) throw new Error("Selecione o áudio e informe um nome.");
      if (!acceptedTypes.includes(file.type as AcceptedAudioType)) {
        throw new Error("Formato inválido. Envie MP3, WAV, M4A/MP4 ou OGG.");
      }
      if (file.size > 52_428_800) throw new Error("O áudio deve ter no máximo 50 MB.");
      const contentType = file.type as AcceptedAudioType;
      const durationSeconds = await readAudioDuration(file);
      const signed = await createUpload({
        data: { name: name.trim(), filename: file.name, contentType, sizeBytes: file.size },
      });
      const { error } = await supabase.storage
        .from("call-audios")
        .uploadToSignedUrl(signed.path, signed.token, file, { contentType });
      if (error) throw new Error(error.message);
      return finalizeUpload({
        data: {
          path: signed.path,
          name: name.trim(),
          contentType,
          sizeBytes: file.size,
          durationSeconds,
          language,
          tags: tags
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean),
        },
      });
    },
    onSuccess: ({ asset }) => {
      queryClient.invalidateQueries({ queryKey: ["journey-voice-assets"] });
      onCreated({ id: asset.id, name: asset.name });
      onOpenChange(false);
      toast.success("Áudio enviado e selecionado");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Enviar áudio fixo</DialogTitle>
          <DialogDescription>
            Adicione um áudio reutilizável à biblioteca. Formatos: MP3, WAV, M4A/MP4 ou OGG, até 50
            MB.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed p-6 text-center hover:bg-muted/40">
            <FileAudio className="size-8 text-primary" />
            <span className="font-medium">{file ? file.name : "Selecionar arquivo de áudio"}</span>
            {file && (
              <span className="text-xs text-muted-foreground">
                {(file.size / 1024 / 1024).toFixed(1)} MB
              </span>
            )}
            <input
              className="sr-only"
              type="file"
              accept="audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/ogg"
              onChange={(event) => {
                const selected = event.target.files?.[0] ?? null;
                setFile(selected);
                if (selected && !name) setName(selected.name.replace(/\.[^.]+$/, ""));
              }}
            />
          </label>
          <div className="space-y-1.5">
            <Label htmlFor="voice-asset-name">Nome na biblioteca</Label>
            <Input id="voice-asset-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="voice-asset-language">Idioma</Label>
              <Input
                id="voice-asset-language"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="voice-asset-tags">Tags</Label>
              <Input
                id="voice-asset-tags"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="vip, retorno"
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            type="button"
            disabled={!file || !name.trim() || upload.isPending}
            onClick={() => upload.mutate()}
          >
            <Upload className="mr-2 size-4" />
            {upload.isPending ? "Enviando…" : "Enviar e selecionar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
