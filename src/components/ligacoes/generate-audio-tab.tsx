import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Mic, Sparkles, Zap, ListPlus, Loader2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  listCallScripts,
  generateLeadVoiceAudio,
  prepareCallForLead,
} from "@/lib/calls.functions";
import { LeadSelector, type SelectedLead } from "./lead-selector";
import {
  FAKE_LEAD_CLIENT,
  renderScriptClient,
} from "./shared";

export function GenerateAudioTab() {
  const qc = useQueryClient();
  const listScripts = useServerFn(listCallScripts);
  const genFn = useServerFn(generateLeadVoiceAudio);
  const queueFn = useServerFn(prepareCallForLead);

  const [scriptId, setScriptId] = useState<string>("");
  const [lead, setLead] = useState<SelectedLead | null>(null);
  const [result, setResult] = useState<{ url: string; cache: boolean; text: string } | null>(null);

  const { data } = useQuery({
    queryKey: ["call-scripts"],
    queryFn: () => listScripts(),
  });
  const scripts = data?.scripts ?? [];
  const selectedScript = scripts.find((s: any) => s.id === scriptId);

  const previewText = selectedScript
    ? renderScriptClient(
        selectedScript.content as string,
        lead?.fake || !lead
          ? FAKE_LEAD_CLIENT
          : { id: lead.id, nome: lead.nome, telefone: lead.telefone ?? undefined },
      )
    : "";

  const genMut = useMutation({
    mutationFn: () =>
      genFn({
        data: {
          script_id: scriptId,
          lead_id: lead?.fake ? null : (lead?.id ?? null),
        },
      }),
    onSuccess: (res: any) => {
      const audio = res.audio;
      setResult({
        url: audio.audio_url,
        cache: res.cache,
        text: audio.rendered_text,
      });
      toast.success(
        res.cache ? "Áudio servido do cache" : "Áudio gerado via ElevenLabs",
      );
      qc.invalidateQueries({ queryKey: ["audio-generations"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Falha ao gerar áudio"),
  });

  const queueMut = useMutation({
    mutationFn: () =>
      queueFn({
        data: {
          script_id: scriptId,
          lead_id: lead?.fake ? null : (lead?.id ?? null),
          phone_number: lead?.telefone ?? null,
        },
      }),
    onSuccess: () => {
      toast.success("Ligação enfileirada — áudio pronto");
      qc.invalidateQueries({ queryKey: ["call-queue"] });
      qc.invalidateQueries({ queryKey: ["audio-generations"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Falha ao enfileirar"),
  });

  const canGenerate = Boolean(scriptId && lead);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mic className="h-5 w-5 text-primary" />
          Gerar áudio personalizado
        </CardTitle>
        <CardDescription>
          Escolha um script e um lead — geramos áudio real com ElevenLabs e você ouve aqui.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-5 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Script</Label>
            <Select value={scriptId} onValueChange={setScriptId}>
              <SelectTrigger>
                <SelectValue placeholder="Selecione um script..." />
              </SelectTrigger>
              <SelectContent>
                {scripts.length === 0 && (
                  <div className="px-3 py-2 text-xs text-muted-foreground">
                    Nenhum script — crie um na aba Scripts.
                  </div>
                )}
                {scripts.map((s: any) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Lead</Label>
            <LeadSelector value={lead} onChange={setLead} />
          </div>
        </div>

        {selectedScript && (
          <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
            <p className="mb-1 flex items-center gap-2 text-xs font-medium text-primary">
              <Sparkles className="h-3 w-3" /> Texto renderizado
            </p>
            <p className="text-sm leading-relaxed text-foreground">{previewText}</p>
          </div>
        )}

        <div className="flex flex-wrap gap-3">
          <Button
            onClick={() => genMut.mutate()}
            disabled={!canGenerate || genMut.isPending}
          >
            {genMut.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Zap className="mr-2 h-4 w-4" />
            )}
            Gerar áudio com ElevenLabs
          </Button>
          <Button
            variant="outline"
            onClick={() => queueMut.mutate()}
            disabled={!canGenerate || queueMut.isPending}
          >
            {queueMut.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <ListPlus className="mr-2 h-4 w-4" />
            )}
            Enfileirar ligação
          </Button>
        </div>

        {result && (
          <div className="space-y-3 rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">Preview de áudio</p>
              {result.cache && (
                <Badge variant="secondary" className="gap-1">
                  <Sparkles className="h-3 w-3" /> cache hit
                </Badge>
              )}
            </div>
            <audio controls src={result.url} className="w-full" />
            <p className="text-xs text-muted-foreground">{result.text}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}