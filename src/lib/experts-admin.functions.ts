// Server functions do admin da casa para configurar experts (Área do Expert,
// Fase 1, Task 6): listar, salvar, convidar, remover acesso, ativar/
// desativar e excluir. Fase 3, Task 7: o perfil também pode ser vinculado a
// alguém da equipe (admin, gestor, membro) como "perfil de rendimento". Isso
// só grava `experts.user_id`: nenhum papel é criado nem mudado, e
// `expert_tenant_ids()` exige `user_roles.role = 'expert'`, então o vínculo
// não dá acesso de expert a ninguém.
//
// Guard comum: casa operacional do pedido → `requireTenantAdmin`. As escritas
// também passam por `assertTenantNotDemo` e só então usam `supabaseAdmin`
// (experts/expert_affiliates são somente leitura para `authenticated`, e
// save_expert/delete_expert/tenant_unassigned_affiliate_ids são
// service_role). Essas tabelas, colunas e RPCs ainda não estão nos tipos
// gerados do Supabase, então as consultas usam `(supabaseAdmin as any)`,
// como em `expert-access.server.ts`.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { ExpertTipo } from "@/lib/expert-access.server";
import {
  HOUSE_MEMBER_ROLES,
  isHouseMemberRole,
  type HouseMemberRole,
} from "@/lib/house-member-roles";
import {
  assertTenantNotDemo,
  requireTenantAdmin,
  resolveOperationalTenantForRequest,
} from "@/lib/tenant-access.server";
import { auditTenant } from "@/lib/tenant-audit.server";
import { findOrInviteUserByEmail } from "@/lib/tenants.functions";
import { dbUuid } from "@/lib/zod-helpers";

type DbError = { message: string; code?: string; details?: string | null };
type DbResult<T = unknown> = { data: T | null; error: DbError | null };
type ServerContext = {
  userId: string;
  supabase: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rpc: (...args: any[]) => PromiseLike<DbResult<unknown>>;
  };
  activeTenantId?: string | null;
};

/**
 * `equipe`: perfil de rendimento vinculado a alguém da equipe (tem
 * `user_id`, mas o papel dessa pessoa na casa não é `expert`).
 */
export type ExpertAcesso = "sem_acesso" | "convite_pendente" | "ativo" | "inativo" | "equipe";
export type ExpertEnvioModo = "livre" | "aprovacao";

export type ExpertAdminRow = {
  id: string;
  nome: string;
  tipo: ExpertTipo;
  ativo: boolean;
  envioModo: ExpertEnvioModo;
  tetoMensal: number | null;
  assumirPrazoDias: number;
  affiliateIds: string[];
  leads: number;
  acesso: ExpertAcesso;
  /** Papel na casa de quem tem o perfil vinculado, quando `acesso = 'equipe'`. */
  papelEquipe: HouseMemberRole | null;
  email: string | null;
  createdAt: string;
};

export type ExpertDbRow = {
  id: string;
  tenant_id: string;
  nome: string;
  tipo: ExpertTipo;
  ativo: boolean;
  envio_modo: ExpertEnvioModo;
  teto_mensal: number | string | null;
  assumir_prazo_dias: number;
  user_id: string | null;
  ja_vinculado: boolean;
  created_at: string;
};

const EXPERT_COLUMNS =
  "id,tenant_id,nome,tipo,ativo,envio_modo,teto_mensal,assumir_prazo_dias,user_id,ja_vinculado,created_at";

export const NOT_ADMIN_MESSAGE = "Apenas o admin da casa gerencia experts.";
const EXPERT_NOT_FOUND = "Expert não encontrado.";
const EXPERT_ALREADY_LINKED =
  "Este expert já tem acesso. Remova o acesso antes de convidar outra pessoa.";
const NOT_TEAM_MEMBER = "Escolha alguém da equipe desta casa.";
const PROFILE_ALREADY_LINKED = "Este perfil já está vinculado.";
const USER_ALREADY_HAS_PROFILE = "Esta pessoa já tem um perfil de rendimento.";
const PROFILE_HAS_OTHER_CREDITS =
  "Este perfil já tem créditos de outra pessoa. Crie um perfil novo para quem vai entrar.";
