import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, ImagePlus, Loader2, Monitor, Smartphone } from "lucide-react";
import { toast } from "sonner";

import { fromBrtInput, toBrtInput } from "@/components/journeys/journey-editor-config";
import { PopupPreview } from "@/components/popups/popup-preview";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { tourAnchor } from "@/help/anchor";
import type { Json } from "@/integrations/supabase/types";
import { HOUSE_CAMPAIGN_SOURCE } from "@/lib/campaign-data-source";
import { EMAIL_IMAGE_MAX_BYTES, uploadEmailImage } from "@/lib/email-image-upload";
import { SYSTEM_SMS_AUDIENCES } from "@/lib/sms-audience-criteria";
import { getPopupFn, savePopupFn } from "@/lib/popups/popups.functions";
import {
  EMPTY_POPUP_DRAFT,
  POPUP_AUDIENCE_KINDS,
  POPUP_AUDIENCE_LABELS,
  POPUP_FORMAT_LABELS,
  POPUP_FORMATS,
  POPUP_FREQUENCIES,
  POPUP_FREQUENCY_LABELS,
  POPUP_LIMITS,
  POPUP_PAGE_MODE_LABELS,
  POPUP_PAGE_MODES,
  validatePopupDraft,
  type PopupDraft,
} from "@/lib/popups/shared";
import { POPUPS_QUERY_KEY } from "@/components/popups/popups-query";

type Props = {
  open: boolean;
  /** null = novo popup. */
  popupId: string | null;
  /** O site manda `window.betleads.playerId`? Sem isso, "logados" e público do CRM não alcançam ninguém. */
  playerIdSeen: boolean;
  /** Administrador da casa; os demais só veem. */
  canEdit: boolean;
  onOpenChange: (open: boolean) => void;
};

