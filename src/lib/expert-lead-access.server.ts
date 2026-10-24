// Guard único de "lead visível" da Área do Expert (Fase 2). Toda server
// function que lê ou escreve algo sobre um lead chama `loadVisibleLead`
// depois de `requireExpertContext`: o lead precisa ser da casa do expert e,
// para o expert restrito, ter um dos affiliate_ids dele.
//
// Lê com `supabaseAdmin` (os experts não têm RLS sobre `players`) e por isso
// seleciona só as colunas que a ficha pode mostrar: nunca CPF, e-mail ou
// saldo de carteira.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { ExpertAccessError, type ExpertContext } from "@/lib/expert-access.server";

const VISIBLE_LEAD_COLUMNS =
  "id,tenant_id,nome,telefone,affiliate_id,total_depositado,total_sacado,ultimo_deposito,ftd_em,created_at,risco,vip,saldo_bonus,last_cashback_amount,last_cashback_paid_at,total_cashback_paid";

export type VisibleLead = {
  id: string;
  tenant_id: string;
  nome: string;
  telefone: string | null;
  affiliate_id: string | null;
  total_depositado: number | null;
  total_sacado: number | null;
  ultimo_deposito: string | null;
  ftd_em: string | null;
  created_at: string;
  risco: string | null;
  vip: boolean | null;
  saldo_bonus: number | null;
  last_cashback_amount: number | null;
  last_cashback_paid_at: string | null;
  total_cashback_paid: number | null;
};

const NOT_FOUND = "Lead não encontrado.";

/** `affiliate_id` gravado no jogador, sem espaços nas pontas (null se vazio). */
export function normalizedAffiliateId(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

/** O affiliate_id do lead é um dos vinculados ao expert? */
export function isExpertAffiliate(expert: ExpertContext, affiliateId: string | null | undefined) {
  const id = normalizedAffiliateId(affiliateId);
  return id != null && expert.affiliateIds.some((a) => a.trim() === id);
}

export async function loadVisibleLead(
  expert: ExpertContext,
  playerId: string,
): Promise<VisibleLead> {
  const { data, error } = await supabaseAdmin
    .from("players")
    .select(VISIBLE_LEAD_COLUMNS)
    .eq("id", playerId)
    .eq("tenant_id", expert.tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);

  const row = data as VisibleLead | null;
  if (!row) throw new ExpertAccessError(NOT_FOUND);
  if (expert.tipo === "restrito" && !isExpertAffiliate(expert, row.affiliate_id)) {
    throw new ExpertAccessError(NOT_FOUND);
  }

  // Monta o objeto campo a campo: mesmo que a consulta devolvesse colunas a
  // mais, nada além do recorte permitido sai daqui.
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    nome: row.nome,
    telefone: row.telefone,
    affiliate_id: row.affiliate_id,
    total_depositado: row.total_depositado,
    total_sacado: row.total_sacado,
    ultimo_deposito: row.ultimo_deposito,
    ftd_em: row.ftd_em,
    created_at: row.created_at,
    risco: row.risco,
    vip: row.vip,
    saldo_bonus: row.saldo_bonus,
    last_cashback_amount: row.last_cashback_amount,
    last_cashback_paid_at: row.last_cashback_paid_at,
    total_cashback_paid: row.total_cashback_paid,
  };
}
