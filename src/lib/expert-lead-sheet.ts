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
  beneficios: Array<{ tipo: "cashback" | "bonus"; valor: number; at: string | null }>;
  timeline: ExpertTimelineItem[];
  claim: { expertNome: string; expiresAt: string; minha: boolean } | null;
  retornosPendentes: Array<{ id: string; dueDate: string; nota: string | null }>;
  podeAssumir: boolean;
};

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
