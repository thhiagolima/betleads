// Perfil de rendimento da equipe (Área do Expert, Fase 3, Task 7; spec
// §7.1): um admin, gestor ou membro da casa com um perfil de expert
// vinculado (`experts.user_id`) gera, na ficha do jogador da casa, um link
// rastreado creditado a esse perfil — a mesma regra de crédito do expert.
//
// O perfil só mede: o acesso da pessoa continua sendo o papel dela na casa.
// Quem tem papel `expert` NÃO usa este caminho (usa `generateExpertLink`,
// com o guard de alcance do expert).
//
// Guard: casa via `resolveOperationalTenantForRequest` → papel da pessoa em
// `HOUSE_MEMBER_ROLES` nesta casa → perfil ativo vinculado a ela nesta casa
// → jogador da casa (`players.tenant_id`) → `createExpertLinkCore`.
// `experts` e o valor `expert` de `user_roles.role` ainda não estão nos
// tipos gerados do Supabase → `(supabaseAdmin as any)`.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createExpertLinkCore, type ExpertLinkCoreResult } from "@/lib/expert-link-core.server";
import { HOUSE_MEMBER_ROLES, type HouseMemberRole } from "@/lib/house-member-roles";
import { resolveOperationalTenantForRequest } from "@/lib/tenant-access.server";
import { dbUuid } from "@/lib/zod-helpers";

type DbResult<T = unknown> = { data: T | null; error: { message: string } | null };
type ServerContext = {
  userId: string;
  supabase: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rpc: (...args: any[]) => PromiseLike<DbResult<unknown>>;
  };
  activeTenantId?: string | null;
};

export const NO_PROFILE = "Você não tem um perfil de rendimento nesta casa.";
const PLAYER_NOT_FOUND = "Jogador não encontrado.";

export type TeamExpertProfile = { expertId: string; nome: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any;

/**
 * Casa do pedido + perfil ativo do usuário nela, só para quem é da equipe,
 * com o papel dele na casa (`papel`, null fora da equipe). Também usado pelo
 * relatório de rendimento (`expert-report-subject.server.ts`).
 */
export async function resolveTeamExpertProfile(
  ctx: ServerContext,
): Promise<{ tenantId: string; profile: TeamExpertProfile | null; papel: HouseMemberRole | null }> {
  const tenantId = await resolveOperationalTenantForRequest(
    ctx.supabase,
    ctx.userId,
    ctx.activeTenantId,
  );

  const { data: roles, error: roleErr } = await db()
    .from("user_roles")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", ctx.userId)
    .in("role", [...HOUSE_MEMBER_ROLES]);
  if (roleErr) throw new Error(roleErr.message);
  const papel = ((roles ?? []) as Array<{ role: HouseMemberRole }>)[0]?.role ?? null;
  if (!papel) return { tenantId, profile: null, papel: null };

  const { data: expert, error: expertErr } = await db()
    .from("experts")
    .select("id,nome")
    .eq("tenant_id", tenantId)
    .eq("user_id", ctx.userId)
    .eq("ativo", true)
    .maybeSingle();
  if (expertErr) throw new Error(expertErr.message);
  if (!expert) return { tenantId, profile: null, papel };
  const row = expert as { id: string; nome: string };
  return { tenantId, profile: { expertId: row.id, nome: row.nome }, papel };
}

export const getMyTeamExpertProfile = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => getMyTeamExpertProfileFor(context as unknown as ServerContext));

/** Perfil de rendimento ativo do usuário logado na casa atual, ou null. */
export async function getMyTeamExpertProfileFor(
  ctx: ServerContext,
): Promise<TeamExpertProfile | null> {
  return (await resolveTeamExpertProfile(ctx)).profile;
}

const generateInput = z.object({
  playerId: dbUuid(),
  url: z.string(),
  oferta: z.string(),
});

export const generateTeamTrackedLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => generateInput.parse(data))
  .handler(async ({ data, context }) =>
    generateTeamTrackedLinkFor(context as unknown as ServerContext, data),
  );

export async function generateTeamTrackedLinkFor(
  ctx: ServerContext,
  data: z.input<typeof generateInput>,
): Promise<ExpertLinkCoreResult> {
  const input = generateInput.parse(data);
  const { tenantId, profile } = await resolveTeamExpertProfile(ctx);
  if (!profile) throw new Error(NO_PROFILE);

  const { data: player, error } = await db()
    .from("players")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("id", input.playerId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!player) throw new Error(PLAYER_NOT_FOUND);

  return createExpertLinkCore({
    tenantId,
    expertId: profile.expertId,
    playerId: (player as { id: string }).id,
    url: input.url,
    oferta: input.oferta,
  });
}
