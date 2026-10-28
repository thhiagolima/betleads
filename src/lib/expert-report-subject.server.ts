// Relatório de rendimento (spec 2026-10-28-relatorio-rendimento-design.md
// §6): de quem é o relatório pedido.
//
// - Sem `expertId`: o do próprio usuário. Quem tem papel `expert` passa por
//   `requireExpertContext`; a equipe (admin, gestor, membro), pelo perfil
//   ativo vinculado a ela na casa, a mesma regra de
//   `getMyTeamExpertProfileFor`. O cliente nunca escolhe o perfil.
// - Com `expertId`: só o admin da casa (`requireExpertAdminTenant`), e o
//   perfil precisa ser da casa (`loadExpert`: "Expert não encontrado.").
//   Um expert ou membro da equipe que manda `expertId` cai na recusa de
//   admin, mesmo que o id seja o dele.

import {
  EXPERT_ACCESS_NOT_FOUND,
  ExpertAccessError,
  requireExpertContext,
  resolveExpertContext,
  type ExpertTipo,
} from "@/lib/expert-access.server";
import {
  expertAccessFields,
  houseRolesOf,
  loadExpert,
  NOT_ADMIN_MESSAGE,
  requireExpertAdminTenant,
} from "@/lib/experts-admin.functions";
import type { HouseMemberRole } from "@/lib/house-member-roles";
import { NO_PROFILE, resolveTeamExpertProfile } from "@/lib/team-expert.functions";

type DbResult<T = unknown> = { data: T | null; error: { message: string } | null };
export type ServerContext = {
  userId: string;
  supabase: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rpc: (...args: any[]) => PromiseLike<DbResult<unknown>>;
  };
  activeTenantId?: string | null;
};

export type ReportSubject = {
  tenantId: string;
  expertId: string;
  nome: string;
  tipoLabel: string;
  viewer: "self" | "admin";
};

const TIPO_LABEL: Record<ExpertTipo, string> = {
  restrito: "Expert restrito",
  total: "Expert total",
};

const PAPEL_LABEL: Record<HouseMemberRole, string> = {
  admin: "Admin",
  gestor: "Gestor",
  member: "Membro",
};

function tipoLabelOf(tipo: ExpertTipo, papelEquipe: HouseMemberRole | null): string {
  return papelEquipe ? `Equipe (${PAPEL_LABEL[papelEquipe]})` : TIPO_LABEL[tipo];
}

function isExpertNotFound(err: unknown): boolean {
  return err instanceof ExpertAccessError && err.message === EXPERT_ACCESS_NOT_FOUND;
}

async function resolveSelfSubject(ctx: ServerContext): Promise<ReportSubject> {
  try {
    const expert = await requireExpertContext(ctx.userId, ctx.activeTenantId);
    return {
      tenantId: expert.tenantId,
      expertId: expert.expertId,
      nome: expert.nome,
      tipoLabel: TIPO_LABEL[expert.tipo],
      viewer: "self",
    };
  } catch (err) {
    // Not an expert here: try the team profile. Any other refusal (house
    // unavailable, DB failure) stands.
    if (!isExpertNotFound(err)) throw err;
  }

  const { tenantId, profile, papel } = await resolveTeamExpertProfile(ctx);
  if (!profile || !papel) throw new Error(NO_PROFILE);
  return {
    tenantId,
    expertId: profile.expertId,
    nome: profile.nome,
    tipoLabel: `Equipe (${PAPEL_LABEL[papel]})`,
    viewer: "self",
  };
}

/**
 * `requireExpertAdminTenant`, mas um expert sempre recebe a recusa de admin:
 * a casa operacional dele pode nem resolver (ele não é da equipe), e a
 * mensagem não deve depender disso.
 */
async function requireAdminTenant(ctx: ServerContext): Promise<string> {
  try {
    return await requireExpertAdminTenant(ctx);
  } catch (err) {
    if (await resolveExpertContext(ctx.userId, ctx.activeTenantId)) {
      throw new Error(NOT_ADMIN_MESSAGE);
    }
    throw err;
  }
}

async function resolveAdminSubject(ctx: ServerContext, expertId: string): Promise<ReportSubject> {
  const tenantId = await requireAdminTenant(ctx);
  const row = await loadExpert(tenantId, expertId);
  const roles = await houseRolesOf(tenantId, [row.user_id]);
  const { papelEquipe } = expertAccessFields(
    row,
    null,
    row.user_id ? roles.get(row.user_id) : null,
  );
  return {
    tenantId,
    expertId: row.id,
    nome: row.nome,
    tipoLabel: tipoLabelOf(row.tipo, papelEquipe),
    viewer: "admin",
  };
}

/** De quem é o relatório: o próprio usuário (sem `expertId`) ou, para o admin, o perfil pedido. */
export async function resolveReportSubject(
  ctx: ServerContext,
  expertId?: string | null,
): Promise<ReportSubject> {
  return expertId ? resolveAdminSubject(ctx, expertId) : resolveSelfSubject(ctx);
}
