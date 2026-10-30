// Escopo de envio de um expert (Área do Expert §8), lido do banco no momento
// do uso: criação, aprovação e cada execução dos workers. O restrito só
// alcança jogadores cujo btrim(affiliate_id) é um dos afiliados dele; o de
// acesso total, a casa toda. Nunca confia em listas vindas do navegador: tudo
// passa por aqui, sempre com o client service_role e filtro explícito de casa.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { ExpertTipo } from "@/lib/expert-access.server";
import type { ExpertAudienceScope } from "@/lib/sms-audience-selection.server";

/* eslint-disable @typescript-eslint/no-explicit-any -- experts/expert_affiliates e as colunas novas ainda não estão nos tipos gerados. */
export type ScopeDb = { from: (table: string) => any };
/* eslint-enable @typescript-eslint/no-explicit-any */

export type ExpertEnvioModo = "livre" | "aprovacao";

export type ExpertScope = {
  expertId: string;
  tenantId: string;
  nome: string;
  tipo: ExpertTipo;
  ativo: boolean;
  envioModo: ExpertEnvioModo;
  /** R$ por mês, todos os canais; null = sem teto; 0 = bloqueia tudo. */
  tetoMensal: number | null;
  /** Afiliados do expert (sem espaços). Só valem para o restrito. */
  affiliateIds: string[];
};

export const EXPERT_SCOPE_INACTIVE =
  "O expert dono desta campanha foi desativado; nada será enviado.";
export const EXPERT_OUT_OF_SCOPE_MESSAGE = "Jogador fora do escopo do expert";

const SCOPE_CHUNK = 300;

export function defaultScopeDb(): ScopeDb {
  return supabaseAdmin as unknown as ScopeDb;
}

/** Expert (ativo ou não) desta casa; null quando não existe nela. */
export async function loadExpertScope(
  expertId: string,
  tenantId: string,
  db: ScopeDb = defaultScopeDb(),
): Promise<ExpertScope | null> {
  const { data: row, error } = await db
    .from("experts")
    .select("id,tenant_id,nome,tipo,ativo,envio_modo,teto_mensal")
    .eq("id", expertId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) return null;
  const { data: links, error: linksError } = await db
    .from("expert_affiliates")
    .select("affiliate_id")
    .eq("tenant_id", tenantId)
    .eq("expert_id", expertId);
  if (linksError) throw new Error(linksError.message);
  return {
    expertId: row.id,
    tenantId: row.tenant_id,
    nome: row.nome ?? "",
    tipo: row.tipo === "total" ? "total" : "restrito",
    ativo: row.ativo !== false,
    envioModo: row.envio_modo === "aprovacao" ? "aprovacao" : "livre",
    tetoMensal: parseTeto(row.teto_mensal),
    affiliateIds: normalizeAffiliateIds(
      ((links ?? []) as Array<{ affiliate_id: string | null }>).map((l) => l.affiliate_id),
    ),
  };
}

export function parseTeto(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function normalizeAffiliateIds(values: ReadonlyArray<string | null | undefined>): string[] {
  return Array.from(new Set(values.map((v) => String(v ?? "").trim()).filter(Boolean)));
}

/** Escopo para o resolvedor de público (`resolveAudienceForTenant`). */
export function audienceScopeOf(
  scope: Pick<ExpertScope, "expertId" | "tipo" | "affiliateIds">,
): ExpertAudienceScope {
  return {
    expertId: scope.expertId,
    affiliateIds: scope.tipo === "total" ? null : scope.affiliateIds,
  };
}

/**
 * Mantém só os jogadores que o expert vê (casa + afiliados quando restrito),
 * na ordem recebida, sem repetição. Restrito sem afiliado: nenhum. Compara o
 * affiliate_id sem espaços (mesma regra do RLS e do RPC de público).
 */
export async function filterPlayerIdsToExpert(
  scope: Pick<ExpertScope, "tenantId" | "tipo" | "affiliateIds">,
  playerIds: readonly string[],
  db: ScopeDb = defaultScopeDb(),
): Promise<string[]> {
  const unique = Array.from(new Set(playerIds.filter(Boolean)));
  if (unique.length === 0) return [];
  const restricted = scope.tipo !== "total";
  const allowed = new Set(normalizeAffiliateIds(scope.affiliateIds));
  if (restricted && allowed.size === 0) return [];
  const visible = new Set<string>();
  for (let i = 0; i < unique.length; i += SCOPE_CHUNK) {
    const { data, error } = await db
      .from("players")
      .select("id,affiliate_id")
      .eq("tenant_id", scope.tenantId)
      .in("id", unique.slice(i, i + SCOPE_CHUNK));
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as Array<{ id: string; affiliate_id: string | null }>) {
      if (!restricted || allowed.has(String(row.affiliate_id ?? "").trim())) visible.add(row.id);
    }
  }
  return unique.filter((id) => visible.has(id));
}
