// Grupos de casas: super-admin group management and the group manager's
// people view. Spec: docs/superpowers/specs/2026-10-24-grupos-de-casas-design.md
// (sections 3 and 4).
//
// None of these call assertTenantNotDemo: the demo house joins a demo group on
// purpose, and the SQL triggers (GROUP_DEMO_MISMATCH, DEMO_USER_GROUP_VIOLATION)
// keep demo and real apart. People changes inside a house still go through
// tenants.functions.ts, which keeps its demo guard.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { auditAdminAction } from "@/lib/admin-audit.server";
import {
  checkFinanceCanView,
  findAuthUserByEmail,
  listAuthUsersById,
  listTenantMembers,
  managedGroupIds,
} from "@/lib/tenants.functions";
import { dbUuid } from "@/lib/zod-helpers";

type DbError = { message: string; code?: string };
type DbResult<T = unknown> = { data: T | null; error: DbError | null };
type QueryBuilder<T = unknown> = PromiseLike<DbResult<T>> & {
  select: (columns?: string) => QueryBuilder<T>;
  eq: (column: string, value: unknown) => QueryBuilder<T>;
  in: (column: string, values: unknown[]) => QueryBuilder<T>;
  order: (column: string, options?: unknown) => QueryBuilder<T>;
  maybeSingle: () => Promise<DbResult<T>>;
  single: () => Promise<DbResult<T>>;
  insert: (values: unknown) => QueryBuilder<T>;
  update: (values: unknown) => QueryBuilder<T>;
  delete: () => QueryBuilder<T>;
};
type LooseDb = {
  rpc: <T = unknown>(fn: string, args?: Record<string, unknown>) => Promise<DbResult<T>>;
  from: <T = unknown>(table: string) => QueryBuilder<T>;
};
type ServerContext = { userId: string };

type GroupRow = { id: string; nome: string; is_demo: boolean | null };
type GroupTenantRow = { group_id: string; tenant_id: string };
type GroupManagerRow = { group_id: string; user_id: string };
type TenantLite = { id: string; nome: string; is_demo: boolean | null };

const db = () => supabaseAdmin as unknown as LooseDb;
const UNIQUE_VIOLATION = "23505";

const byNome = <T extends { nome: string }>(a: T, b: T) => a.nome.localeCompare(b.nome, "pt-BR");

async function assertSuperAdmin(userId: string) {
  const { data, error } = await db().rpc<boolean>("is_super_admin", { _user_id: userId });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Apenas o super admin pode gerenciar grupos");
}

async function getGroup(groupId: string) {
  const { data, error } = await db()
    .from<GroupRow>("tenant_groups")
    .select("id,nome,is_demo")
    .eq("id", groupId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Grupo não encontrado");
  return data;
}

async function groupTenantIds(groupId: string) {
  const { data, error } = await db()
    .from<GroupTenantRow[]>("tenant_group_tenants")
    .select("group_id,tenant_id")
    .eq("group_id", groupId);
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => row.tenant_id);
}

// ─── Super admin ────────────────────────────────────────────────────────────

export async function listGroupsAdminFor(ctx: ServerContext) {
  await assertSuperAdmin(ctx.userId);
  const [groupsRes, linksRes, managersRes, tenantsRes] = await Promise.all([
    db().from<GroupRow[]>("tenant_groups").select("id,nome,is_demo").order("nome"),
    db().from<GroupTenantRow[]>("tenant_group_tenants").select("group_id,tenant_id"),
    db().from<GroupManagerRow[]>("tenant_group_managers").select("group_id,user_id"),
    db().from<TenantLite[]>("tenants").select("id,nome,is_demo").order("nome"),
  ]);
  for (const res of [groupsRes, linksRes, managersRes, tenantsRes]) {
    if (res.error) throw new Error(res.error.message);
  }
  const links = linksRes.data ?? [];
  const managers = managersRes.data ?? [];
  const tenants = [...(tenantsRes.data ?? [])].sort(byNome);
  const tenantById = new Map(tenants.map((tenant) => [tenant.id, tenant]));
  const emails = await listAuthUsersById([...new Set(managers.map((m) => m.user_id))]);

  const groups = [...(groupsRes.data ?? [])].sort(byNome).map((group) => ({
    id: group.id,
    nome: group.nome,
    is_demo: group.is_demo === true,
    tenants: links
      .filter((link) => link.group_id === group.id)
      .map((link) => tenantById.get(link.tenant_id))
      .filter((tenant): tenant is TenantLite => !!tenant)
      .sort(byNome)
      .map((tenant) => ({ id: tenant.id, nome: tenant.nome })),
    managers: managers
      .filter((manager) => manager.group_id === group.id)
      .map((manager) => ({
        user_id: manager.user_id,
        email: emails.get(manager.user_id)?.email ?? null,
      })),
  }));
  const grouped = new Set(links.map((link) => link.tenant_id));
  const ungroupedTenants = tenants
    .filter((tenant) => !grouped.has(tenant.id))
    .map((tenant) => ({ id: tenant.id, nome: tenant.nome, is_demo: tenant.is_demo === true }));

  return { groups, ungroupedTenants };
}

