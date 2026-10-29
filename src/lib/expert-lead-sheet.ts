// Parte pura (sem I/O) da ficha do lead na Área do Expert: tipos da ficha e
// montagem da linha do tempo. Os dados vêm de
// src/lib/expert-lead-sheet.functions.ts.

import { CONTATO_LABEL, type ContatoResultado } from "@/lib/expert-lead-labels";
import type { LevelSlug } from "@/lib/player-level";
import type { PlayerSituation } from "@/lib/player-situation";

export type ExpertTimelineKind =
  | "deposito"
  | "saque"
  | "cashback"
  | "sms_casa"
  | "email_casa"
  | "link_expert"
  | "clique"
  | "contato"
  | "retorno";

export type ExpertTimelineItem = {
  id: string;
  kind: ExpertTimelineKind;
  at: string;
  titulo: string;
  detalhe: string | null;
  valor: number | null;
};

export type ExpertTimelineSources = {
  deposits: Array<{ id: string; valor: number; at: string }>;
  withdrawals: Array<{ id: string; valor: number; at: string }>;
  cashbacks: Array<{ id: string; valor: number; at: string }>;
  sms: Array<{ id: string; content: string | null; at: string }>;
  emails: Array<{ id: string; subject: string | null; at: string }>;
  /** Links do próprio expert; `clickedAt` = primeiro clique humano. */
  links: Array<{ id: string; oferta: string; at: string; clickedAt: string | null }>;
  contacts: Array<{ id: string; resultado: string; nota: string | null; at: string }>;
  /** Retornos do próprio expert; `at` = quando foi agendado, `dueDate` = aaaa-mm-dd. */
  followups: Array<{ id: string; dueDate: string; nota: string | null; at: string }>;
};

export type ExpertLeadSheet = {
  lead: {
    id: string;
    nome: string;
    telefone: string | null;
    nivel: LevelSlug;
    situacao: PlayerSituation;
    situacaoLabel: string;
    diasSemDepositar: number | null;
    totalDepositado: number;
    depositos: number;
    ticketMedio: number | null;
    ultimoDeposito: { valor: number; at: string } | null;
    totalSacado: number;
    origemAfiliadoDoExpert: boolean;
  };
  /** Cashbacks pagos e, à parte, o saldo de bônus atual (`bonus_atual`,
   * sem data) — este não é um benefício recebido. */
  beneficios: Array<{ tipo: "cashback" | "bonus_atual"; valor: number; at: string | null }>;
  timeline: ExpertTimelineItem[];
  claim: { expertNome: string; expiresAt: string; minha: boolean } | null;
  retornosPendentes: Array<{ id: string; dueDate: string; nota: string | null }>;
  podeAssumir: boolean;
  /** Janela de crédito por clique da casa (`expert_settings.click_window_hours`). */
  janelaHoras: number;
};

// ------------------------------------------------------------- masking

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
// Link curto sem esquema: "bmkt.click/abc", "sub.dominio.com.br/x".
const BARE_LINK_RE = /\b(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\/\S*/g;
const CPF_FORMATTED_RE = /(?<!\d)\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)/g;
const CPF_DIGITS_RE = /(?<!\d)\d{11}(?!\d)/g;

