// Popups nas casas — tipos e validação compartilhados entre o CRM (editor),
// o servidor e o endpoint público. Sem imports `.server`.
import { z } from "zod";

import type { Json } from "@/integrations/supabase/types";

export const POPUP_STATUSES = ["rascunho", "ativo", "pausado", "encerrado"] as const;
export type PopupStatus = (typeof POPUP_STATUSES)[number];

export const POPUP_FORMATS = ["central", "rodape", "canto"] as const;
export type PopupFormat = (typeof POPUP_FORMATS)[number];

export const POPUP_AUDIENCE_KINDS = ["todos", "logados", "deslogados", "filtro"] as const;
export type PopupAudienceKind = (typeof POPUP_AUDIENCE_KINDS)[number];

export const POPUP_PAGE_MODES = ["todas", "incluir", "excluir"] as const;
export type PopupPageMode = (typeof POPUP_PAGE_MODES)[number];

export const POPUP_FREQUENCIES = ["sessao", "dia", "n_dias", "ate_clicar"] as const;
export type PopupFrequency = (typeof POPUP_FREQUENCIES)[number];

export const POPUP_FORMAT_LABELS: Record<PopupFormat, string> = {
  central: "Janela no meio da tela",
  rodape: "Faixa no rodapé",
  canto: "Cartão no canto",
};

export const POPUP_AUDIENCE_LABELS: Record<PopupAudienceKind, string> = {
  todos: "Todos os visitantes",
  logados: "Só jogadores logados",
  deslogados: "Só visitantes não logados",
  filtro: "Um público do CRM",
};

export const POPUP_PAGE_MODE_LABELS: Record<PopupPageMode, string> = {
  todas: "Em todas as páginas",
  incluir: "Só nas páginas listadas",
  excluir: "Em todas, menos nas listadas",
};

export const POPUP_FREQUENCY_LABELS: Record<PopupFrequency, string> = {
  sessao: "Uma vez por visita",
  dia: "Uma vez por dia",
  n_dias: "Uma vez a cada N dias",
  ate_clicar: "Em toda visita, até a pessoa clicar no botão",
};

export const POPUP_STATUS_LABELS: Record<PopupStatus, string> = {
  rascunho: "Rascunho",
  ativo: "Ativo",
  pausado: "Pausado",
  encerrado: "Encerrado",
};

export const POPUP_LIMITS = {
  nome: 120,
  titulo: 80,
  texto: 400,
  botaoLabel: 40,
  url: 2000,
  paginas: 50,
  pagina: 200,
} as const;

/** Content + rules the house edits. Mirrors the site_popups columns. */
export type PopupDraft = {
  nome: string;
  prioridade: number;
  startsAt: string | null;
  endsAt: string | null;
  formato: PopupFormat;
  imageUrl: string | null;
  titulo: string | null;
  texto: string | null;
  botaoLabel: string | null;
  botaoUrl: string | null;
  audienceKind: PopupAudienceKind;
  audienceLabel: string | null;
  audienceCriteria: Json | null;
  paginasModo: PopupPageMode;
  paginas: string[];
  atrasoSegundos: number;
  frequencia: PopupFrequency;
  frequenciaDias: number | null;
};

export const EMPTY_POPUP_DRAFT: PopupDraft = {
  nome: "",
  prioridade: 0,
  startsAt: null,
  endsAt: null,
  formato: "central",
  imageUrl: null,
  titulo: null,
  texto: null,
  botaoLabel: null,
  botaoUrl: null,
  audienceKind: "todos",
  audienceLabel: null,
  audienceCriteria: null,
  paginasModo: "todas",
  paginas: [],
  atrasoSegundos: 3,
  frequencia: "dia",
  frequenciaDias: null,
};

/** Trims; empty → null. */
function blankToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : null;
}

/** Only absolute https URLs (images and button links run on the house's domain). */
export function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Normalizes a page pattern typed by the house into a path: accepts a full
 * URL ("https://casa.bet/cassino" → "/cassino"), adds the leading slash,
 * drops query/hash and a trailing slash (except the root). A trailing `*`
 * means "this path and everything below it". Returns null when nothing is left.
 */