const PROFILE_HAS_CREDITS =
  "Este perfil tem créditos registrados. Desative em vez de excluir, para manter o histórico.";
const DEMO_USER_EXPERT_MESSAGE =
  "Este e-mail pertence a um usuário de demonstração e não pode ser expert.";

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  gestor: "Gestor",
  member: "Membro",
  expert: "Expert",
};

// Tabelas/RPCs do expert ainda fora dos tipos gerados (ver cabeçalho).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any;

/** The house this request acts on, refused unless the caller administers it. */
export async function requireExpertAdminTenant(ctx: ServerContext) {
  const tenantId = await resolveOperationalTenantForRequest(
    ctx.supabase,
    ctx.userId,
    ctx.activeTenantId,
  );
  return requireTenantAdmin(ctx.supabase, tenantId, NOT_ADMIN_MESSAGE);
}

async function requireExpertAdminWriteTenant(ctx: ServerContext) {
  const tenantId = await requireExpertAdminTenant(ctx);
  await assertTenantNotDemo(tenantId);
  return tenantId;
}

async function expertHasCredits(tenantId: string, expertId: string): Promise<boolean> {
  const { count, error } = await db()
    .from("expert_deposit_credits")
    .select("deposit_id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("expert_id", expertId);
  if (error) throw new Error(error.message);
  return (count ?? 0) > 0;
}

/**
 * Os créditos de um perfil são a base da comissão de quem os gerou: um
 * perfil já vinculado antes (`ja_vinculado`) com créditos não passa para
 * outra pessoa (convite ou vínculo), senão o histórico dela iria junto. O
 * primeiro vínculo de um perfil nunca vinculado sempre funciona, mesmo com
 * créditos: é o fluxo normal (admin cria o perfil com IDs de afiliado, o
 * cron credita os depósitos, só depois a pessoa é convidada/vinculada).
 */
async function assertProfileHasNoCredits(
  tenantId: string,
  expertId: string,
  jaVinculado: boolean,
) {
  if (!jaVinculado) return;
  if (await expertHasCredits(tenantId, expertId)) throw new Error(PROFILE_HAS_OTHER_CREDITS);
}

export async function loadExpert(tenantId: string, expertId: string): Promise<ExpertDbRow> {
  const { data, error } = await db()
    .from("experts")
    .select(EXPERT_COLUMNS)
    .eq("id", expertId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(EXPERT_NOT_FOUND);
  return data as ExpertDbRow;
}

/**
 * Ordem da spec: sem usuário → equipe (a pessoa é admin, gestor ou membro
 * desta casa, não expert) → inativo → nunca entrou → ativo. `houseRole` é o
 * papel do `user_id` nesta casa (`houseRolesOf`), ou null se não houver.
 */
export function expertAcesso(
  row: { user_id: string | null; ativo: boolean },
  lastSignInAt: string | null | undefined,
  houseRole: string | null | undefined,
): ExpertAcesso {
  if (!row.user_id) return "sem_acesso";
  if (isHouseMemberRole(houseRole)) return "equipe";
  if (!row.ativo) return "inativo";
  if (!lastSignInAt) return "convite_pendente";
  return "ativo";
}

/**
 * `ExpertDbRow` + o que cada chamador já calculou (afiliados, contagem de
 * leads, acesso/e-mail) -> `ExpertAdminRow`. Único lugar que faz esse
 * mapeamento, para a tela de lista (`listExpertsFor`) e o detalhe do admin
 * (`getExpertDetailFor`, Fase 3 Task 3) nunca divergirem.
 */
export function buildExpertAdminRow(
  row: ExpertDbRow,
  extras: {
    affiliateIds: string[];
    leads: number;
    acesso: ExpertAcesso;
    papelEquipe: HouseMemberRole | null;
    email: string | null;
  },
): ExpertAdminRow {
  return {
    id: row.id,
    nome: row.nome,
    tipo: row.tipo,
    ativo: row.ativo,
    envioModo: row.envio_modo,
    tetoMensal: row.teto_mensal === null ? null : Number(row.teto_mensal),
    assumirPrazoDias: row.assumir_prazo_dias,
    affiliateIds: extras.affiliateIds,
    leads: extras.leads,
    acesso: extras.acesso,
    papelEquipe: extras.papelEquipe,
    email: extras.email,
    createdAt: row.created_at,
  };
}

export async function countExpertLeads(tenantId: string, tipo: ExpertTipo, affiliateIds: string[]) {
  if (tipo === "restrito" && affiliateIds.length === 0) return 0;
  let query = db()
    .from("players")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId);
  if (tipo === "restrito") query = query.in("affiliate_id", affiliateIds);
  const { count, error } = await query;
  if (error) throw new Error(error.message);
  return Number(count ?? 0);
}

/** user_id → papel nesta casa (um papel por pessoa por casa). */
export async function houseRolesOf(
  tenantId: string,
  userIds: Array<string | null>,
): Promise<Map<string, string>> {
  const ids = Array.from(new Set(userIds.filter((id): id is string => !!id)));
  if (ids.length === 0) return new Map();
  const { data, error } = await db()
    .from("user_roles")
    .select("user_id,role")
    .eq("tenant_id", tenantId)
    .in("user_id", ids);
  if (error) throw new Error(error.message);
  return new Map(
    ((data ?? []) as Array<{ user_id: string; role: string }>).map((r) => [r.user_id, r.role]),
  );
}

/** `acesso` + `papelEquipe` de um perfil, dado o papel do `user_id` na casa. */
export function expertAccessFields(
  row: { user_id: string | null; ativo: boolean },
  lastSignInAt: string | null | undefined,
  houseRole: string | null | undefined,
): { acesso: ExpertAcesso; papelEquipe: HouseMemberRole | null } {
  const acesso = expertAcesso(row, lastSignInAt, houseRole);
  return {
    acesso,
    papelEquipe: row.user_id && isHouseMemberRole(houseRole) ? houseRole : null,
  };
}

export async function authUserOf(userId: string | null) {
  if (!userId) return null;
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (error) {
    console.warn("[experts-admin] failed reading auth user", error.message);
    return null;
  }
  return data.user ?? null;
}

// ---------------------------------------------------------------- list

export const listExperts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => listExpertsFor(context as unknown as ServerContext));

