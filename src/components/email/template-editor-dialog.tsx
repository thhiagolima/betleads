import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
  CheckCircle2,
  Sparkles,
  Smartphone,
  Monitor,
  Eye,
  Variable,
  Wand2,
  LayoutTemplate,
  Loader2,
  Upload,
  Trash2,
  Image as ImageIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import {
  OBJETIVOS,
  MODELOS,
  TEMPLATES_PRONTOS,
  renderModeloHtml,
  type EmailObjective,
  type ModeloId,
  type FieldsState,
  type PresetTemplate,
} from "./template-presets";
import { generateEmailContent } from "@/lib/email-ai.functions";

export type EditorTemplate = {
  id: string;
  nome: string;
  assunto: string;
  preheader: string;
  fromName: string;
  categoria: string;
  tags: string[];
  corpo: string;
  ativo: boolean;
  atualizadoEm: string;
};

const VARIAVEIS = [
  "{primeiro_nome}",
  "{nome}",
  "{email}",
  "{saldo}",
  "{ultimo_login}",
  "{ultimo_deposito}",
  "{total_depositado}",
  "{link_login}",
  "{link_deposito}",
];

type FieldKey =
  | "nome"
  | "assunto"
  | "preheader"
  | "fromName"
  | "titulo"
  | "texto"
  | "cupom"
  | "beneficio"
  | "cta"
  | "link";

const QUICK_FIELDS: { key: FieldKey; label: string; placeholder?: string }[] = [
  { key: "nome", label: "Nome do template", placeholder: "Ex: Recuperação 7 dias" },
  { key: "assunto", label: "Assunto", placeholder: "Ex: {primeiro_nome}, sentimos sua falta" },
  { key: "preheader", label: "Pré-header", placeholder: "Linha de prévia exibida na caixa de entrada" },
  { key: "fromName", label: "Nome do remetente", placeholder: "Ex: BETLEADS" },
  { key: "titulo", label: "Título principal", placeholder: "Headline grande do email" },
  { key: "texto", label: "Texto principal" },
  { key: "cupom", label: "Cupom (opcional)", placeholder: "Ex: BONUS50" },
  { key: "beneficio", label: "Benefício (opcional)", placeholder: "Ex: +100% no próximo depósito" },
  { key: "cta", label: "Botão / CTA", placeholder: "Ex: Resgatar agora" },
  { key: "link", label: "Link do botão", placeholder: "{link_login} ou URL" },
];

const TOM_OPCOES = [
  { id: "amigavel", label: "Amigável" },
  { id: "urgente", label: "Urgente" },
  { id: "premium", label: "Premium / VIP" },
  { id: "direto", label: "Direto e curto" },
  { id: "casual", label: "Casual" },
] as const;

