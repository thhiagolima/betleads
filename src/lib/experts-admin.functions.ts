// Server functions do admin da casa para configurar experts (Área do Expert,
// Fase 1, Task 6): listar, salvar, convidar, remover acesso, ativar/
// desativar e excluir.
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

export type ExpertAcesso = "sem_acesso" | "convite_pendente" | "ativo" | "inativo";
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
  created_at: string;
};

const EXPERT_COLUMNS =
  "id,tenant_id,nome,tipo,ativo,envio_modo,teto_mensal,assumir_prazo_dias,user_id,created_at";

const NOT_ADMIN_MESSAGE = "Apenas o admin da casa gerencia experts.";
const EXPERT_NOT_FOUND = "Expert não encontrado.";
const EXPERT_ALREADY_LINKED =
  "Este expert já tem acesso. Remova o acesso antes de convidar outra pessoa.";
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

/** Ordem da spec: sem usuário → inativo → nunca entrou → ativo. */
export function expertAcesso(
  row: { user_id: string | null; ativo: boolean },
  lastSignInAt: string | null | undefined,
): ExpertAcesso {
  if (!row.user_id) return "sem_acesso";
  if (!row.ativo) return "inativo";
  if (!lastSignInAt) return "convite_pendente";
  return "ativo";
}

export async function countExpertLeads(
  tenantId: string,
  tipo: ExpertTipo,
  affiliateIds: string[],
) {
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

  const idsByExpert = new Map<string, string[]>();
  for (const link of (links ?? []) as Array<{ expert_id: string; affiliate_id: string }>) {
    const ids = idsByExpert.get(link.expert_id) ?? [];
    ids.push(link.affiliate_id);
    idsByExpert.set(link.expert_id, ids);
  }

  return Promise.all(
    ((experts ?? []) as ExpertDbRow[]).map(async (row) => {
      const affiliateIds = (idsByExpert.get(row.id) ?? []).sort();
      const [leads, user] = await Promise.all([
        countExpertLeads(tenantId, row.tipo, affiliateIds),
        authUserOf(row.user_id),
      ]);
      return {
        id: row.id,
        nome: row.nome,
        tipo: row.tipo,
        ativo: row.ativo,
        envioModo: row.envio_modo,
        tetoMensal: row.teto_mensal === null ? null : Number(row.teto_mensal),
        assumirPrazoDias: row.assumir_prazo_dias,
        affiliateIds,
        leads,
        acesso: expertAcesso(row, user?.last_sign_in_at),
        email: user?.email ?? null,
        createdAt: row.created_at,
      };
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
    .update({ user_id: userId })
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

  const { error } = await db()
    .from("experts")
    .update({ ativo: input.ativo })
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
    after: { ...expert, ativo: input.ativo },
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

  const { error } = await db().rpc("delete_expert", {
    _tenant: tenantId,
    _expert_id: expert.id,
  });
  if (error) {
    if ((error.message ?? "").includes("expert_has_user")) {
      throw new Error("Remova o acesso do expert antes de excluir.");
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