export async function listExpertsFor(ctx: ServerContext): Promise<ExpertAdminRow[]> {
  const tenantId = await requireExpertAdminTenant(ctx);

  const [{ data: experts, error }, { data: links, error: linksErr }] = await Promise.all([
    db().from("experts").select(EXPERT_COLUMNS).eq("tenant_id", tenantId).order("nome"),
    db().from("expert_affiliates").select("expert_id,affiliate_id").eq("tenant_id", tenantId),
  ]);
  if (error) throw new Error(error.message);
  if (linksErr) throw new Error(linksErr.message);
  const expertRows = (experts ?? []) as ExpertDbRow[];
  const roles = await houseRolesOf(
    tenantId,
    expertRows.map((row) => row.user_id),
  );

  const idsByExpert = new Map<string, string[]>();
  for (const link of (links ?? []) as Array<{ expert_id: string; affiliate_id: string }>) {
    const ids = idsByExpert.get(link.expert_id) ?? [];
    ids.push(link.affiliate_id);
    idsByExpert.set(link.expert_id, ids);
  }

  return Promise.all(
    expertRows.map(async (row) => {
      const affiliateIds = (idsByExpert.get(row.id) ?? []).sort();
      const [leads, user] = await Promise.all([
        countExpertLeads(tenantId, row.tipo, affiliateIds),
        authUserOf(row.user_id),
      ]);
      return buildExpertAdminRow(row, {
        affiliateIds,
        leads,
        ...expertAccessFields(
          row,
          user?.last_sign_in_at,
          row.user_id ? roles.get(row.user_id) : null,
        ),
        email: user?.email ?? null,
      });
    }),
  );
}

