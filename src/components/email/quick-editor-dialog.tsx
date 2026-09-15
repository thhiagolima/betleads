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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  CheckCircle2,
  Eye,
  Monitor,
  Smartphone,
  Upload,
  Loader2,
  Trash2,
  Image as ImageIcon,
  Wand2,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { EditorTemplate } from "./template-editor-dialog";

// Modelos pedidos pela operação BETLEADS
export const QUICK_MODELOS = [
  { id: "retorno", label: "Retorno" },
  { id: "vip", label: "VIP" },
  { id: "conversao", label: "Conversão" },
  { id: "dinheiro_parado", label: "Dinheiro parado" },
  { id: "primeiro_deposito", label: "Primeiro depósito" },
  { id: "relacionamento", label: "Relacionamento" },
] as const;

export type QuickModelo = (typeof QUICK_MODELOS)[number]["id"];

export type QuickState = {
  nome: string;
  modelo: QuickModelo;
  objetivo: string;
  assunto: string;
  preheader: string;
  fromName: string;
  logoUrl: string;
  bannerUrl: string;
  bannerAlt: string;
  titulo: string;
  saudacao: string;
  texto: string;
  textoSecundario: string;
  cupom: string;
  beneficio: string;
  ctaTexto: string;
  ctaUrl: string;
  linkAlternativo: string;
  textoUrgencia: string;
  rodape: string;
  // visual
  bgGeral: string;
  bgContainer: string;
  corTexto: string;
  corTextoSecundario: string;
  corDestaque: string;
  corBotao: string;
  corBotaoTexto: string;
  corBordaCard: string;
  mostrarCard: boolean;
  mostrarBlocoExtra: boolean;
  mostrarLinkAlternativo: boolean;
  mostrarUrgencia: boolean;
};

const DEFAULTS: Record<QuickModelo, Partial<QuickState>> = {
  retorno: {
    objetivo: "Trazer o lead de volta para a plataforma",
    titulo: "Sentimos sua falta, {primeiro_nome}",
    saudacao: "Olá, {primeiro_nome}",
    texto: "Notamos que faz um tempo que você não acessa. Sua conta continua ativa e com benefícios prontos para retorno imediato.",
    textoSecundario: "Volte hoje e aproveite a melhor condição da semana.",
    cupom: "VOLTOU",
    beneficio: "Cashback liberado para o seu retorno",
    ctaTexto: "Voltar para minha conta",
    textoUrgencia: "Oferta válida apenas hoje",
  },
  vip: {
    objetivo: "Reforçar relacionamento com lead VIP",
    titulo: "Sua área VIP, {primeiro_nome}",
    saudacao: "Olá, {primeiro_nome}",
    texto: "Como membro VIP, você tem acesso a condições exclusivas, suporte prioritário e benefícios diferenciados.",
    textoSecundario: "Continue aproveitando o que preparamos só para você.",
    cupom: "",
    beneficio: "Bônus VIP + cashback ampliado",
    ctaTexto: "Acessar área VIP",
    textoUrgencia: "Benefícios disponíveis somente para membros VIP",
  },
  conversao: {
    objetivo: "Converter lead em depósito",
    titulo: "Sua condição está liberada, {primeiro_nome}",
    saudacao: "Olá, {primeiro_nome}",
    texto: "Liberamos uma condição especial para você ativar agora. Aproveite enquanto está disponível.",
    textoSecundario: "Quanto antes ativar, melhor a condição.",
    cupom: "ATIVAR",
    beneficio: "+100% no próximo depósito",
    ctaTexto: "Ativar agora",
    textoUrgencia: "Condição expira em 24h",
  },
  dinheiro_parado: {
    objetivo: "Reativar lead com saldo disponível",
    titulo: "Você tem saldo esperando, {primeiro_nome}",
    saudacao: "Olá, {primeiro_nome}",
    texto: "Identificamos que seu saldo está disponível e sem movimentação. Que tal voltar e usar o que é seu?",
    textoSecundario: "Seu saldo continua disponível para uso imediato.",
    cupom: "",
    beneficio: "Saldo disponível: R$ {saldo}",
    ctaTexto: "Usar meu saldo",
    textoUrgencia: "Saldo disponível para uso imediato",
  },
  primeiro_deposito: {
    objetivo: "Ativar primeiro depósito (FTD)",
    titulo: "Bem-vindo, {primeiro_nome}",
    saudacao: "Olá, {primeiro_nome}",
    texto: "Estamos felizes em ter você aqui. Faça seu primeiro depósito e desbloqueie um bônus especial de boas-vindas.",
    textoSecundario: "Comece com tudo. Aproveite o bônus de boas-vindas.",
    cupom: "PRIMEIRO",
    beneficio: "+100% no seu primeiro depósito",
    ctaTexto: "Fazer primeiro depósito",
    textoUrgencia: "Bônus de boas-vindas válido por 7 dias",
  },
  relacionamento: {
    objetivo: "Relacionamento e fidelização",
    titulo: "Um recado pra você, {primeiro_nome}",
    saudacao: "Olá, {primeiro_nome}",
    texto: "Queremos manter você sempre por perto. Por isso, preparamos novidades e benefícios pensados especialmente para o seu perfil.",
    textoSecundario: "Conte com a gente sempre que precisar.",
    cupom: "",
    beneficio: "Atendimento e benefícios exclusivos",
    ctaTexto: "Saber mais",
    textoUrgencia: "",
  },
};

