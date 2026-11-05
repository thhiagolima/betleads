import { Bell } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SegmentedFilter } from "@/components/players/segmented-filter";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { brl, num } from "@/lib/format";
import type { SmsAudienceCriteria } from "@/lib/sms-audience-criteria";
import type { WebpushAudienceCount } from "@/lib/webpush/campaigns.server";

export type WebpushAudienceKind = "todos" | "filtro";

/** Same shape the composer builds from `SYSTEM_SMS_AUDIENCES` + saved audiences. */
export type WebpushAudienceOption = {
  id: string;
  name: string;
  criteria: SmsAudienceCriteria;
};

const fieldIds = {
  title: "webpush-title",
  body: "webpush-body",
  url: "webpush-url",
  imageUrl: "webpush-image-url",
  audienceLabel: "webpush-audience-label",
  audience: "webpush-audience",
};

/**
 * Web push campaign form: título/mensagem/link/imagem, a notification-style
 * preview (Chrome desktop), and the "Todos os inscritos" / "Filtros do CRM"
 * audience toggle — the second reuses the composer's saved-audience list
 * (same `criteria` object `countWebpushAudienceFn`/`scheduleWebpushCampaignFn`
 * take). The subscriber count and estimated cost are computed by the caller
 * (`countWebpushAudienceFn`, reactive to `audienceKind`/`audienceId`) and
 * passed in as `counts`.
 */
export function WebpushCampaignFields({
  title,
  onTitleChange,
  body,
  onBodyChange,
  url,
  onUrlChange,
  imageUrl,
  onImageUrlChange,
  audienceKind,
  onAudienceKindChange,
  audienceOptions,
  audienceId,
  onAudienceChange,
  counts,
  countsLoading,
  submitAttempted,
}: {
  title: string;
  onTitleChange: (value: string) => void;
  body: string;
  onBodyChange: (value: string) => void;
  url: string;
  onUrlChange: (value: string) => void;
  imageUrl: string;
  onImageUrlChange: (value: string) => void;
  audienceKind: WebpushAudienceKind;
  onAudienceKindChange: (kind: WebpushAudienceKind) => void;
  audienceOptions: WebpushAudienceOption[];
  audienceId: string;
  onAudienceChange: (id: string, criteria: SmsAudienceCriteria) => void;
  counts: WebpushAudienceCount | undefined;
  countsLoading: boolean;
  submitAttempted: boolean;
}) {
  const siteHost = (() => {
    try {
      return new URL(url).host;
    } catch {
      return "seusite.com";
    }
  })();

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={fieldIds.title}>Título da notificação</Label>
        <Input
          id={fieldIds.title}
          name="webpush-title"
          value={title}
          maxLength={64}
          onChange={(event) => onTitleChange(event.target.value)}
          placeholder="Ex.: Seu bônus está liberado"
          aria-invalid={submitAttempted && !title.trim()}
        />
        <p className="text-meta text-muted-foreground">{Array.from(title).length}/64 caracteres</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor={fieldIds.body}>Mensagem</Label>
        <Textarea
          id={fieldIds.body}
          name="webpush-body"
          rows={3}
          value={body}
          maxLength={240}
          onChange={(event) => onBodyChange(event.target.value)}
          placeholder="Entre agora e aproveite."
          aria-invalid={submitAttempted && !body.trim()}
        />
        <p className="text-meta text-muted-foreground">{Array.from(body).length}/240 caracteres</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor={fieldIds.url}>Link</Label>
        <Input
          id={fieldIds.url}
          name="webpush-url"
          value={url}
          onChange={(event) => onUrlChange(event.target.value)}
          placeholder="https://seusite.com/promocao"
          aria-invalid={submitAttempted && !/^https:\/\//i.test(url)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={fieldIds.imageUrl}>Imagem (opcional)</Label>
        <Input
          id={fieldIds.imageUrl}
          name="webpush-image-url"
          value={imageUrl}
          onChange={(event) => onImageUrlChange(event.target.value)}
          placeholder="https://seusite.com/imagem.png"
        />
      </div>

      {/* Chrome desktop notification preview. */}
      <div className="rounded-xl border border-border bg-secondary/40 p-3">
        <p className="mb-2 text-meta text-muted-foreground">Pré-visualização</p>
        <div className="flex items-start gap-3 rounded-lg bg-card p-3 shadow-sm">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Bell className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-meta text-muted-foreground">{siteHost}</p>
            <p className="truncate text-body font-medium">{title || "Título da notificação"}</p>
            <p className="line-clamp-2 text-meta text-muted-foreground">
              {body || "Mensagem da notificação"}
            </p>
          </div>
          {imageUrl ? (
            <img
              src={imageUrl}
              alt=""
              className="size-12 shrink-0 rounded-md object-cover"
              aria-hidden="true"
            />
          ) : null}
        </div>
      </div>

      <div className="space-y-2">
        <Label>Público</Label>
        <SegmentedFilter
          label="Público da campanha de web push"
          value={audienceKind}
          onValueChange={onAudienceKindChange}
          items={[
            { value: "todos", label: "Todos os inscritos" },
            { value: "filtro", label: "Filtros do CRM" },
          ]}
        />
        {audienceKind === "filtro" ? (
          <>
            <Label id={fieldIds.audienceLabel} className="sr-only">
              Público salvo
            </Label>
            <Select
              value={audienceId}
              onValueChange={(value) => {
                const selected = audienceOptions.find((item) => item.id === value);
                if (selected) onAudienceChange(selected.id, selected.criteria);
              }}
            >
              <SelectTrigger
                id={fieldIds.audience}
                aria-labelledby={fieldIds.audienceLabel}
                aria-invalid={submitAttempted && !audienceId}
              >
                <SelectValue placeholder="Selecione um público salvo" />
              </SelectTrigger>
              <SelectContent>
                {audienceOptions.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        ) : (
          <p className="text-meta text-muted-foreground">
            Todos os inscritos ativos de web push desta casa.
          </p>
        )}
        <p className="text-meta text-muted-foreground" aria-live="polite">
          {countsLoading
            ? "Calculando o público…"
            : counts
              ? `${num(counts.subscriptions)} inscrição(ões)${
                  counts.players != null ? ` · ${num(counts.players)} jogador(es) no filtro` : ""
                } · ${counts.unitPrice === 0 ? "isento" : `custo estimado ${brl(counts.estimatedCost)}`}`
              : "—"}
        </p>
      </div>
    </div>
  );
}