export const listUnassignedAffiliates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => listUnassignedAffiliatesFor(context as unknown as ServerContext));

export async function listUnassignedAffiliatesFor(
  ctx: ServerContext,
): Promise<Array<{ affiliateId: string; leads: number }>> {
  const tenantId = await requireExpertAdminTenant(ctx);
  const { data, error } = await db().rpc("tenant_unassigned_affiliate_ids", {
    _tenant: tenantId,
    _limit: 20,
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{ affiliate_id: string; leads: number | string }>).map((row) => ({
    affiliateId: row.affiliate_id,
    leads: Number(row.leads),
  }));
}

// ---------------------------------------------------------------- save

const saveExpertInput = z.object({
  id: dbUuid().optional(),
  nome: z.string().trim().min(2).max(80),
  tipo: z.enum(["restrito", "total"]),
  affiliateIds: z.array(z.string().trim().min(1).max(64)).max(20),
  envioModo: z.enum(["livre", "aprovacao"]),
  tetoMensal: z.number().min(0).nullable(),
  assumirPrazoDias: z.number().int().min(1).max(30),
});

export const saveExpert = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => saveExpertInput.parse(data))
  .handler(async ({ data, context }) => saveExpertFor(context as unknown as ServerContext, data));

function affiliateTakenMessage(affiliateId: string | null) {
  return affiliateId
    ? `O ID de afiliado ${affiliateId} já pertence a outro expert desta casa.`
    : "Um dos IDs de afiliado já pertence a outro expert desta casa.";
}

/** pt-BR copy for the errors `save_expert` can raise (or a concurrent save can hit). */
function saveExpertError(error: DbError): Error {
  const message = error.message ?? "";
  const taken = /affiliate_taken:(.+)$/.exec(message);
  if (taken) return new Error(affiliateTakenMessage(taken[1].trim()));
  if (message.includes("expert_not_found")) return new Error(EXPERT_NOT_FOUND);
  if (message.includes("expert_nome_required")) return new Error("Informe o nome do expert.");
  if (error.code === "23505") {
    const where = `${message} ${error.details ?? ""}`;
    if (where.includes("experts_tenant_nome_uniq")) {
      return new Error("Já existe um expert com esse nome nesta casa.");
    }
    if (where.includes("affiliate_id")) {
      // Detail: `Key (tenant_id, affiliate_id)=(<uuid>, <id>) already exists.`
      const id = /\(tenant_id, affiliate_id\)=\([^,]+, (.+)\) already exists/.exec(
        error.details ?? "",
      );
      return new Error(affiliateTakenMessage(id ? id[1] : null));
    }
  }
  return new Error(message);
}

export async function saveExpertFor(
  ctx: ServerContext,
  data: z.input<typeof saveExpertInput>,
): Promise<{ id: string }> {
  const input = saveExpertInput.parse(data);
  const tenantId = await requireExpertAdminWriteTenant(ctx);

  const { data: expertId, error } = await db().rpc("save_expert", {
    _tenant: tenantId,
    _expert_id: input.id ?? null,
    _nome: input.nome,
    _tipo: input.tipo,
    _affiliate_ids: input.affiliateIds,
    _envio_modo: input.envioModo,
    _teto_mensal: input.tetoMensal,
    _assumir_prazo_dias: input.assumirPrazoDias,
  });
  if (error) throw saveExpertError(error);

  const id = String(expertId);
  await auditTenant({
    tenantId,
    actorUserId: ctx.userId,
    action: "expert.saved",
    entityType: "expert",
    entityId: id,
    after: { ...input, id },
    metadata: { created: !input.id },
  });
  return { id };
}

// ---------------------------------------------------------------- access

const inviteExpertInput = z.object({
  expertId: dbUuid(),
  email: z.string().trim().email().max(255),
});

export const inviteExpert = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => inviteExpertInput.parse(data))
  .handler(async ({ data, context }) => inviteExpertFor(context as unknown as ServerContext, data));