// Mesmo número que `brl()` de template-vars.server.ts produz, sem o "R$".
const brlNumber = new Intl.NumberFormat("pt-BR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Mascara, no servidor, o texto já renderizado de um SMS/e-mail da casa antes
 * de ele ir para o expert: os modelos da casa podem conter {email}, {saldo},
 * {saldo_atual} e o link pessoal do lead. Troca links por "[link]", e-mails
 * por "[e-mail]", CPFs (formatado ou 11 dígitos seguidos) por "[cpf]" e cada
 * valor de saldo informado — no formato de `template-vars.server.ts`
 * ("R$ 1.234,56", com ou sem "R$") — por "[saldo]". O resto fica intacto.
 */
export function maskHouseMessageText(
  text: string | null,
  options: { saldoValues?: number[] } = {},
): string | null {
  if (text == null) return null;
  let masked = text
    .replace(EMAIL_RE, "[e-mail]")
    .replace(URL_RE, "[link]")
    .replace(BARE_LINK_RE, "[link]")
    .replace(CPF_FORMATTED_RE, "[cpf]")
    .replace(CPF_DIGITS_RE, "[cpf]");

  const amounts = new Set(
    (options.saldoValues ?? [])
      .filter((v) => Number.isFinite(v))
      .map((v) => brlNumber.format(Math.abs(v))),
  );
  for (const amount of amounts) {
    const re = new RegExp(
      String.raw`-?(?:R\$\s*)?-?(?<![\d.,])${escapeRegExp(amount)}(?!\d|[.,]\d)`,
      "g",
    );
    masked = masked.replace(re, "[saldo]");
  }
  return masked;
}

const SMS_DETAIL_MAX = 160;

function truncate(text: string | null, max: number): string | null {
  if (text == null) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** "2026-10-30" -> "30/10/2026", sem passar por Date (evita deslocar o dia pelo fuso). */
function formatDueDate(dueDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dueDate);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : dueDate;
}

function contatoLabel(resultado: string): string {
  return CONTATO_LABEL[resultado as ContatoResultado] ?? resultado;
}

export function buildExpertTimeline(
  sources: ExpertTimelineSources,
  limit = 60,
): ExpertTimelineItem[] {
  const items: ExpertTimelineItem[] = [];

  for (const d of sources.deposits) {
    items.push({
      id: `deposito:${d.id}`,
      kind: "deposito",
      at: d.at,
      titulo: "Depósito",
      detalhe: null,
      valor: d.valor,
    });
  }
  for (const w of sources.withdrawals) {
    items.push({
      id: `saque:${w.id}`,
      kind: "saque",
      at: w.at,
      titulo: "Saque",
      detalhe: null,
      valor: w.valor,
    });
  }
  for (const c of sources.cashbacks) {
    items.push({
      id: `cashback:${c.id}`,
      kind: "cashback",
      at: c.at,
      titulo: "Cashback",
      detalhe: null,
      valor: c.valor,
    });
  }
  for (const s of sources.sms) {
    items.push({
      id: `sms_casa:${s.id}`,
      kind: "sms_casa",
      at: s.at,
      titulo: "SMS da casa",
      detalhe: truncate(s.content, SMS_DETAIL_MAX),
      valor: null,
    });
  }
  for (const e of sources.emails) {
    items.push({
      id: `email_casa:${e.id}`,
      kind: "email_casa",
      at: e.at,
      titulo: "E-mail da casa",
      detalhe: e.subject,
      valor: null,
    });
  }
  for (const l of sources.links) {
    items.push({
      id: `link_expert:${l.id}`,
      kind: "link_expert",
      at: l.at,
      titulo: `Você enviou o link "${l.oferta}"`,
      detalhe: null,
      valor: null,
    });
    if (l.clickedAt) {
      items.push({
        id: `clique:${l.id}`,
        kind: "clique",
        at: l.clickedAt,
        titulo: `Clicou no link "${l.oferta}"`,
        detalhe: null,
        valor: null,
      });
    }
  }
  for (const c of sources.contacts) {
    items.push({
      id: `contato:${c.id}`,
      kind: "contato",
      at: c.at,
      titulo: `Contato: ${contatoLabel(c.resultado)}`,
      detalhe: c.nota,
      valor: null,
    });
  }
  for (const f of sources.followups) {
    items.push({
      id: `retorno:${f.id}`,
      kind: "retorno",
      at: f.at,
      titulo: `Retorno agendado para ${formatDueDate(f.dueDate)}`,
      detalhe: f.nota,
      valor: null,
    });
  }

  return items
    .filter((item) => item.at && Number.isFinite(new Date(item.at).getTime()))
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, limit);
}
