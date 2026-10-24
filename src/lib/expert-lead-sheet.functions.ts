// Server function da ficha do lead na Área do Expert (Fase 2, Task 2).
//
// Fluxo: requireExpertContext -> loadVisibleLead (guard de alcance) -> todas
// as leituras com supabaseAdmin, colunas explícitas, sempre filtradas por
// tenant_id da casa do expert e player_id do lead. Contatos e retornos são só
// os do próprio expert; de outro expert a ficha mostra apenas quem assumiu o
// lead e até quando.
//
// As tabelas expert_* (migration 20261027100000) e as colunas first_party_*
// de link_dispatches ainda não estão nos tipos gerados do Supabase, por isso
// as consultas usam `(supabaseAdmin as any)`, como em expert-access.server.ts.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireExpertContext } from "@/lib/expert-access.server";
import { isExpertAffiliate, loadVisibleLead } from "@/lib/expert-lead-access.server";
import {
  buildExpertTimeline,
  maskHouseMessageText,
  type ExpertLeadSheet,
} from "@/lib/expert-lead-sheet";
import { depositCountFor } from "@/lib/player-deposit-count";
import { levelForTotal, thresholdsFromSettingsRow } from "@/lib/player-level";
import {
  daysWithoutDeposit,
  playerSituation,
  situationSettingsFromRow,
  SITUATION_LABEL,
} from "@/lib/player-situation";

// Mesmos status "enviado" que a ficha do jogador e os relatórios usam
// (a Short Brasil não confirma entrega).
const SENT_STATUSES = ["sent", "delivered", "enviado", "entregue"];

type ServerContext = {
  userId: string;
  activeTenantId?: string | null;
};

type DbError = { message: string } | null;
type DbRows<T> = { data: T[] | null; error: DbError; count?: number | null };

type MoneyRow = { id: string; valor: number | null; created_at: string };
type CashbackRow = {
  id: string;
  cashback_amount: number | null;
  paid_at: string | null;
  created_at: string;
};
type SmsRow = { id: string; content: string | null; created_at: string };
type EmailRow = { id: string; subject: string | null; sent_at: string | null; created_at: string };
type LinkRow = { id: string; oferta: string; link_dispatch_id: string | null; created_at: string };
type DispatchRow = { id: string; first_party_first_clicked_at: string | null };
type ContactRow = { id: string; resultado: string; nota: string | null; created_at: string };
type FollowupRow = {
  id: string;
  due_date: string;
  nota: string | null;
  created_at: string;
};
type WalletRow = { saldo_carteira: number | null; saldo_bonus: number | null };
type ClaimRow = { expert_id: string; expires_at: string };
type HolderRow = { id: string; nome: string; ativo: boolean; tipo: string };

function rowsOf<T>(res: DbRows<T>): T[] {
  if (res.error) throw new Error(res.error.message);
  return res.data ?? [];
}

const sheetInput = z.object({ playerId: z.string().uuid() });

export const getExpertLeadSheet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => sheetInput.parse(data))
  .handler(async ({ data, context }) =>
    getExpertLeadSheetFor(context as unknown as ServerContext, data),
  );