function makeInitial(): QuickState {
  return {
    nome: "",
    modelo: "retorno",
    objetivo: DEFAULTS.retorno.objetivo || "",
    assunto: "{primeiro_nome}, sua conta está esperando você",
    preheader: "Volte hoje e aproveite o benefício liberado",
    fromName: "BETLEADS",
    logoUrl: "",
    bannerUrl: "",
    bannerAlt: "Banner",
    titulo: DEFAULTS.retorno.titulo || "",
    saudacao: DEFAULTS.retorno.saudacao || "",
    texto: DEFAULTS.retorno.texto || "",
    textoSecundario: DEFAULTS.retorno.textoSecundario || "",
    cupom: DEFAULTS.retorno.cupom || "",
    beneficio: DEFAULTS.retorno.beneficio || "",
    ctaTexto: DEFAULTS.retorno.ctaTexto || "Acessar",
    ctaUrl: "{link_login}",
    linkAlternativo: "Se o botão não funcionar, acesse: {link_login}",
    textoUrgencia: DEFAULTS.retorno.textoUrgencia || "",
    rodape:
      "Você está recebendo este e-mail porque é cadastrado na BETLEADS. Jogue com responsabilidade. +18.",
    bgGeral: "#0a0a0f",
    bgContainer: "#14141b",
    corTexto: "#f5f5f7",
    corTextoSecundario: "#a1a1aa",
    corDestaque: "#c9a84c",
    corBotao: "#c9a84c",
    corBotaoTexto: "#0a0a0f",
    corBordaCard: "#c9a84c",
    mostrarCard: true,
    mostrarBlocoExtra: true,
    mostrarLinkAlternativo: true,
    mostrarUrgencia: true,
  };
}