export function TemplateEditorDialog({
  open,
  onOpenChange,
  editing,
  onSave,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: EditorTemplate | null;
  onSave: (t: EditorTemplate) => void;
}) {
  const [objetivo, setObjetivo] = useState<EmailObjective>("recuperacao");
  const [modelo, setModelo] = useState<ModeloId>("simples");
  const [advanced, setAdvanced] = useState(false);
  const [previewDevice, setPreviewDevice] = useState<"desktop" | "mobile">("desktop");
  const [aiOpen, setAiOpen] = useState(false);
  const [presetsOpen, setPresetsOpen] = useState(false);

  // Quick fields
  const [meta, setMeta] = useState({
    nome: "",
    assunto: "",
    preheader: "",
    fromName: "BETLEADS",
  });
  const [fields, setFields] = useState<FieldsState>({
    titulo: "",
    texto: "",
    cupom: "",
    beneficio: "",
    cta: "Acessar agora",
    link: "{link_login}",
    logo_url: "",
    hero_image_url: "",
    hero_alt: "",
    secondary_image_url: "",
    secondary_alt: "",
    mostrar_banner_secundario: true,
    benefit_icon_url: "",
    mostrar_icone_beneficio: true,
  });
  const [customHtml, setCustomHtml] = useState<string>("");

  // Active focused field — para variáveis clicáveis
  const refs = useRef<Partial<Record<FieldKey, HTMLInputElement | HTMLTextAreaElement | null>>>({});
  const [activeField, setActiveField] = useState<FieldKey>("texto");

  // Init / re-init quando abrir
  useEffect(() => {
    if (!open || !editing) return;
    setMeta({
      nome: editing.nome || "",
      assunto: editing.assunto || "",
      preheader: editing.preheader || "",
      fromName: editing.fromName || "BETLEADS",
    });
    setCustomHtml(editing.corpo || "");
    // Se já tem corpo, ativa avançado para preservar; senão começa visual
    setAdvanced(Boolean(editing.corpo?.trim()));
    // Reset campos visuais
    setFields({
      titulo: "",
      texto: "",
      cupom: "",
      beneficio: "",
      cta: "Acessar agora",
      link: "{link_login}",
      logo_url: "",
      hero_image_url: "",
      hero_alt: "",
      secondary_image_url: "",
      secondary_alt: "",
      mostrar_banner_secundario: true,
      benefit_icon_url: "",
      mostrar_icone_beneficio: true,
    });
    setObjetivo("recuperacao");
    setModelo("simples");
  }, [open, editing]);

  // HTML renderizado (visual) ou customHtml (avançado)
  const htmlPreview = useMemo(() => {
    return advanced ? customHtml : renderModeloHtml(modelo, fields);
  }, [advanced, customHtml, modelo, fields]);

  function insertVariable(token: string) {
    const key = activeField;
    const el = refs.current[key];
    if (key === "nome" || key === "assunto" || key === "preheader" || key === "fromName") {
      const cur = meta[key] ?? "";
      const start = el?.selectionStart ?? cur.length;
      const end = el?.selectionEnd ?? cur.length;
      const next = cur.slice(0, start) + token + cur.slice(end);
      setMeta((m) => ({ ...m, [key]: next }));
      requestAnimationFrame(() => {
        el?.focus();
        const pos = start + token.length;
        (el as any)?.setSelectionRange?.(pos, pos);
      });
      return;
    }
    const cur = (fields as any)[key] ?? "";
    const start = el?.selectionStart ?? cur.length;
    const end = el?.selectionEnd ?? cur.length;
    const next = cur.slice(0, start) + token + cur.slice(end);
    setFields((f) => ({ ...f, [key]: next }));
    requestAnimationFrame(() => {
      el?.focus();
      const pos = start + token.length;
      (el as any)?.setSelectionRange?.(pos, pos);
    });
  }

  function applyPreset(p: PresetTemplate) {
    setObjetivo(p.objetivo);
    setModelo(p.modelo);
    setMeta({
      nome: p.nome,
      assunto: p.assunto,
      preheader: p.preheader,
      fromName: p.fromName,
    });
    setFields(p.campos);
    setAdvanced(false);
    setPresetsOpen(false);
    toast.success(`Template "${p.nome}" aplicado`);
  }

  function salvar() {
    if (!editing) return;
    if (!meta.nome.trim()) {
      toast.error("Dê um nome para o template");
      return;
    }
    const corpoFinal = advanced ? customHtml : renderModeloHtml(modelo, fields);
    onSave({
      ...editing,
      nome: meta.nome,
      assunto: meta.assunto,
      preheader: meta.preheader,
      fromName: meta.fromName,
      corpo: corpoFinal,
      atualizadoEm: "agora",
      tags: editing.tags ?? [],
      categoria: editing.categoria || "Geral",
      ativo: editing.ativo ?? true,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[1200px] w-[95vw] max-h-[92vh] overflow-hidden p-0">
        <DialogHeader className="px-6 py-4 border-b border-border/50">
          <DialogTitle className="flex items-center gap-2">
            <LayoutTemplate className="h-4 w-4 text-primary" />
            Editor de Template
          </DialogTitle>
          <DialogDescription>
            Monte visualmente com objetivo, modelo e campos rápidos — preview ao vivo à direita.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-12 gap-0 max-h-[calc(92vh-150px)] overflow-hidden">
          {/* ============== ESQUERDA (form) ============== */}
          <div className="col-span-12 lg:col-span-7 overflow-y-auto p-6 space-y-5">
            {/* Toolbar topo */}
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setPresetsOpen(true)}>
                <LayoutTemplate className="h-3.5 w-3.5" /> Templates prontos
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setAiOpen(true)}>
                <Sparkles className="h-3.5 w-3.5" /> Gerar com IA
              </Button>
              <div className="flex-1" />
              <div className="flex items-center gap-2">
                <Label className="text-xs text-muted-foreground">HTML avançado</Label>
                <button
                  type="button"
                  onClick={() => setAdvanced((v) => !v)}
                  className={cn(
                    "h-6 w-10 rounded-full transition-colors relative",
                    advanced ? "bg-primary" : "bg-muted",
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-0.5 h-5 w-5 rounded-full bg-background shadow transition-transform",
                      advanced ? "translate-x-4" : "translate-x-0.5",
                    )}
                  />
                </button>
              </div>
            </div>

            {!advanced && (
              <>
                {/* 1. Objetivo */}
                <Section
                  step={1}
                  title="Objetivo do email"
                  desc="O que esse email precisa fazer?"
                >
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                    {OBJETIVOS.map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        onClick={() => setObjetivo(o.id)}
                        className={cn(
                          "rounded-lg border p-2.5 text-left transition-all",
                          objetivo === o.id
                            ? "border-primary bg-primary/10"
                            : "border-border hover:border-primary/40 hover:bg-muted/40",
                        )}
                      >
                        <div className="text-xs font-semibold">{o.label}</div>
                        <div className="text-[10px] text-muted-foreground line-clamp-1">
                          {o.descricao}
                        </div>
                      </button>
                    ))}
                  </div>
                </Section>

                {/* 2. Modelo visual */}
                <Section step={2} title="Modelo visual" desc="Como o email deve parecer?">
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {MODELOS.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => setModelo(m.id)}
                        className={cn(
                          "rounded-lg border p-2.5 text-left transition-all",
                          modelo === m.id
                            ? "border-primary bg-primary/10"
                            : "border-border hover:border-primary/40 hover:bg-muted/40",
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className="h-3 w-3 rounded-full"
                            style={{ background: m.cor }}
                          />
                          <span className="text-xs font-semibold">{m.label}</span>
                        </div>
                        <div className="text-[10px] text-muted-foreground line-clamp-1 mt-0.5">
                          {m.descricao}
                        </div>
                      </button>
                    ))}
                  </div>
                </Section>

                {/* 3. Imagens do e-mail */}
                <Section
                  step={3}
                  title="Imagens do e-mail"
                  desc="Logo, banner principal e imagens opcionais. Faça upload ou cole uma URL."
                >
                  <div className="space-y-4">
                    <ImageField
                      label="Logo do e-mail"
                      hint="Exibida no topo, centralizada. Largura máxima 220px."
                      value={fields.logo_url || ""}
                      onChange={(v) => setFields((f) => ({ ...f, logo_url: v }))}
                      previewMaxWidth={220}
                    />
                    <ImageField
                      label="Banner principal (Hero)"
                      hint="Imagem grande abaixo da logo. Responsiva, largura 100% até 600px."
                      value={fields.hero_image_url || ""}
                      onChange={(v) => setFields((f) => ({ ...f, hero_image_url: v }))}
                      altValue={fields.hero_alt || ""}
                      onAltChange={(v) => setFields((f) => ({ ...f, hero_alt: v }))}
                    />
                    <ImageField
                      label="Banner secundário (opcional)"
                      hint="Promoção extra, comunidade, cashback. Exibido antes do rodapé."
                      value={fields.secondary_image_url || ""}
                      onChange={(v) => setFields((f) => ({ ...f, secondary_image_url: v }))}
                      altValue={fields.secondary_alt || ""}
                      onAltChange={(v) => setFields((f) => ({ ...f, secondary_alt: v }))}
                      showToggle
                      toggleValue={fields.mostrar_banner_secundario !== false}
                      onToggleChange={(v) =>
                        setFields((f) => ({ ...f, mostrar_banner_secundario: v }))
                      }
                    />
                    <ImageField
                      label="Ícone do benefício (opcional)"
                      hint="Pequeno ícone exibido ao lado da linha de benefício."
                      value={fields.benefit_icon_url || ""}
                      onChange={(v) => setFields((f) => ({ ...f, benefit_icon_url: v }))}
                      previewMaxWidth={48}
                      showToggle
                      toggleValue={fields.mostrar_icone_beneficio !== false}
                      onToggleChange={(v) =>
                        setFields((f) => ({ ...f, mostrar_icone_beneficio: v }))
                      }
                    />
                  </div>
                </Section>

                {/* 4. Campos rápidos */}
                <Section step={4} title="Campos rápidos" desc="Edite o conteúdo. Clique nas variáveis abaixo para inserir.">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {QUICK_FIELDS.map((qf) => {
                      const isLong = qf.key === "texto";
                      const val =
                        qf.key === "nome" || qf.key === "assunto" || qf.key === "preheader" || qf.key === "fromName"
                          ? (meta as any)[qf.key]
                          : (fields as any)[qf.key];
                      const set = (v: string) => {
                        if (
                          qf.key === "nome" ||
                          qf.key === "assunto" ||
                          qf.key === "preheader" ||
                          qf.key === "fromName"
                        ) {
                          setMeta((m) => ({ ...m, [qf.key]: v }));
                        } else {
                          setFields((f) => ({ ...f, [qf.key]: v }));
                        }
                      };
                      return (
                        <div
                          key={qf.key}
                          className={cn("space-y-1", isLong && "sm:col-span-2")}
                        >
                          <Label className="text-[11px] text-muted-foreground flex items-center gap-1">
                            {qf.label}
                            {activeField === qf.key && (
                              <Badge variant="outline" className="text-[9px] py-0 h-3.5 border-primary/40 text-primary">
                                ativo
                              </Badge>
                            )}
                          </Label>
                          {isLong ? (
                            <Textarea
                              ref={(el) => {
                                refs.current[qf.key] = el;
                              }}
                              value={val}
                              onFocus={() => setActiveField(qf.key)}
                              onChange={(e) => set(e.target.value)}
                              rows={4}
                              placeholder={qf.placeholder}
                              className="text-sm"
                            />
                          ) : (
                            <Input
                              ref={(el) => {
                                refs.current[qf.key] = el;
                              }}
                              value={val}
                              onFocus={() => setActiveField(qf.key)}
                              onChange={(e) => set(e.target.value)}
                              placeholder={qf.placeholder}
                              className="text-sm"
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </Section>

                {/* Variáveis clicáveis */}
                <Section step={5} title="Variáveis" desc="Clique para inserir no campo ativo.">
                  <div className="flex flex-wrap gap-1.5">
                    {VARIAVEIS.map((v) => (
                      <Badge
                        key={v}
                        variant="outline"
                        className="text-[11px] cursor-pointer hover:bg-primary hover:text-primary-foreground font-mono"
                        onClick={() => insertVariable(v)}
                      >
                        <Variable className="h-3 w-3 mr-1" />
                        {v}
                      </Badge>
                    ))}
                  </div>
                </Section>
              </>
            )}

            {advanced && (
              <Section
                step={1}
                title="HTML avançado"
                desc="Edite o HTML diretamente. Variáveis {token} são substituídas no envio."
              >
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground">Nome</Label>
                    <Input value={meta.nome} onChange={(e) => setMeta((m) => ({ ...m, nome: e.target.value }))} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground">Assunto</Label>
                    <Input value={meta.assunto} onChange={(e) => setMeta((m) => ({ ...m, assunto: e.target.value }))} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground">Pré-header</Label>
                    <Input value={meta.preheader} onChange={(e) => setMeta((m) => ({ ...m, preheader: e.target.value }))} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground">Remetente</Label>
                    <Input value={meta.fromName} onChange={(e) => setMeta((m) => ({ ...m, fromName: e.target.value }))} />
                  </div>
                </div>
                <Textarea
                  value={customHtml}
                  onChange={(e) => setCustomHtml(e.target.value)}
                  rows={20}
                  className="font-mono text-xs"
                  placeholder="<!doctype html>..."
                />
              </Section>
            )}
          </div>

          {/* ============== DIREITA (preview) ============== */}
          <div className="col-span-12 lg:col-span-5 border-l border-border/50 bg-muted/20 overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Eye className="h-3.5 w-3.5" /> Preview ao vivo
              </div>
              <div className="flex rounded-md border border-border overflow-hidden">
                <button
                  type="button"
                  className={cn(
                    "px-2 py-1 text-xs flex items-center gap-1",
                    previewDevice === "desktop"
                      ? "bg-primary/15 text-primary"
                      : "text-muted-foreground",
                  )}
                  onClick={() => setPreviewDevice("desktop")}
                >
                  <Monitor className="h-3 w-3" /> Desktop
                </button>
                <button
                  type="button"
                  className={cn(
                    "px-2 py-1 text-xs flex items-center gap-1",
                    previewDevice === "mobile"
                      ? "bg-primary/15 text-primary"
                      : "text-muted-foreground",
                  )}
                  onClick={() => setPreviewDevice("mobile")}
                >
                  <Smartphone className="h-3 w-3" /> Mobile
                </button>
              </div>
            </div>

            {/* Cabeçalho simulado */}
            <div className="px-4 py-2 border-b border-border/50 bg-background/40 text-[11px] space-y-0.5">
              <div className="text-foreground font-semibold truncate">
                {meta.assunto || "(sem assunto)"}
              </div>
              <div className="text-muted-foreground truncate">
                <span className="font-medium">{meta.fromName || "—"}</span>{" "}
                <span className="opacity-70">— {meta.preheader || "(sem pré-header)"}</span>
              </div>
            </div>

            <div className="flex-1 overflow-auto p-4 flex justify-center">
              <div
                className="bg-white rounded-md shadow-sm overflow-hidden transition-all"
                style={{
                  width: previewDevice === "mobile" ? 360 : "100%",
                  maxWidth: previewDevice === "mobile" ? 360 : 640,
                }}
              >
                <iframe
                  title="email-preview"
                  srcDoc={htmlPreview}
                  className="w-full"
                  style={{ height: previewDevice === "mobile" ? 640 : 720, border: 0 }}
                  sandbox=""
                />
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-3 border-t border-border/50 bg-background/60">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={salvar} className="gap-2">
            <CheckCircle2 className="h-4 w-4" /> Salvar template
          </Button>
        </div>

        {/* ====== Dialog: Templates prontos ====== */}
        <PresetsDialog
          open={presetsOpen}
          onOpenChange={setPresetsOpen}
          onPick={applyPreset}
        />

        {/* ====== Dialog: Gerar com IA ====== */}
        <AiDialog
          open={aiOpen}
          onOpenChange={setAiOpen}
          modelo={modelo}
          defaultLink={fields.link}
          defaultCupom={fields.cupom}
          onResult={(r) => {
            setMeta((m) => ({ ...m, assunto: r.assunto, preheader: r.preheader }));
            setFields((f) => ({ ...f, titulo: r.titulo, texto: r.texto, cta: r.cta }));
            setAdvanced(false);
            setAiOpen(false);
            toast.success("Conteúdo gerado pela IA");
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function Section({
  step,
  title,
  desc,
  children,
}: {
  step: number;
  title: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="h-5 w-5 rounded-full bg-primary/15 text-primary text-[11px] font-semibold flex items-center justify-center">
          {step}
        </span>
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      {desc && <p className="text-[11px] text-muted-foreground -mt-1 ml-7">{desc}</p>}
      <div className="ml-7">{children}</div>
    </div>
  );
}

// =====================================================
// Campo de imagem com upload + URL + preview
// =====================================================
function ImageField({
  label,
  hint,
  value,
  onChange,
  altValue,
  onAltChange,
  previewMaxWidth = 600,
  showToggle,
  toggleValue,
  onToggleChange,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  altValue?: string;
  onAltChange?: (v: string) => void;
  previewMaxWidth?: number;
  showToggle?: boolean;
  toggleValue?: boolean;
  onToggleChange?: (v: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function handleFile(file: File) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Imagem muito grande (máx 5MB)");
      return;
    }
    setUploading(true);
    try {
      const ext = file.name.split(".").pop()?.toLowerCase() || "png";
      const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const { error } = await supabase.storage
        .from("email-images")
        .upload(path, file, { contentType: file.type, upsert: false });
      if (error) throw error;
      const { data } = supabase.storage.from("email-images").getPublicUrl(path);
      onChange(data.publicUrl);
      toast.success("Imagem enviada");
    } catch (e: any) {
      toast.error(e?.message || "Falha no upload");
    } finally {
      setUploading(false);
    }
  }

  const disabled = showToggle && toggleValue === false;

  return (
    <div className="rounded-lg border border-border/60 p-3 space-y-2 bg-muted/20">
      <div className="flex items-center justify-between gap-2">
        <div>
          <Label className="text-xs font-semibold flex items-center gap-1.5">
            <ImageIcon className="h-3.5 w-3.5 text-primary" />
            {label}
          </Label>
          {hint && <p className="text-[10px] text-muted-foreground mt-0.5">{hint}</p>}
        </div>
        {showToggle && (
          <button
            type="button"
            onClick={() => onToggleChange?.(!toggleValue)}
            className={cn(
              "h-5 w-9 rounded-full transition-colors relative shrink-0",
              toggleValue ? "bg-primary" : "bg-muted",
            )}
            title={toggleValue ? "Exibindo" : "Oculto"}
          >
            <span
              className={cn(
                "absolute top-0.5 h-4 w-4 rounded-full bg-background shadow transition-transform",
                toggleValue ? "translate-x-4" : "translate-x-0.5",
              )}
            />
          </button>
        )}
      </div>

      <div className={cn("space-y-2", disabled && "opacity-50 pointer-events-none")}>
        <div className="flex gap-2">
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Cole a URL da imagem ou faça upload"
            className="text-xs flex-1"
          />
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
              e.target.value = "";
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
            className="gap-1.5 shrink-0"
          >
            {uploading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            Enviar
          </Button>
          {value && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => onChange("")}
              className="gap-1.5 shrink-0 text-destructive hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>

        {onAltChange && (
          <Input
            value={altValue || ""}
            onChange={(e) => onAltChange(e.target.value)}
            placeholder="Alt text (descrição da imagem)"
            className="text-xs"
          />
        )}

        {value && (
          <div className="rounded-md border border-border/60 bg-background p-2 flex justify-center">
            <img
              src={value}
              alt={altValue || label}
              style={{ maxWidth: previewMaxWidth, width: "100%", height: "auto", display: "block" }}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.opacity = "0.3";
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// =====================================================
// Templates prontos
// =====================================================
function PresetsDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onPick: (p: PresetTemplate) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LayoutTemplate className="h-4 w-4 text-primary" /> Templates prontos
          </DialogTitle>
          <DialogDescription>Comece a partir de um modelo já configurado.</DialogDescription>
        </DialogHeader>
        <div className="overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-3 pr-1">
          {TEMPLATES_PRONTOS.map((p) => {
            const m = MODELOS.find((x) => x.id === p.modelo);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onPick(p)}
                className="text-left rounded-lg border border-border hover:border-primary/50 hover:bg-muted/40 p-3 transition-all"
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: m?.cor }} />
                  <span className="text-sm font-semibold">{p.nome}</span>
                </div>
                <div className="text-[11px] text-muted-foreground line-clamp-2 mb-2">
                  {p.assunto}
                </div>
                <div className="flex flex-wrap gap-1">
                  <Badge variant="outline" className="text-[9px]">
                    {m?.label}
                  </Badge>
                  {p.tags.map((t) => (
                    <Badge key={t} variant="outline" className="text-[9px] text-accent border-accent/30">
                      #{t}
                    </Badge>
                  ))}
                </div>
              </button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// =====================================================
// Gerar com IA
// =====================================================
function AiDialog({
  open,
  onOpenChange,
  modelo,
  defaultLink,
  defaultCupom,
  onResult,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  modelo: ModeloId;
  defaultLink: string;
  defaultCupom: string;
  onResult: (r: { assunto: string; preheader: string; titulo: string; texto: string; cta: string }) => void;
}) {
  const [gatilho, setGatilho] = useState("");
  const [beneficio, setBeneficio] = useState("");
  const [tom, setTom] = useState<(typeof TOM_OPCOES)[number]["id"]>("amigavel");
  const [link, setLink] = useState(defaultLink || "{link_login}");
  const [cupom, setCupom] = useState(defaultCupom || "");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setLink(defaultLink || "{link_login}");
      setCupom(defaultCupom || "");
    }
  }, [open, defaultLink, defaultCupom]);

  const generate = useServerFn(generateEmailContent);

  async function go() {
    if (!gatilho.trim()) {
      toast.error("Descreva o gatilho ou contexto");
      return;
    }
    setLoading(true);
    try {
      const r = await generate({
        data: { gatilho, beneficio, tom, link, cupom, modelo },
      });
      onResult(r);
    } catch (e: any) {
      toast.error(e?.message || "Falha ao gerar conteúdo");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" /> Gerar com IA
          </DialogTitle>
          <DialogDescription>A IA escreve assunto, pré-header, título, texto e CTA.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">Gatilho / contexto</Label>
            <Textarea
              rows={2}
              placeholder="Ex: Lead VIP parou de jogar há 7 dias"
              value={gatilho}
              onChange={(e) => setGatilho(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">Benefício / oferta</Label>
            <Input
              placeholder="Ex: Bônus de 100% no próximo depósito"
              value={beneficio}
              onChange={(e) => setBeneficio(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">Tom da mensagem</Label>
              <Select value={tom} onValueChange={(v) => setTom(v as any)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TOM_OPCOES.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">Cupom (opcional)</Label>
              <Input value={cupom} onChange={(e) => setCupom(e.target.value)} placeholder="Ex: VOLTA50" />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">Link do botão</Label>
            <Input value={link} onChange={(e) => setLink(e.target.value)} />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancelar
          </Button>
          <Button onClick={go} disabled={loading} className="gap-2">
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Gerando...
              </>
            ) : (
              <>
                <Wand2 className="h-4 w-4" /> Gerar
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