/** Body of `getExpertLeadSheet`, exported so it is directly unit-testable. */
export async function getExpertLeadSheetFor(
  ctx: ServerContext,
  data: { playerId: string },
): Promise<ExpertLeadSheet> {
  const expert = await requireExpertContext(ctx.userId, ctx.activeTenantId);
  const lead = await loadVisibleLead(expert, data.playerId);
  const tenantId = expert.tenantId;
  const playerId = lead.id;
  const db = supabaseAdmin as any; // expert_* tables are not in the generated types yet

  const scoped = (table: string, columns: string, options?: unknown) =>
    db.from(table).select(columns, options).eq("tenant_id", tenantId).eq("player_id", playerId);

  const [
    depositsRes,
    approvedCountRes,
    nullStatusCountRes,
    attributionRes,
    withdrawalsRes,
    cashbacksRes,
    smsRes,
    emailsRes,
    linksRes,
    contactsRes,
    followupsRes,
    pendingRes,
    claimRes,
    settingsRes,
    walletRes,
  ] = await Promise.all([
    scoped("deposits", "id,valor,created_at")
      .eq("status", "aprovado")
      .order("created_at", { ascending: false })
      .limit(50),
    // Mesma regra de contagem da ficha do jogador: status nulo ou 'aprovado'
    // (duas contagens exatas somadas), combinada com o número importado.
    scoped("deposits", "id", { count: "exact", head: true }).eq("status", "aprovado"),
    scoped("deposits", "id", { count: "exact", head: true }).is("status", null),
    scoped("player_attributions", "raw_payload")
      .order("captured_at", { ascending: false })
      .limit(1),
    scoped("withdrawals", "id,valor,created_at")
      .eq("status", "aprovado")
      .order("created_at", { ascending: false })
      .limit(50),
    scoped("cashback_payments", "id,cashback_amount,paid_at,created_at")
      .order("paid_at", { ascending: false })
      .limit(10),
    scoped("sms_send_logs", "id,content,created_at")
      .in("status", SENT_STATUSES)
      .order("created_at", { ascending: false })
      .limit(20),
    scoped("email_send_logs", "id,subject,sent_at,created_at")
      .in("status", SENT_STATUSES)
      .order("created_at", { ascending: false })
      .limit(20),
    scoped("expert_links", "id,oferta,link_dispatch_id,created_at")
      .eq("expert_id", expert.expertId)
      .order("created_at", { ascending: false })
      .limit(50),
    scoped("expert_lead_contacts", "id,resultado,nota,created_at")
      .eq("expert_id", expert.expertId)
      .order("created_at", { ascending: false })
      .limit(50),
    scoped("expert_lead_followups", "id,due_date,nota,created_at")
      .eq("expert_id", expert.expertId)
      .order("created_at", { ascending: false })
      .limit(50),
    // Retornos pendentes em consulta própria: um pendente antigo não pode
    // sumir atrás dos 50 retornos mais recentes.
    scoped("expert_lead_followups", "id,due_date,nota")
      .eq("expert_id", expert.expertId)
      .is("done_at", null)
      .order("due_date", { ascending: true })
      .limit(20),
    scoped("expert_lead_claims", "expert_id,expires_at").maybeSingle(),
    db
      .from("gamification_settings")
      .select("level_thresholds,cooling_after_days,sleeping_after_days")
      .eq("tenant_id", tenantId)
      .maybeSingle(),
    // Saldo da carteira: lido SÓ para mascarar {saldo}/{saldo_atual} já
    // renderizados nos SMS/e-mails da casa — nunca sai na ficha.
    db
      .from("players")
      .select("saldo_carteira,saldo_bonus")
      .eq("tenant_id", tenantId)
      .eq("id", playerId)
      .maybeSingle(),
  ]);

  const deposits = rowsOf<MoneyRow>(depositsRes);
  for (const res of [approvedCountRes, nullStatusCountRes]) {
    if (res.error) throw new Error(res.error.message);
  }
  const attribution = rowsOf<{ raw_payload: unknown }>(attributionRes)[0] ?? null;
  const pending = rowsOf<{ id: string; due_date: string; nota: string | null }>(pendingRes);
  const withdrawals = rowsOf<MoneyRow>(withdrawalsRes);
  const cashbacks = rowsOf<CashbackRow>(cashbacksRes);
  const sms = rowsOf<SmsRow>(smsRes);
  const emails = rowsOf<EmailRow>(emailsRes);
  const links = rowsOf<LinkRow>(linksRes);
  const contacts = rowsOf<ContactRow>(contactsRes);
  const followups = rowsOf<FollowupRow>(followupsRes);
  if (claimRes.error) throw new Error(claimRes.error.message);
  if (walletRes.error) throw new Error(walletRes.error.message);
  const wallet = walletRes.data as WalletRow | null;
  const saldoCarteira = Number(wallet?.saldo_carteira ?? 0);
  // template-vars formata {saldo}/{saldo_atual} a partir de saldo_carteira;
  // carteira + bônus entra por garantia, caso a casa mostre o saldo total.
  const saldoValues = [saldoCarteira, saldoCarteira + Number(wallet?.saldo_bonus ?? 0)];

  const [clickedAtByDispatch, claim] = await Promise.all([
    loadFirstClicks(db, tenantId, links),
    resolveClaim(db, tenantId, expert.expertId, claimRes.data as ClaimRow | null),
  ]);

  // Sem linha (ou erro) de gamification_settings => padrões, igual à ficha do jogador.
  const settingsRow = settingsRes.error ? null : settingsRes.data;
  const situacao = playerSituation(lead, situationSettingsFromRow(settingsRow));
  const totalDepositado = Number(lead.total_depositado ?? 0);
  const depositos = depositCountFor({
    approvedCount: Number(approvedCountRes.count ?? 0) + Number(nullStatusCountRes.count ?? 0),
    importedRawPayload: attribution?.raw_payload,
  });
  const latestDeposit = deposits[0];
  const saldoBonus = Number(lead.saldo_bonus ?? 0);

  const timeline = buildExpertTimeline({
    deposits: deposits.map((d) => ({ id: d.id, valor: Number(d.valor ?? 0), at: d.created_at })),
    withdrawals: withdrawals.map((w) => ({
      id: w.id,
      valor: Number(w.valor ?? 0),
      at: w.created_at,
    })),
    cashbacks: cashbacks.map((c) => ({
      id: c.id,
      valor: Number(c.cashback_amount ?? 0),
      at: c.paid_at ?? c.created_at,
    })),
    sms: sms.map((s) => ({
      id: s.id,
      content: maskHouseMessageText(s.content, { saldoValues }),
      at: s.created_at,
    })),
    emails: emails.map((e) => ({
      id: e.id,
      subject: maskHouseMessageText(e.subject, { saldoValues }),
      at: e.sent_at ?? e.created_at,
    })),
    links: links.map((l) => ({
      id: l.id,
      oferta: l.oferta,
      at: l.created_at,
      clickedAt: (l.link_dispatch_id && clickedAtByDispatch.get(l.link_dispatch_id)) || null,
    })),
    contacts: contacts.map((c) => ({
      id: c.id,
      resultado: c.resultado,
      nota: c.nota,
      at: c.created_at,
    })),
    followups: followups.map((f) => ({
      id: f.id,
      dueDate: f.due_date,
      nota: f.nota,
      at: f.created_at,
    })),
  });

  return {
    lead: {
      id: lead.id,
      nome: lead.nome,
      telefone: lead.telefone,
      nivel: levelForTotal(
        totalDepositado,
        thresholdsFromSettingsRow(settingsRow?.level_thresholds),
      ),
      situacao,
      situacaoLabel: SITUATION_LABEL[situacao],
      diasSemDepositar: daysWithoutDeposit(lead),
      totalDepositado,
      depositos,
      ticketMedio: depositos > 0 ? totalDepositado / depositos : null,
      ultimoDeposito: latestDeposit
        ? { valor: Number(latestDeposit.valor ?? 0), at: latestDeposit.created_at }
        : null,
      totalSacado: Number(lead.total_sacado ?? 0),
      origemAfiliadoDoExpert: isExpertAffiliate(expert, lead.affiliate_id),
    },
    beneficios: [
      ...cashbacks.map((c) => ({
        tipo: "cashback" as const,
        valor: Number(c.cashback_amount ?? 0),
        at: c.paid_at ?? c.created_at,
      })),
      ...(saldoBonus > 0 ? [{ tipo: "bonus" as const, valor: saldoBonus, at: null }] : []),
    ],
    timeline,
    claim,
    retornosPendentes: pending.map((f) => ({ id: f.id, dueDate: f.due_date, nota: f.nota })),
    podeAssumir: expert.tipo === "total",
  };
}