function esc(s: string) {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function escAttr(s: string) {
  return esc(s).replace(/'/g, "&#39;");
}

export function renderQuickHtml(s: QuickState): string {
  const texto = esc(s.texto).replace(/\n/g, "<br/>");
  const textoSec = esc(s.textoSecundario).replace(/\n/g, "<br/>");
  const logo = s.logoUrl.trim()
    ? `<tr><td align="center" style="padding:28px 24px 8px"><img src="${escAttr(s.logoUrl)}" alt="Logo" width="200" style="display:block;max-width:200px;width:100%;height:auto;border:0" /></td></tr>`
    : "";
  const banner = s.bannerUrl.trim()
    ? `<tr><td style="padding:12px 0 0"><img src="${escAttr(s.bannerUrl)}" alt="${escAttr(s.bannerAlt)}" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0" /></td></tr>`
    : "";
  const cardBeneficio = s.mostrarCard && (s.beneficio.trim() || s.cupom.trim())
    ? `<tr><td style="padding:8px 24px 16px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${s.corBordaCard};border-radius:12px;background:rgba(201,168,76,0.06)">
          <tr><td style="padding:18px 20px;text-align:center;font:600 16px/1.4 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:${s.corDestaque}">
            ${esc(s.beneficio) || "Benefício exclusivo"}
            ${
              s.cupom.trim()
                ? `<div style="margin-top:10px;display:inline-block;border:2px dashed ${s.corDestaque};border-radius:10px;padding:8px 16px;font:700 18px/1 -apple-system,Segoe UI,Roboto,Arial,sans-serif;letter-spacing:3px;color:${s.corDestaque}">${esc(s.cupom)}</div>`
                : ""
            }
          </td></tr>
        </table>
      </td></tr>`
    : "";
  const blocoExtra = s.mostrarBlocoExtra && textoSec
    ? `<tr><td style="padding:0 24px 16px;font:400 14px/1.6 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:${s.corTextoSecundario};text-align:center">
        ${textoSec}
      </td></tr>`
    : "";
  const linkAlt = s.mostrarLinkAlternativo && s.linkAlternativo.trim()
    ? `<tr><td style="padding:6px 24px 18px;font:400 11px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:${s.corTextoSecundario};text-align:center">
        ${esc(s.linkAlternativo)}
      </td></tr>`
    : "";
  const urgencia = s.mostrarUrgencia && s.textoUrgencia.trim()
    ? `<tr><td style="padding:0 24px 18px;text-align:center">
        <span style="display:inline-block;padding:6px 12px;border-radius:999px;background:rgba(239,68,68,0.12);color:#fecaca;font:600 11px/1 -apple-system,Segoe UI,Roboto,Arial,sans-serif;letter-spacing:1px;text-transform:uppercase">⚠ ${esc(s.textoUrgencia)}</span>
      </td></tr>`
    : "";

  return `<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${esc(s.assunto)}</title></head>
<body style="margin:0;padding:0;background:${s.bgGeral};font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">
<div style="display:none;font-size:1px;color:${s.bgGeral};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">${esc(s.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${s.bgGeral};padding:24px 12px">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${s.bgContainer};border-radius:14px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,.35)">
      ${logo}
      ${banner}
      <tr><td style="padding:24px 24px 6px;font:600 14px/1.4 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:${s.corTextoSecundario};text-align:center">
        ${esc(s.saudacao) || "Olá, {primeiro_nome}"}
      </td></tr>
      <tr><td style="padding:6px 24px 12px;font:700 24px/1.25 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:${s.corTexto};text-align:center">
        ${esc(s.titulo) || "Título principal"}
      </td></tr>
      <tr><td style="padding:6px 24px 18px;font:400 15px/1.6 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:${s.corTexto};text-align:center">
        ${texto}
      </td></tr>
      ${cardBeneficio}
      <tr><td align="center" style="padding:6px 24px 22px">
        <a href="${escAttr(s.ctaUrl)}" style="display:inline-block;background:${s.corBotao};color:${s.corBotaoTexto};text-decoration:none;font:700 15px/1 -apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:14px 30px;border-radius:10px">
          ${esc(s.ctaTexto) || "Acessar"}
        </a>
      </td></tr>
      ${linkAlt}
      ${blocoExtra}
      ${urgencia}
      <tr><td style="padding:18px 24px 22px;border-top:1px solid rgba(255,255,255,0.08);text-align:center;font:400 11px/1.6 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:${s.corTextoSecundario}">
        ${esc(s.rodape)}<br/>
        <a href="{link_descadastro}" style="color:${s.corTextoSecundario};text-decoration:underline">Descadastrar</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

export function QuickEditorDialog({
  open,
  onOpenChange,
  editing,
  onSave,
  onOpenAdvanced,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: EditorTemplate | null;
  onSave: (t: EditorTemplate) => void;
  onOpenAdvanced?: (corpoHtml: string, state: QuickState) => void;
}) {
  const [state, setState] = useState<QuickState>(makeInitial());
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");

  useEffect(() => {
    if (!open || !editing) return;
    const init = makeInitial();
    setState({
      ...init,
      nome: editing.nome || init.nome,
      assunto: editing.assunto || init.assunto,
      preheader: editing.preheader || init.preheader,
      fromName: editing.fromName || init.fromName,
    });
  }, [open, editing]);

  function set<K extends keyof QuickState>(key: K, value: QuickState[K]) {
    setState((s) => ({ ...s, [key]: value }));
  }

  function changeModelo(m: QuickModelo) {
    setState((s) => ({ ...s, modelo: m, ...DEFAULTS[m] } as QuickState));
  }

  const html = useMemo(() => renderQuickHtml(state), [state]);

  function salvar() {
    if (!editing) return;
    if (!state.nome.trim()) {
      toast.error("Dê um nome para o template");
      return;
    }
    onSave({
      ...editing,
      nome: state.nome,
      assunto: state.assunto,
      preheader: state.preheader,
      fromName: state.fromName,
      corpo: html,
      categoria: editing.categoria || "Geral",
      tags: editing.tags ?? [],
      ativo: editing.ativo ?? true,
      atualizadoEm: "agora",
    });
  }

  function abrirAvancado() {
    onOpenAdvanced?.(html, state);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[1200px] w-[95vw] max-h-[92vh] overflow-hidden p-0">
        <DialogHeader className="px-6 py-4 border-b border-border/50">
          <DialogTitle className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-primary" />
            Editor Rápido BETLEADS
          </DialogTitle>
          <DialogDescription>
            Padrão Pixreals. Preencha os campos e veja o e-mail montar em tempo real.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-12 gap-0 max-h-[calc(92vh-150px)] overflow-hidden">
          {/* Form */}
          <div className="col-span-12 lg:col-span-7 overflow-y-auto p-6 space-y-6">
            <Block title="1. Identificação">
              <Grid2>
                <Field label="Nome do template">
                  <Input value={state.nome} onChange={(e) => set("nome", e.target.value)} placeholder="Ex: Retorno dia 1" />
                </Field>
                <Field label="Modelo do e-mail">
                  <Select value={state.modelo} onValueChange={(v) => changeModelo(v as QuickModelo)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {QUICK_MODELOS.map((m) => (
                        <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Objetivo do e-mail">
                  <Input value={state.objetivo} onChange={(e) => set("objetivo", e.target.value)} />
                </Field>
                <Field label="Nome do remetente">
                  <Input value={state.fromName} onChange={(e) => set("fromName", e.target.value)} />
                </Field>
                <Field label="Assunto" full>
                  <Input value={state.assunto} onChange={(e) => set("assunto", e.target.value)} />
                </Field>
                <Field label="Preheader" full>
                  <Input value={state.preheader} onChange={(e) => set("preheader", e.target.value)} />
                </Field>
              </Grid2>
            </Block>

            <Block title="2. Imagens">
              <div className="space-y-3">
                <ImageField label="Logo" value={state.logoUrl} onChange={(v) => set("logoUrl", v)} maxW={200} />
                <ImageField
                  label="Banner principal"
                  value={state.bannerUrl}
                  onChange={(v) => set("bannerUrl", v)}
                  altValue={state.bannerAlt}
                  onAltChange={(v) => set("bannerAlt", v)}
                />
              </div>
            </Block>

            <Block title="3. Conteúdo">
              <Grid2>
                <Field label="Saudação">
                  <Input value={state.saudacao} onChange={(e) => set("saudacao", e.target.value)} />
                </Field>
                <Field label="Título principal">
                  <Input value={state.titulo} onChange={(e) => set("titulo", e.target.value)} />
                </Field>
                <Field label="Texto principal" full>
                  <Textarea rows={4} value={state.texto} onChange={(e) => set("texto", e.target.value)} />
                </Field>
                <Field label="Texto secundário (bloco extra)" full>
                  <Textarea rows={2} value={state.textoSecundario} onChange={(e) => set("textoSecundario", e.target.value)} />
                </Field>
                <Field label="Benefício">
                  <Input value={state.beneficio} onChange={(e) => set("beneficio", e.target.value)} />
                </Field>
                <Field label="Cupom">
                  <Input value={state.cupom} onChange={(e) => set("cupom", e.target.value)} />
                </Field>
                <Field label="CTA — texto">
                  <Input value={state.ctaTexto} onChange={(e) => set("ctaTexto", e.target.value)} />
                </Field>
                <Field label="CTA — URL">
                  <Input value={state.ctaUrl} onChange={(e) => set("ctaUrl", e.target.value)} />
                </Field>
                <Field label="Link alternativo" full>
                  <Input value={state.linkAlternativo} onChange={(e) => set("linkAlternativo", e.target.value)} />
                </Field>
                <Field label="Texto de urgência" full>
                  <Input value={state.textoUrgencia} onChange={(e) => set("textoUrgencia", e.target.value)} />
                </Field>
                <Field label="Rodapé" full>
                  <Textarea rows={2} value={state.rodape} onChange={(e) => set("rodape", e.target.value)} />
                </Field>
              </Grid2>
            </Block>

            <Block title="4. Blocos visíveis">
              <div className="grid grid-cols-2 gap-3">
                <Toggle label="Card de benefício" value={state.mostrarCard} onChange={(v) => set("mostrarCard", v)} />
                <Toggle label="Bloco extra (texto secundário)" value={state.mostrarBlocoExtra} onChange={(v) => set("mostrarBlocoExtra", v)} />
                <Toggle label="Link alternativo" value={state.mostrarLinkAlternativo} onChange={(v) => set("mostrarLinkAlternativo", v)} />
                <Toggle label="Aviso de urgência" value={state.mostrarUrgencia} onChange={(v) => set("mostrarUrgencia", v)} />
              </div>
            </Block>

            <Block title="5. Cores">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <Color label="Fundo geral" value={state.bgGeral} onChange={(v) => set("bgGeral", v)} />
                <Color label="Fundo do container" value={state.bgContainer} onChange={(v) => set("bgContainer", v)} />
                <Color label="Texto principal" value={state.corTexto} onChange={(v) => set("corTexto", v)} />
                <Color label="Texto secundário" value={state.corTextoSecundario} onChange={(v) => set("corTextoSecundario", v)} />
                <Color label="Destaque" value={state.corDestaque} onChange={(v) => set("corDestaque", v)} />
                <Color label="Botão" value={state.corBotao} onChange={(v) => set("corBotao", v)} />
                <Color label="Texto do botão" value={state.corBotaoTexto} onChange={(v) => set("corBotaoTexto", v)} />
                <Color label="Borda do card" value={state.corBordaCard} onChange={(v) => set("corBordaCard", v)} />
              </div>
            </Block>
          </div>

          {/* Preview */}
          <div className="col-span-12 lg:col-span-5 border-l border-border/50 bg-muted/20 overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Eye className="h-3.5 w-3.5" /> Preview ao vivo
              </div>
              <div className="flex rounded-md border border-border overflow-hidden">
                <button
                  type="button"
                  className={cn("px-2 py-1 text-xs flex items-center gap-1", device === "desktop" ? "bg-primary/15 text-primary" : "text-muted-foreground")}
                  onClick={() => setDevice("desktop")}
                >
                  <Monitor className="h-3 w-3" /> Desktop
                </button>
                <button
                  type="button"
                  className={cn("px-2 py-1 text-xs flex items-center gap-1", device === "mobile" ? "bg-primary/15 text-primary" : "text-muted-foreground")}
                  onClick={() => setDevice("mobile")}
                >
                  <Smartphone className="h-3 w-3" /> Mobile
                </button>
              </div>
            </div>
            <div className="px-4 py-2 border-b border-border/50 bg-background/40 text-[11px] space-y-0.5">
              <div className="text-foreground font-semibold truncate">{state.assunto || "(sem assunto)"}</div>
              <div className="text-muted-foreground truncate">
                <span className="font-medium">{state.fromName || "—"}</span>{" "}
                <span className="opacity-70">— {state.preheader || "(sem pré-header)"}</span>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-4 flex justify-center">
              <div
                className="rounded-md shadow-sm overflow-hidden transition-all"
                style={{
                  width: device === "mobile" ? 360 : "100%",
                  maxWidth: device === "mobile" ? 360 : 640,
                  background: state.bgGeral,
                }}
              >
                <iframe
                  title="quick-preview"
                  srcDoc={html}
                  className="w-full"
                  style={{ height: device === "mobile" ? 720 : 820, border: 0 }}
                  sandbox=""
                />
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 px-6 py-3 border-t border-border/50 bg-background/60">
          <Button variant="outline" onClick={abrirAvancado} className="gap-2" disabled={!onOpenAdvanced}>
            <Wand2 className="h-4 w-4" /> Editar no modo avançado
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancelar</Button>
            <Button onClick={salvar} className="gap-2">
              <CheckCircle2 className="h-4 w-4" /> Salvar template
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// =============== UI helpers ===============

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div>{children}</div>
    </div>
  );
}

function Grid2({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{children}</div>;
}

function Field({ label, full, children }: { label: string; full?: boolean; children: React.ReactNode }) {
  return (
    <div className={cn("space-y-1", full && "sm:col-span-2")}>
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2 bg-muted/20">
      <span className="text-xs">{label}</span>
      <Switch checked={value} onCheckedChange={onChange} />
    </div>
  );
}

function Color({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-10 rounded-md border border-border bg-transparent cursor-pointer"
        />
        <Input value={value} onChange={(e) => onChange(e.target.value)} className="text-xs font-mono" />
      </div>
    </div>
  );
}

function ImageField({
  label,
  value,
  onChange,
  altValue,
  onAltChange,
  maxW = 600,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  altValue?: string;
  onAltChange?: (v: string) => void;
  maxW?: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function handleFile(file: File) {
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

  return (
    <div className="rounded-lg border border-border/60 p-3 space-y-2 bg-muted/20">
      <Label className="text-xs font-semibold flex items-center gap-1.5">
        <ImageIcon className="h-3.5 w-3.5 text-primary" />
        {label}
      </Label>
      <div className="flex gap-2">
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Cole a URL ou faça upload"
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
        <Button type="button" size="sm" variant="outline" disabled={uploading} onClick={() => inputRef.current?.click()} className="gap-1.5 shrink-0">
          {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          Enviar
        </Button>
        {value && (
          <Button type="button" size="sm" variant="ghost" onClick={() => onChange("")} className="shrink-0 text-destructive hover:text-destructive">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      {onAltChange && (
        <Input value={altValue || ""} onChange={(e) => onAltChange(e.target.value)} placeholder="Alt text" className="text-xs" />
      )}
      {value && (
        <div className="rounded-md border border-border/60 bg-background p-2 flex justify-center">
          <img src={value} alt={altValue || label} style={{ maxWidth: maxW, width: "100%", height: "auto", display: "block" }} />
        </div>
      )}
    </div>
  );
}