function Section({
  title,
  hint,
  tour,
  children,
}: {
  title: string;
  hint?: string;
  tour?: ReturnType<typeof tourAnchor>;
  children: React.ReactNode;
}) {
  return (
    <section
      className="space-y-3 rounded-xl border border-border/60 bg-background/40 p-4"
      {...tour}
    >
      <div>
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {hint ? <p className="mt-0.5 text-meta text-muted-foreground">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Counter({ value, max }: { value: string | null; max: number }) {
  const length = (value ?? "").length;
  return (
    <span className={length > max ? "text-destructive" : "text-muted-foreground"}>
      {length}/{max}
    </span>
  );
}

export function PopupEditor({ open, popupId, playerIdSeen, canEdit, onOpenChange }: Props) {
  const queryClient = useQueryClient();
  const getPopup = useServerFn(getPopupFn);
  const savePopup = useServerFn(savePopupFn);
  const listAudiences = useServerFn(HOUSE_CAMPAIGN_SOURCE.listAudiences);

  const [draft, setDraft] = useState<PopupDraft>(EMPTY_POPUP_DRAFT);
  const [pagesText, setPagesText] = useState("");
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [audienceCount, setAudienceCount] = useState<number | null>(null);

  const existing = useQuery({
    queryKey: ["popup", popupId],
    queryFn: () => getPopup({ data: { id: popupId! } }),
    enabled: open && Boolean(popupId),
  });

  const audiences = useQuery({
    queryKey: HOUSE_CAMPAIGN_SOURCE.queryKeys.audiences,
    queryFn: () => listAudiences(),
    enabled: open && draft.audienceKind === "filtro",
  });
  const audienceOptions = useMemo(
    () => [
      ...SYSTEM_SMS_AUDIENCES.map((a) => ({ key: a.id, name: a.name, criteria: a.criteria as unknown })),
      ...(audiences.data ?? []).map((a) => ({ key: a.id, name: a.name, criteria: a.criteria })),
    ],
    [audiences.data],
  );

  useEffect(() => {
    if (!open) return;
    if (!popupId) {
      setDraft(EMPTY_POPUP_DRAFT);
      setPagesText("");
      setStatus(null);
      setAudienceCount(null);
      return;
    }
    if (existing.data) {
      const { id: _id, status: s, audienceCount: count, audienceRefreshedAt: _r, updatedAt: _u, ...rest } = existing.data;
      setDraft(rest);
      setPagesText(rest.paginas.join("\n"));
      setStatus(s);
      setAudienceCount(count);
    }
  }, [open, popupId, existing.data]);

  const set = <K extends keyof PopupDraft>(key: K, value: PopupDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const payload: PopupDraft = { ...draft, paginas: pagesText.split("\n") };
  const validation = validatePopupDraft(payload);
  const readOnly = status === "encerrado" || !canEdit;

  const save = useMutation({
    mutationFn: () => savePopup({ data: { id: popupId, draft: payload } }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: POPUPS_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: ["popup", result.id] });
      toast.success(
        result.audienceCount !== null
          ? `Popup salvo. O público do CRM tem ${result.audienceCount.toLocaleString("pt-BR")} jogadores agora.`
          : popupId
            ? "Popup salvo."
            : "Popup criado como rascunho. Ative quando quiser que apareça no site.",
      );
      onOpenChange(false);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Não foi possível salvar o popup."),
  });

  async function onPickImage(file: File | undefined) {
    if (!file) return;
    if (file.size > EMAIL_IMAGE_MAX_BYTES) {
      toast.error("A imagem pode ter até 5 MB.");
      return;
    }
    setUploading(true);
    try {
      set("imageUrl", await uploadEmailImage(file));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não foi possível enviar a imagem.");
    } finally {
      setUploading(false);
    }
  }

  const needsPlayerId = draft.audienceKind === "logados" || draft.audienceKind === "filtro";
  const loading = Boolean(popupId) && existing.isLoading;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-5xl" closeLabel="Fechar">
        <SheetHeader>
          <SheetTitle>{popupId ? "Editar popup" : "Novo popup"}</SheetTitle>
          <SheetDescription>
            O popup aparece no site da casa pelo mesmo script do web push. Nada muda no site: depois de ativo, ele
            começa a aparecer em até 5 minutos.
          </SheetDescription>
        </SheetHeader>

        {loading ? (
          <div className="flex h-60 items-center justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
            <fieldset disabled={readOnly || save.isPending} className="min-w-0 space-y-4">
              <Section title="Nome" hint="Só a equipe vê o nome. Use algo que diga do que se trata.">
                <Input
                  value={draft.nome}
                  maxLength={POPUP_LIMITS.nome}
                  placeholder="Ex.: Bônus de fim de semana"
                  onChange={(e) => set("nome", e.target.value)}
                />
              </Section>

              <Section title="Conteúdo" tour={tourAnchor("popups.editor.conteudo")}>
                <div className="space-y-1.5">
                  <Label>Formato</Label>
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    size="sm"
                    value={draft.formato}
                    onValueChange={(v) => v && set("formato", v as PopupDraft["formato"])}
                    className="flex-wrap justify-start"
                  >
                    {POPUP_FORMATS.map((f) => (
                      <ToggleGroupItem key={f} value={f}>
                        {POPUP_FORMAT_LABELS[f]}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="popup-image">Imagem (opcional)</Label>
                  <div className="flex gap-2">
                    <Input
                      id="popup-image"
                      value={draft.imageUrl ?? ""}
                      placeholder="https://… ou envie um arquivo"
                      onChange={(e) => set("imageUrl", e.target.value)}
                    />
                    <Button type="button" variant="outline" size="sm" asChild disabled={uploading}>
                      <label className="cursor-pointer">
                        {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
                        Enviar
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp,image/gif"
                          className="sr-only"
                          onChange={(e) => {
                            void onPickImage(e.target.files?.[0]);
                            e.target.value = "";
                          }}
                        />
                      </label>
                    </Button>
                  </div>
                  <p className="text-meta text-muted-foreground">
                    No meio da tela, a imagem ocupa a largura toda (até 420 px). Na faixa do rodapé, vira uma miniatura.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <div className="flex justify-between text-meta">
                    <Label htmlFor="popup-title">Título</Label>
                    <Counter value={draft.titulo} max={POPUP_LIMITS.titulo} />
                  </div>
                  <Input
                    id="popup-title"
                    value={draft.titulo ?? ""}
                    placeholder="Ex.: Ganhe 100% no seu próximo depósito"
                    onChange={(e) => set("titulo", e.target.value)}
                  />
                </div>

                <div className="space-y-1.5">
                  <div className="flex justify-between text-meta">
                    <Label htmlFor="popup-text">Texto (opcional)</Label>
                    <Counter value={draft.texto} max={POPUP_LIMITS.texto} />
                  </div>
                  <Textarea
                    id="popup-text"
                    rows={3}
                    value={draft.texto ?? ""}
                    onChange={(e) => set("texto", e.target.value)}
                  />
                </div>

                <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
                  <div className="space-y-1.5">
                    <Label htmlFor="popup-button">Texto do botão</Label>
                    <Input
                      id="popup-button"
                      value={draft.botaoLabel ?? ""}
                      maxLength={POPUP_LIMITS.botaoLabel}
                      placeholder="Ex.: Depositar agora"
                      onChange={(e) => set("botaoLabel", e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="popup-link">Link do botão</Label>
                    <Input
                      id="popup-link"
                      value={draft.botaoUrl ?? ""}
                      placeholder="https://suacasa.bet/deposito"
                      onChange={(e) => set("botaoUrl", e.target.value)}
                    />
                  </div>
                </div>
                <p className="text-meta text-muted-foreground">Sem botão, o popup só tem o “×” para fechar.</p>
              </Section>

              <Section title="Quem vê" tour={tourAnchor("popups.editor.publico")}>
                <Select
                  value={draft.audienceKind}
                  onValueChange={(v) => set("audienceKind", v as PopupDraft["audienceKind"])}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {POPUP_AUDIENCE_KINDS.map((k) => (
                      <SelectItem key={k} value={k}>
                        {POPUP_AUDIENCE_LABELS[k]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {draft.audienceKind === "filtro" ? (
                  <div className="space-y-1.5">
                    <Label>Público</Label>
                    <Select
                      value={audienceOptions.find((a) => a.name === draft.audienceLabel)?.key ?? ""}
                      onValueChange={(key) => {
                        const option = audienceOptions.find((a) => a.key === key);
                        if (!option) return;
                        setDraft((current) => ({
                          ...current,
                          audienceLabel: option.name,
                          audienceCriteria: option.criteria as Json,
                        }));
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={audiences.isLoading ? "Carregando públicos…" : "Escolha um público"} />
                      </SelectTrigger>
                      <SelectContent>
                        {audienceOptions.map((a) => (
                          <SelectItem key={a.key} value={a.key}>
                            {a.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-meta text-muted-foreground">
                      Os públicos são os mesmos da tela Públicos. A lista de jogadores é atualizada a cada hora: quem entra
                      no público passa a ver o popup em até 1 hora.
                      {audienceCount !== null
                        ? ` Na última atualização, ${audienceCount.toLocaleString("pt-BR")} jogadores estavam no público.`
                        : ""}
                    </p>
                  </div>
                ) : null}

                {needsPlayerId && !playerIdSeen ? (
                  <p className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-meta text-amber-200">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    O site ainda não informou nenhum jogador logado (o trecho “Jogador logado” da instalação). Até isso
                    acontecer, este popup não aparece para ninguém.
                  </p>
                ) : null}
              </Section>

              <Section title="Onde aparece" tour={tourAnchor("popups.editor.paginas")}>
                <Select
                  value={draft.paginasModo}
                  onValueChange={(v) => set("paginasModo", v as PopupDraft["paginasModo"])}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {POPUP_PAGE_MODES.map((m) => (
                      <SelectItem key={m} value={m}>
                        {POPUP_PAGE_MODE_LABELS[m]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {draft.paginasModo !== "todas" ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="popup-pages">Páginas, uma por linha</Label>
                    <Textarea
                      id="popup-pages"
                      rows={4}
                      value={pagesText}
                      placeholder={"/\n/cassino/*\n/promocoes"}
                      className="font-mono text-meta"
                      onChange={(e) => setPagesText(e.target.value)}
                    />
                    <p className="text-meta text-muted-foreground">
                      “/” é a página inicial. Termine com “/*” para valer também para tudo abaixo (ex.: “/cassino/*”
                      pega “/cassino/slots”). Pode colar o endereço completo da página.
                    </p>
                  </div>
                ) : null}
              </Section>

              <Section title="Quando e quantas vezes">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="popup-delay">Aparece depois de (segundos)</Label>
                    <Input
                      id="popup-delay"
                      type="number"
                      min={0}
                      max={120}
                      value={draft.atrasoSegundos}
                      onChange={(e) => set("atrasoSegundos", Number(e.target.value))}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Frequência por pessoa</Label>
                    <Select
                      value={draft.frequencia}
                      onValueChange={(v) => set("frequencia", v as PopupDraft["frequencia"])}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {POPUP_FREQUENCIES.map((f) => (
                          <SelectItem key={f} value={f}>
                            {POPUP_FREQUENCY_LABELS[f]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {draft.frequencia === "n_dias" ? (
                    <div className="space-y-1.5">
                      <Label htmlFor="popup-days">A cada quantos dias</Label>
                      <Input
                        id="popup-days"
                        type="number"
                        min={1}
                        max={90}
                        value={draft.frequenciaDias ?? ""}
                        onChange={(e) => set("frequenciaDias", e.target.value ? Number(e.target.value) : null)}
                      />
                    </div>
                  ) : null}
                </div>
                <p className="text-meta text-muted-foreground">
                  A frequência é contada por navegador. Quem limpa os dados do navegador ou usa aba anônima pode ver de
                  novo.
                </p>
              </Section>

              <Section
                title="Período e prioridade"
                hint="Sem datas, vale enquanto estiver ativo. Se dois popups valem para a mesma pessoa e página, aparece o de maior prioridade."
              >
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="popup-start">Começa em (Brasília)</Label>
                    <Input
                      id="popup-start"
                      type="datetime-local"
                      value={toBrtInput(draft.startsAt)}
                      onChange={(e) => set("startsAt", fromBrtInput(e.target.value))}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="popup-end">Termina em (Brasília)</Label>
                    <Input
                      id="popup-end"
                      type="datetime-local"
                      value={toBrtInput(draft.endsAt)}
                      onChange={(e) => set("endsAt", fromBrtInput(e.target.value))}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="popup-priority">Prioridade (0 a 1000)</Label>
                    <Input
                      id="popup-priority"
                      type="number"
                      min={0}
                      max={1000}
                      value={draft.prioridade}
                      onChange={(e) => set("prioridade", Number(e.target.value))}
                    />
                  </div>
                </div>
              </Section>
            </fieldset>

            <aside className="space-y-3 lg:sticky lg:top-0 lg:self-start">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">Prévia</p>
                <ToggleGroup
                  type="single"
                  size="sm"
                  variant="outline"
                  value={device}
                  onValueChange={(v) => v && setDevice(v as "desktop" | "mobile")}
                >
                  <ToggleGroupItem value="desktop" aria-label="Computador">
                    <Monitor className="h-4 w-4" />
                  </ToggleGroupItem>
                  <ToggleGroupItem value="mobile" aria-label="Celular">
                    <Smartphone className="h-4 w-4" />
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
              <PopupPreview
                device={device}
                content={{
                  formato: draft.formato,
                  imageUrl: draft.imageUrl?.startsWith("https://") ? draft.imageUrl : null,
                  titulo: draft.titulo?.trim() || null,
                  texto: draft.texto?.trim() || null,
                  botaoLabel: draft.botaoLabel?.trim() || null,
                }}
              />
              {!readOnly ? (
                <>
                  {!validation.ok ? <p className="text-meta text-amber-300">{validation.error}</p> : null}
                  <Button
                    className="w-full"
                    disabled={!validation.ok || save.isPending || uploading}
                    onClick={() => save.mutate()}
                  >
                    {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {popupId ? "Salvar alterações" : "Criar rascunho"}
                  </Button>
                  {status === "ativo" ? (
                    <p className="text-meta text-muted-foreground">
                      Este popup está ativo: as mudanças chegam ao site em até 5 minutos.
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="text-meta text-muted-foreground">
                  {canEdit
                    ? "Popup encerrado não pode ser alterado. Use “Duplicar” na lista para criar outro igual."
                    : "Só administradores da casa podem alterar popups."}
                </p>
              )}
            </aside>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