/**
 * Primeiro clique humano de cada link do expert, lido do próprio
 * link_dispatch (first_party_first_clicked_at é gravado pelo trigger de
 * click_events só para cliques humanos), sem varrer click_events.
 */
async function loadFirstClicks(
  db: any,
  tenantId: string,
  links: LinkRow[],
): Promise<Map<string, string>> {
  const ids = Array.from(
    new Set(links.map((l) => l.link_dispatch_id).filter((id): id is string => !!id)),
  );
  if (ids.length === 0) return new Map();

  const res: DbRows<DispatchRow> = await db
    .from("link_dispatches")
    .select("id,first_party_first_clicked_at")
    .eq("tenant_id", tenantId)
    .in("id", ids);
  const map = new Map<string, string>();
  for (const row of rowsOf(res)) {
    if (row.first_party_first_clicked_at) map.set(row.id, row.first_party_first_clicked_at);
  }
  return map;
}

/**
 * O lead só conta como assumido enquanto o prazo não venceu e quem assumiu
 * ainda é um expert ativo de acesso total — a mesma regra de
 * claim_expert_lead, que trata os outros casos como prazo vencido.
 */
async function resolveClaim(
  db: any,
  tenantId: string,
  myExpertId: string,
  claim: ClaimRow | null,
): Promise<ExpertLeadSheet["claim"]> {
  if (!claim || new Date(claim.expires_at).getTime() <= Date.now()) return null;

  const { data, error } = await db
    .from("experts")
    .select("id,nome,ativo,tipo")
    .eq("id", claim.expert_id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const holder = data as HolderRow | null;
  if (!holder || !holder.ativo || holder.tipo !== "total") return null;

  return {
    expertNome: holder.nome,
    expiresAt: claim.expires_at,
    minha: holder.id === myExpertId,
  };
}
