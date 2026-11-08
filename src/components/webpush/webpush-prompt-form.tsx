// Web push (OneSignal) — Task 12: "Convite" tab — the push permission
// prompt copy (text, button labels, icon), with a live preview of the
// slidedown. Saving is disabled for a read-only viewer (`!canEdit`).
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { tourAnchor } from "@/help/anchor";
import { saveWebpushPromptFn } from "@/lib/webpush/webpush.functions";
import type { PromptConfig } from "@/lib/webpush/shared";
import { WEBPUSH_INTEGRATION_QUERY_KEY } from "@/components/webpush/webpush-query";

export function WebpushPromptPreview({ prompt }: { prompt: PromptConfig }) {
  return (
    <div
      role="group"
      aria-label="Pré-visualização do convite de notificações"
      className="w-72 rounded-xl border border-border/60 bg-background/60 p-3 shadow-sm"
    >
      <div className="flex items-start gap-2.5">
        {prompt.iconUrl ? (
          <img src={prompt.iconUrl} alt="" className="h-8 w-8 rounded-md" />
        ) : (
          <div className="h-8 w-8 shrink-0 rounded-md bg-muted" aria-hidden="true" />
        )}
        <p className="flex-1 text-sm">{prompt.promptText}</p>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <span className="rounded-md px-2.5 py-1 text-meta text-muted-foreground">
          {prompt.cancelLabel}
        </span>
        <span className="rounded-md bg-primary px-2.5 py-1 text-meta font-medium text-primary-foreground">
          {prompt.acceptLabel}
        </span>
      </div>
    </div>
  );
}

export function WebpushPromptForm({
  prompt,
  canEdit,
}: {
  prompt: PromptConfig;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const saveFn = useServerFn(saveWebpushPromptFn);

  const [draft, setDraft] = useState<PromptConfig>(prompt);

  // Adopts a freshly loaded/saved prompt — but not while the admin is mid-edit.
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    if (initialized) return;
    setDraft(prompt);
    setInitialized(true);
  }, [prompt, initialized]);

  const save = useMutation({
    mutationFn: () =>
      saveFn({
        data: {
          promptText: draft.promptText,
          acceptLabel: draft.acceptLabel,
          cancelLabel: draft.cancelLabel,
          iconUrl: draft.iconUrl,
        },
      }),
    onSuccess: (saved) => {
      setDraft(saved);
      toast.success("Convite de notificações salvo");
      qc.invalidateQueries({ queryKey: WEBPUSH_INTEGRATION_QUERY_KEY });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_auto]">
      <div className="space-y-4">
        <div className="space-y-1.5" {...tourAnchor("webhooks.webpush.convite-texto")}>
          <Label htmlFor="webpush-prompt-text">Texto do convite</Label>
          <Input
            id="webpush-prompt-text"
            value={draft.promptText}
            maxLength={90}
            disabled={!canEdit}
            onChange={(e) => setDraft((d) => ({ ...d, promptText: e.target.value }))}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2" {...tourAnchor("webhooks.webpush.convite-rotulos")}>
          <div className="space-y-1.5">
            <Label htmlFor="webpush-accept-label">Rótulo de aceitar</Label>
            <Input
              id="webpush-accept-label"
              value={draft.acceptLabel}
              maxLength={15}
              disabled={!canEdit}
              onChange={(e) => setDraft((d) => ({ ...d, acceptLabel: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="webpush-cancel-label">Rótulo de cancelar</Label>
            <Input
              id="webpush-cancel-label"
              value={draft.cancelLabel}
              maxLength={15}
              disabled={!canEdit}
              onChange={(e) => setDraft((d) => ({ ...d, cancelLabel: e.target.value }))}
            />
          </div>
        </div>
        <div className="space-y-1.5" {...tourAnchor("webhooks.webpush.convite-icone")}>
          <Label htmlFor="webpush-icon-url">Ícone (URL https, opcional)</Label>
          <Input
            id="webpush-icon-url"
            value={draft.iconUrl ?? ""}
            placeholder="https://suacasa.bet.br/icone.png"
            disabled={!canEdit}
            onChange={(e) => setDraft((d) => ({ ...d, iconUrl: e.target.value || null }))}
          />
        </div>
        {canEdit && (
          <Button
            type="button"
            disabled={save.isPending}
            onClick={() => save.mutate()}
            {...tourAnchor("webhooks.webpush.convite-salvar")}
          >
            {save.isPending ? "Salvando…" : "Salvar"}
          </Button>
        )}
      </div>
      <div className="space-y-1.5" {...tourAnchor("webhooks.webpush.convite-preview")}>
        <p className="text-label text-muted-foreground">Pré-visualização</p>
        <WebpushPromptPreview prompt={draft} />
      </div>
    </div>
  );
}