export const listGroupsAdmin = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => listGroupsAdminFor(context as unknown as ServerContext));

const groupNome = z.string().trim().min(2).max(160);

const createGroupInput = z.object({ nome: groupNome, isDemo: z.boolean().default(false) });

export async function createGroupFor(ctx: ServerContext, data: z.infer<typeof createGroupInput>) {
  await assertSuperAdmin(ctx.userId);
  const { data: group, error } = await db()
    .from<GroupRow>("tenant_groups")
    .insert({ nome: data.nome, is_demo: data.isDemo, created_by: ctx.userId })
    .select("id,nome,is_demo")
    .single();
  if (error) throw new Error(error.message);
  if (!group) throw new Error("Falha ao criar grupo");
  await auditAdminAction({ actorUserId: ctx.userId, action: "group.created", after: group });
  return { id: group.id };
}

export const createGroup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => createGroupInput.parse(data))
  .handler(async ({ data, context }) => createGroupFor(context as unknown as ServerContext, data));

const renameGroupInput = z.object({ groupId: dbUuid(), nome: groupNome });

export async function renameGroupFor(ctx: ServerContext, data: z.infer<typeof renameGroupInput>) {
  await assertSuperAdmin(ctx.userId);
  const before = await getGroup(data.groupId);
  const { error } = await db()
    .from("tenant_groups")
    .update({ nome: data.nome })
    .eq("id", data.groupId);
  if (error) throw new Error(error.message);
  await auditAdminAction({
    actorUserId: ctx.userId,
    action: "group.renamed",
    before,
    after: { ...before, nome: data.nome },
  });
  return { ok: true };
}

export const renameGroup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => renameGroupInput.parse(data))
  .handler(async ({ data, context }) => renameGroupFor(context as unknown as ServerContext, data));

const groupIdInput = z.object({ groupId: dbUuid() });

export async function deleteGroupFor(ctx: ServerContext, data: z.infer<typeof groupIdInput>) {
  await assertSuperAdmin(ctx.userId);
  const before = await getGroup(data.groupId);
  const tenantIds = await groupTenantIds(data.groupId);
  const { error } = await db().from("tenant_groups").delete().eq("id", data.groupId);
  if (error) throw new Error(error.message);
  await auditAdminAction({
    actorUserId: ctx.userId,
    action: "group.deleted",
    before: { ...before, tenant_ids: tenantIds },
  });
  return { ok: true };
}

export const deleteGroup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => groupIdInput.parse(data))
  .handler(async ({ data, context }) => deleteGroupFor(context as unknown as ServerContext, data));

const setGroupTenantsInput = z.object({
  groupId: dbUuid(),
  tenantIds: z.array(dbUuid()).max(500),
});

/**
 * Replaces the group's houses. Additions are inserted first, so a house that
 * already belongs to another group (unique tenant_id) fails before anything is
 * removed.
 */
export async function setGroupTenantsFor(
  ctx: ServerContext,
  data: z.infer<typeof setGroupTenantsInput>,
) {
  await assertSuperAdmin(ctx.userId);
  await getGroup(data.groupId);
  const current = await groupTenantIds(data.groupId);
  const wanted = [...new Set(data.tenantIds)];
  const toAdd = wanted.filter((id) => !current.includes(id));
  const toRemove = current.filter((id) => !wanted.includes(id));

  if (toAdd.length) {
    const { error } = await db()
      .from("tenant_group_tenants")
      .insert(toAdd.map((tenantId) => ({ group_id: data.groupId, tenant_id: tenantId })));
    if (error) {
      if (error.code === UNIQUE_VIOLATION) throw new Error("A casa já pertence a outro grupo");
      throw new Error(error.message);
    }
  }
  if (toRemove.length) {
    const { error } = await db()
      .from("tenant_group_tenants")
      .delete()
      .eq("group_id", data.groupId)
      .in("tenant_id", toRemove);
    if (error) throw new Error(error.message);
  }

  await auditAdminAction({
    actorUserId: ctx.userId,
    action: "group.tenants_changed",
    before: { group_id: data.groupId, tenant_ids: current },
    after: { group_id: data.groupId, tenant_ids: wanted },
  });
  return { ok: true };
}