export function normalizePagePattern(raw: string): string | null {
  let value = (raw ?? "").trim();
  if (!value) return null;
  const wildcard = value.endsWith("*");
  if (wildcard) value = value.slice(0, -1);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      value = new URL(value).pathname;
    } catch {
      return null;
    }
  }
  value = value.split(/[?#]/)[0]!.trim();
  if (!value.startsWith("/")) value = `/${value}`;
  value = value.replace(/\/{2,}/g, "/");
  if (value.length > 1 && value.endsWith("/")) value = value.slice(0, -1);
  if (/\s/.test(value)) return null;
  if (wildcard) return value === "/" ? "/*" : `${value}/*`;
  return value;
}

export type PopupValidation = { ok: true; draft: PopupDraft } | { ok: false; error: string };

/** Cleans and validates what the editor sends, with messages for the house. */
export function validatePopupDraft(input: PopupDraft): PopupValidation {
  const nome = (input.nome ?? "").trim();
  if (!nome) return { ok: false, error: "Dê um nome ao popup." };
  if (nome.length > POPUP_LIMITS.nome) return { ok: false, error: "O nome está longo demais." };

  const titulo = blankToNull(input.titulo);
  const texto = blankToNull(input.texto);
  const imageUrl = blankToNull(input.imageUrl);
  const botaoLabel = blankToNull(input.botaoLabel);
  const botaoUrl = blankToNull(input.botaoUrl);

  if (!titulo && !imageUrl) return { ok: false, error: "Coloque um título ou uma imagem." };
  if (titulo && titulo.length > POPUP_LIMITS.titulo)
    return { ok: false, error: `O título pode ter até ${POPUP_LIMITS.titulo} caracteres.` };
  if (texto && texto.length > POPUP_LIMITS.texto)
    return { ok: false, error: `O texto pode ter até ${POPUP_LIMITS.texto} caracteres.` };
  if (imageUrl && (!isHttpsUrl(imageUrl) || imageUrl.length > POPUP_LIMITS.url))
    return { ok: false, error: "O endereço da imagem precisa começar com https://." };
  if (Boolean(botaoLabel) !== Boolean(botaoUrl))
    return { ok: false, error: "Preencha o texto e o link do botão, ou deixe os dois vazios." };
  if (botaoLabel && botaoLabel.length > POPUP_LIMITS.botaoLabel)
    return { ok: false, error: `O texto do botão pode ter até ${POPUP_LIMITS.botaoLabel} caracteres.` };
  if (botaoUrl && (!isHttpsUrl(botaoUrl) || botaoUrl.length > POPUP_LIMITS.url))
    return { ok: false, error: "O link do botão precisa começar com https://." };

  if (input.audienceKind === "filtro" && (input.audienceCriteria === null || input.audienceCriteria === undefined))
    return { ok: false, error: "Escolha o público do CRM." };

  const paginas: string[] = [];
  if (input.paginasModo !== "todas") {
    for (const raw of input.paginas ?? []) {
      if ((raw ?? "").length > POPUP_LIMITS.pagina) return { ok: false, error: "Um dos endereços de página está longo demais." };
      const normalized = normalizePagePattern(raw);
      if (normalized && !paginas.includes(normalized)) paginas.push(normalized);
    }
    if (paginas.length === 0) return { ok: false, error: "Liste pelo menos uma página." };
    if (paginas.length > POPUP_LIMITS.paginas)
      return { ok: false, error: `Liste no máximo ${POPUP_LIMITS.paginas} páginas.` };
  }

  const prioridade = Math.trunc(Number(input.prioridade));
  if (!Number.isFinite(prioridade) || prioridade < 0 || prioridade > 1000)
    return { ok: false, error: "A prioridade vai de 0 a 1000." };
  const atraso = Math.trunc(Number(input.atrasoSegundos));
  if (!Number.isFinite(atraso) || atraso < 0 || atraso > 120)
    return { ok: false, error: "O tempo para aparecer vai de 0 a 120 segundos." };

  let frequenciaDias: number | null = null;
  if (input.frequencia === "n_dias") {
    frequenciaDias = Math.trunc(Number(input.frequenciaDias));
    if (!Number.isFinite(frequenciaDias) || frequenciaDias < 1 || frequenciaDias > 90)
      return { ok: false, error: "O intervalo vai de 1 a 90 dias." };
  }

  const startsAt = blankToNull(input.startsAt);
  const endsAt = blankToNull(input.endsAt);
  if (startsAt && Number.isNaN(Date.parse(startsAt))) return { ok: false, error: "Data de início inválida." };
  if (endsAt && Number.isNaN(Date.parse(endsAt))) return { ok: false, error: "Data de fim inválida." };
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt))
    return { ok: false, error: "O fim precisa ser depois do início." };

  return {
    ok: true,
    draft: {
      nome,
      prioridade,
      startsAt,
      endsAt,
      formato: input.formato,
      imageUrl,
      titulo,
      texto,
      botaoLabel,
      botaoUrl,
      audienceKind: input.audienceKind,
      audienceLabel: input.audienceKind === "filtro" ? blankToNull(input.audienceLabel) : null,
      audienceCriteria: input.audienceKind === "filtro" ? (input.audienceCriteria ?? null) : null,
      paginasModo: input.paginasModo,
      paginas,
      atrasoSegundos: atraso,
      frequencia: input.frequencia,
      frequenciaDias,
    },
  };
}

export const popupDraftInput = z.object({
  nome: z.string().max(500),
  prioridade: z.number(),
  startsAt: z.string().max(64).nullable(),
  endsAt: z.string().max(64).nullable(),
  formato: z.enum(POPUP_FORMATS),
  imageUrl: z.string().max(4000).nullable(),
  titulo: z.string().max(1000).nullable(),
  texto: z.string().max(4000).nullable(),
  botaoLabel: z.string().max(500).nullable(),
  botaoUrl: z.string().max(4000).nullable(),
  audienceKind: z.enum(POPUP_AUDIENCE_KINDS),
  audienceLabel: z.string().max(500).nullable(),
  audienceCriteria: z.unknown(),
  paginasModo: z.enum(POPUP_PAGE_MODES),
  paginas: z.array(z.string().max(1000)).max(200),
  atrasoSegundos: z.number(),
  frequencia: z.enum(POPUP_FREQUENCIES),
  frequenciaDias: z.number().nullable(),
});

/** What the public endpoint sends to the site: content and client-side rules only. */
export type PublicPopup = {
  id: string;
  formato: PopupFormat;
  imageUrl: string | null;
  titulo: string | null;
  texto: string | null;
  botaoLabel: string | null;
  botaoUrl: string | null;
  paginasModo: PopupPageMode;
  paginas: string[];
  atrasoSegundos: number;
  frequencia: PopupFrequency;
  frequenciaDias: number | null;
  prioridade: number;
};
