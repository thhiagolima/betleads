// Resolução do contexto de um usuário expert (Área do Expert, Fase 1,
// Task 5): qual casa ele está acessando, com que permissão (tipo) e quais
// affiliate_ids ele pode ver (quando restrito).
//
// `experts`/`expert_affiliates` e as novas colunas de `user_roles.role` e
// `experts.*` (Task 1/2) ainda não estão nos tipos gerados do Supabase, então
// as consultas usam `(supabaseAdmin as any)`, seguindo o padrão já usado em
// `tenant-access.server.ts` (`getCachedTenantStatus`) para colunas/tabelas
// anteriores ao codegen.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertTenantCanOperate } from "@/lib/tenant-access.server";

export type ExpertTipo = "restrito" | "total";

export type ExpertContext = {
  tenantId: string;
  tenantNome: string;
  expertId: string;
  nome: string;
  tipo: ExpertTipo;
  affiliateIds: string[];
};

export class ExpertAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpertAccessError";
  }
}

type ExpertRow = {
  id: string;
  tenant_id: string;
  nome: string;
  tipo: ExpertTipo;
};

/**
 * Resolve a casa (e o acesso) do expert: precisa de uma linha `user_roles`
 * com `role = 'expert'` E uma linha `experts` ativa com `user_id = userId`
 * na mesma casa. Sem nenhuma casa que satisfaça as duas condições -> null.
 *
 * `requestedTenantId`, quando informado, precisa ser uma dessas casas; caso
 * contrário o resultado é null (nunca cai para outra casa do expert).
 * Sem `requestedTenantId`, escolhe a primeira por `tenant_id`.
 */
export async function resolveExpertContext(
  userId: string,
  requestedTenantId?: string | null,
): Promise<ExpertContext | null> {
  const { data: roleRows, error: roleErr } = await (supabaseAdmin as any)
    .from("user_roles")
    .select("tenant_id")
    .eq("user_id", userId)
    .eq("role", "expert");
  if (roleErr) throw new Error(roleErr.message);

  const expertTenantIds = Array.from(
    new Set(((roleRows ?? []) as Array<{ tenant_id: string }>).map((r) => r.tenant_id).filter(Boolean)),
  );
  if (expertTenantIds.length === 0) return null;

  const { data: expertRows, error: expertErr } = await (supabaseAdmin as any)
    .from("experts")
    .select("id,tenant_id,nome,tipo")
    .eq("user_id", userId)
    .eq("ativo", true)
    .in("tenant_id", expertTenantIds);
  if (expertErr) throw new Error(expertErr.message);

  const candidates = ((expertRows ?? []) as ExpertRow[]).slice().sort((a, b) =>
    a.tenant_id < b.tenant_id ? -1 : a.tenant_id > b.tenant_id ? 1 : 0,
  );
  if (candidates.length === 0) return null;

  let chosen: ExpertRow | undefined;
  if (requestedTenantId) {
    chosen = candidates.find((c) => c.tenant_id === requestedTenantId);
    if (!chosen) return null;
  } else {
    chosen = candidates[0];
  }

  const { data: tenantRow, error: tenantErr } = await (supabaseAdmin as any)
    .from("tenants")
    .select("nome")
    .eq("id", chosen.tenant_id)
    .maybeSingle();
  if (tenantErr) throw new Error(tenantErr.message);

  const { data: affiliateRows, error: affiliateErr } = await (supabaseAdmin as any)
    .from("expert_affiliates")
    .select("affiliate_id")
    .eq("tenant_id", chosen.tenant_id)
    .eq("expert_id", chosen.id);
  if (affiliateErr) throw new Error(affiliateErr.message);

  return {
    tenantId: chosen.tenant_id,
    tenantNome: (tenantRow as { nome?: string } | null)?.nome ?? "",
    expertId: chosen.id,
    nome: chosen.nome,
    tipo: chosen.tipo,
    affiliateIds: ((affiliateRows ?? []) as Array<{ affiliate_id: string }>).map(
      (r) => r.affiliate_id,
    ),
  };
}

/**
 * `resolveExpertContext` + os dois erros que a área do expert mostra ao
 * usuário: acesso inexistente/desativado, ou casa indisponível (suspensa/
 * cancelada, via `assertTenantCanOperate`).
 */
export async function requireExpertContext(
  userId: string,
  requestedTenantId?: string | null,
): Promise<ExpertContext> {
  const ctx = await resolveExpertContext(userId, requestedTenantId);
  if (!ctx) throw new ExpertAccessError("Acesso de expert não encontrado ou desativado.");

  try {
    await assertTenantCanOperate(ctx.tenantId);
  } catch {
    throw new ExpertAccessError("Esta casa está indisponível no momento.");
  }

  return ctx;
}