export async function inviteExpertFor(ctx: ServerContext, data: z.input<typeof inviteExpertInput>) {
  const input = inviteExpertInput.parse(data);
  const tenantId = await requireExpertAdminWriteTenant(ctx);
  const expert = await loadExpert(tenantId, input.expertId);
  if (expert.user_id) throw new Error(EXPERT_ALREADY_LINKED);
  // Before the lookup/invite: a refused profile never sends an e-mail.
  await assertProfileHasNoCredits(tenantId, expert.id, expert.ja_vinculado);

  const email = input.email.toLowerCase();
  // An invite is only sent for an e-mail with no auth user yet, and such a
  // user can be neither a super admin nor have a role here — so checking
  // after the lookup never leaves an invite behind a refusal.
  const { userId, created } = await findOrInviteUserByEmail(email, {
    invitedBy: ctx.userId,
    tenantId,
  });

  const { data: superAdmin, error: superErr } = await db().rpc("is_super_admin", {
    _user_id: userId,
  });
  if (superErr) throw new Error(superErr.message);
  if (superAdmin) throw new Error("Este e-mail é de um super admin.");

  const { data: roles, error: rolesErr } = await db()
    .from("user_roles")
    .select("id,role")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId);
  if (rolesErr) throw new Error(rolesErr.message);
  const existingRole = ((roles ?? []) as Array<{ role: string }>)[0]?.role;
  if (existingRole) {
    const label = ROLE_LABELS[existingRole] ?? existingRole;
    throw new Error(
      `Este e-mail já tem acesso a esta casa como ${label}. Uma pessoa não pode ter dois papéis na mesma casa.`,
    );
  }

  const { data: membership, error: roleErr } = await db()
    .from("user_roles")
    .insert({ user_id: userId, tenant_id: tenantId, role: "expert" })
    .select("id")
    .single();
  if (roleErr) {
    // The demo-user role trigger (20261018130000_demo_user_guard_role_cast).
    if ((roleErr.message ?? "").includes("DEMO_USER_ROLE_BLOCKED")) {
      throw new Error(DEMO_USER_EXPERT_MESSAGE);
    }
    throw new Error(roleErr.message);
  }
  const membershipId = (membership as { id: string }).id;

  // Link only while the expert is still unlinked: two concurrent invites
  // both pass the check above, and only one may win.
  const { data: linked, error: linkErr } = await db()
    .from("experts")
    .update({ user_id: userId, ja_vinculado: true })
    .eq("id", expert.id)
    .eq("tenant_id", tenantId)
    .is("user_id", null)
    .select("id");
  if (linkErr || ((linked ?? []) as unknown[]).length === 0) {
    // Undo the role so the person is not left as an expert of no expert.
    const { error: undoErr } = await db().from("user_roles").delete().eq("id", membershipId);
    if (undoErr) {
      console.error("[experts-admin] failed to undo the expert role of a failed invite", {
        tenantId,
        expertId: expert.id,
        membershipId,
        cause: undoErr,
      });
    }
    throw new Error(linkErr ? linkErr.message : EXPERT_ALREADY_LINKED);
  }

  await auditTenant({
    tenantId,
    actorUserId: ctx.userId,
    action: "expert.invited",
    entityType: "expert",
    entityId: expert.id,
    before: expert,
    after: { ...expert, user_id: userId, email },
    metadata: { auth_user_created: created },
  });
  return { ok: true, created };
}

const expertIdInput = z.object({ expertId: dbUuid() });

export const removeExpertAccess = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => expertIdInput.parse(data))
  .handler(async ({ data, context }) =>
    removeExpertAccessFor(context as unknown as ServerContext, data),
  );