export const setGroupTenants = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => setGroupTenantsInput.parse(data))
  .handler(async ({ data, context }) =>
    setGroupTenantsFor(context as unknown as ServerContext, data),
  );

const addGroupManagerInput = z.object({ groupId: dbUuid(), email: z.string().email().max(255) });

/** Names an existing user (never invites) as manager of the group. */
export async function addGroupManagerFor(
  ctx: ServerContext,
  data: z.infer<typeof addGroupManagerInput>,
) {
  await assertSuperAdmin(ctx.userId);
  await getGroup(data.groupId);
  const user = await findAuthUserByEmail(data.email);
  if (!user) throw new Error("Usuário não encontrado");

  const { data: targetIsSuperAdmin, error: superErr } = await db().rpc<boolean>("is_super_admin", {
    _user_id: user.id,
  });
  if (superErr) throw new Error(superErr.message);
  if (targetIsSuperAdmin) {
    throw new Error("Não é permitido vincular um superadmin global por esta área");
  }

  const { data: existing, error: existingErr } = await db()
    .from<GroupManagerRow>("tenant_group_managers")
    .select("group_id,user_id")
    .eq("group_id", data.groupId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (existingErr) throw new Error(existingErr.message);
  if (existing) return { ok: true, existing: true };

  const { error } = await db()
    .from("tenant_group_managers")
    .insert({ group_id: data.groupId, user_id: user.id, created_by: ctx.userId });
  if (error) throw new Error(error.message);

  await auditAdminAction({
    actorUserId: ctx.userId,
    action: "group.manager_added",
    targetUserId: user.id,
    after: { group_id: data.groupId, user_id: user.id, email: user.email ?? null },
  });
  return { ok: true, existing: false };
}

export const addGroupManager = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => addGroupManagerInput.parse(data))
  .handler(async ({ data, context }) =>
    addGroupManagerFor(context as unknown as ServerContext, data),
  );

const removeGroupManagerInput = z.object({ groupId: dbUuid(), userId: dbUuid() });

export async function removeGroupManagerFor(
  ctx: ServerContext,
  data: z.infer<typeof removeGroupManagerInput>,
) {
  await assertSuperAdmin(ctx.userId);
  const { data: before, error: beforeErr } = await db()
    .from<GroupManagerRow>("tenant_group_managers")
    .select("group_id,user_id")
    .eq("group_id", data.groupId)
    .eq("user_id", data.userId)
    .maybeSingle();
  if (beforeErr) throw new Error(beforeErr.message);
  if (!before) throw new Error("Gestor do grupo não encontrado");

  const { error } = await db()
    .from("tenant_group_managers")
    .delete()
    .eq("group_id", data.groupId)
    .eq("user_id", data.userId);
  if (error) throw new Error(error.message);

  await auditAdminAction({
    actorUserId: ctx.userId,
    action: "group.manager_removed",
    targetUserId: data.userId,
    before,
  });
  return { ok: true };
}

export const removeGroupManager = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => removeGroupManagerInput.parse(data))
  .handler(async ({ data, context }) =>
    removeGroupManagerFor(context as unknown as ServerContext, data),
  );

// ─── Group manager ──────────────────────────────────────────────────────────

/**
 * People of every house in a group the caller manages (super admin: any
 * group). Read-only; changes go through tenants.functions.ts, whose
 * canManageTenant accepts the group manager for these houses only.
 */
export async function getGroupPeopleFor(ctx: ServerContext, data: z.infer<typeof groupIdInput>) {
  const managed = await managedGroupIds(ctx.userId);
  if (!managed.includes(data.groupId)) throw new Error("Sem permissão para ver este grupo");

  const tenantIds = await groupTenantIds(data.groupId);
  if (!tenantIds.length) return { tenants: [] };

  const { data: tenantRows, error } = await db()
    .from<TenantLite[]>("tenants")
    .select("id,nome,is_demo")
    .in("id", tenantIds)
    .order("nome");
  if (error) throw new Error(error.message);

  const tenants = await Promise.all(
    [...(tenantRows ?? [])].sort(byNome).map(async (tenant) => {
      const members = await listTenantMembers(tenant.id);
      return {
        id: tenant.id,
        nome: tenant.nome,
        is_demo: tenant.is_demo === true,
        members: await Promise.all(
          members.map(async (member) => ({
            membership_id: member.id,
            user_id: member.user_id,
            email: member.email ?? null,
            role: member.role,
            canViewFinance: await checkFinanceCanView(member.user_id, tenant.id),
          })),
        ),
      };
    }),
  );
  return { tenants };
}

export const getGroupPeople = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => groupIdInput.parse(data))
  .handler(async ({ data, context }) =>
    getGroupPeopleFor(context as unknown as ServerContext, data),
  );