export async function removeExpertAccessFor(
  ctx: ServerContext,
  data: z.input<typeof expertIdInput>,
) {
  const input = expertIdInput.parse(data);
  const tenantId = await requireExpertAdminWriteTenant(ctx);
  const expert = await loadExpert(tenantId, input.expertId);
  if (!expert.user_id) return { ok: true };

  const { error: roleErr } = await db()
    .from("user_roles")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("user_id", expert.user_id)
    .eq("role", "expert");
  if (roleErr) throw new Error(roleErr.message);

  const { error } = await db()
    .from("experts")
    .update({ user_id: null })
    .eq("id", expert.id)
    .eq("tenant_id", tenantId);
  if (error) throw new Error(error.message);

  await auditTenant({
    tenantId,
    actorUserId: ctx.userId,
    action: "expert.access_removed",
    entityType: "expert",
    entityId: expert.id,
    before: expert,
    after: { ...expert, user_id: null },
  });
  return { ok: true };
}

// ---------------------------------------------------------- team profile

const linkTeamInput = z.object({ expertId: dbUuid(), userId: dbUuid() });

export const linkExpertToTeamMember = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => linkTeamInput.parse(data))
  .handler(async ({ data, context }) =>
    linkExpertToTeamMemberFor(context as unknown as ServerContext, data),
  );

/**
 * Vincula um perfil sem usuário a alguém da equipe desta casa (perfil de
 * rendimento). Só grava `experts.user_id`: o papel da pessoa não muda.
 */
export async function linkExpertToTeamMemberFor(
  ctx: ServerContext,
  data: z.input<typeof linkTeamInput>,
) {
  const input = linkTeamInput.parse(data);
  const tenantId = await requireExpertAdminWriteTenant(ctx);

  const { data: roleRows, error: roleErr } = await db()
    .from("user_roles")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", input.userId)
    .in("role", [...HOUSE_MEMBER_ROLES]);
  if (roleErr) throw new Error(roleErr.message);
  const role = ((roleRows ?? []) as Array<{ role: string }>)[0]?.role;
  if (!isHouseMemberRole(role)) throw new Error(NOT_TEAM_MEMBER);

  const expert = await loadExpert(tenantId, input.expertId);
  if (expert.user_id) throw new Error(PROFILE_ALREADY_LINKED);
  await assertProfileHasNoCredits(tenantId, expert.id, expert.ja_vinculado);

  const { data: owned, error: ownedErr } = await db()
    .from("experts")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("user_id", input.userId)
    .limit(1);
  if (ownedErr) throw new Error(ownedErr.message);
  if (((owned ?? []) as unknown[]).length > 0) throw new Error(USER_ALREADY_HAS_PROFILE);

  // Only while still unlinked: a concurrent invite/link may have won. The
  // unique index experts_tenant_user_uniq refuses a second profile of the
  // same person in this house.
  const { data: linked, error: linkErr } = await db()
    .from("experts")
    .update({ user_id: input.userId, ja_vinculado: true })
    .eq("id", expert.id)
    .eq("tenant_id", tenantId)
    .is("user_id", null)
    .select("id");
  if (linkErr) {
    if (linkErr.code === "23505") throw new Error(USER_ALREADY_HAS_PROFILE);
    throw new Error(linkErr.message);
  }
  if (((linked ?? []) as unknown[]).length === 0) throw new Error(PROFILE_ALREADY_LINKED);

  await auditTenant({
    tenantId,
    actorUserId: ctx.userId,
    action: "expert.team_linked",
    entityType: "expert",
    entityId: expert.id,
    before: expert,
    after: { ...expert, user_id: input.userId },
    metadata: { papel: role },
  });
  return { ok: true };
}

export type TeamMemberForLinking = { userId: string; email: string; papel: HouseMemberRole };

export const listTeamMembersForLinking = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) =>
    listTeamMembersForLinkingFor(context as unknown as ServerContext),
  );

/** Equipe desta casa (admin, gestor, membro) que ainda não tem perfil aqui. */
export async function listTeamMembersForLinkingFor(
  ctx: ServerContext,
): Promise<TeamMemberForLinking[]> {
  const tenantId = await requireExpertAdminTenant(ctx);

  const [{ data: roleRows, error: roleErr }, { data: linkedRows, error: linkedErr }] =
    await Promise.all([
      db()
        .from("user_roles")
        .select("user_id,role")
        .eq("tenant_id", tenantId)
        .in("role", [...HOUSE_MEMBER_ROLES]),
      db().from("experts").select("user_id").eq("tenant_id", tenantId).not("user_id", "is", null),
    ]);
  if (roleErr) throw new Error(roleErr.message);
  if (linkedErr) throw new Error(linkedErr.message);

  const withProfile = new Set(
    ((linkedRows ?? []) as Array<{ user_id: string | null }>).map((r) => r.user_id),
  );
  const members = ((roleRows ?? []) as Array<{ user_id: string; role: string }>).filter(
    (r): r is { user_id: string; role: HouseMemberRole } =>
      !withProfile.has(r.user_id) && isHouseMemberRole(r.role),
  );

  const rows = await Promise.all(
    members.map(async (member) => {
      const user = await authUserOf(member.user_id);
      return user?.email ? { userId: member.user_id, email: user.email, papel: member.role } : null;
    }),
  );
  return rows
    .filter((row): row is TeamMemberForLinking => row !== null)
    .sort((a, b) => a.email.localeCompare(b.email));
}

// ---------------------------------------------------------------- status

const setActiveInput = z.object({ expertId: dbUuid(), ativo: z.boolean() });

export const setExpertActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => setActiveInput.parse(data))
  .handler(async ({ data, context }) =>
    setExpertActiveFor(context as unknown as ServerContext, data),
  );

export async function setExpertActiveFor(ctx: ServerContext, data: z.input<typeof setActiveInput>) {
  const input = setActiveInput.parse(data);
  const tenantId = await requireExpertAdminWriteTenant(ctx);
  const expert = await loadExpert(tenantId, input.expertId);

  // desativado_em: depósitos a partir dele não geram crédito para o perfil
  // (refresh_expert_credits). Desativar um perfil já inativo mantém a data
  // original; reativar limpa.
  const patch: { ativo: boolean; desativado_em?: string | null } = { ativo: input.ativo };
  if (input.ativo) patch.desativado_em = null;
  else if (expert.ativo) patch.desativado_em = new Date().toISOString();

  const { error } = await db()
    .from("experts")
    .update(patch)
    .eq("id", expert.id)
    .eq("tenant_id", tenantId);
  if (error) throw new Error(error.message);

  await auditTenant({
    tenantId,
    actorUserId: ctx.userId,
    action: input.ativo ? "expert.activated" : "expert.deactivated",
    entityType: "expert",
    entityId: expert.id,
    before: expert,
    after: { ...expert, ...patch },
  });
  return { ok: true };
}

export const deleteExpert = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => expertIdInput.parse(data))
  .handler(async ({ data, context }) => deleteExpertFor(context as unknown as ServerContext, data));

export async function deleteExpertFor(ctx: ServerContext, data: z.input<typeof expertIdInput>) {
  const input = expertIdInput.parse(data);
  const tenantId = await requireExpertAdminWriteTenant(ctx);
  const expert = await loadExpert(tenantId, input.expertId);

  // Fase 3: um perfil com crédito registrado (base da comissão) não pode ser
  // excluído, só desativado — para não apagar o histórico de comissão. O
  // delete_expert também recusa ('expert_has_credits') e a FK não cascateia.
  if (await expertHasCredits(tenantId, expert.id)) throw new Error(PROFILE_HAS_CREDITS);

  const { error } = await db().rpc("delete_expert", {
    _tenant: tenantId,
    _expert_id: expert.id,
  });
  if (error) {
    if ((error.message ?? "").includes("expert_has_user")) {
      throw new Error("Remova o acesso do expert antes de excluir.");
    }
    if ((error.message ?? "").includes("expert_has_credits")) {
      throw new Error(PROFILE_HAS_CREDITS);
    }
    throw new Error(error.message);
  }

  await auditTenant({
    tenantId,
    actorUserId: ctx.userId,
    action: "expert.deleted",
    entityType: "expert",
    entityId: expert.id,
    before: expert,
  });
  return { ok: true };
}
