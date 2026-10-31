// MCP financeiro: scope listing (Task 5). listFinanceScopesFor is LIST-ONLY —
// it never grants anything by itself; every MCP tool re-checks permission on
// its own, through the existing can/requirePermission helpers below. See
// docs/superpowers/specs/2026-10-30-mcp-financeiro-design.md §3-4.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { can } from "@/lib/finance/finance-data.server";
import { managedGroupIds } from "@/lib/tenants.functions";

type DbError = { message: string };
type DbResult<T = unknown> = { data: T | null; error: DbError | null };
type QueryBuilder<T = unknown> = PromiseLike<DbResult<T>> & {
  select: (columns?: string) => QueryBuilder<T>;
  eq: (column: string, value: unknown) => QueryBuilder<T>;
  in: (column: string, values: unknown[]) => QueryBuilder<T>;
  not: (column: string, operator: string, value: unknown) => QueryBuilder<T>;
};
type LooseDb = {
  rpc: <T = unknown>(fn: string, args?: Record<string, unknown>) => Promise<DbResult<T>>;
  from: <T = unknown>(table: string) => QueryBuilder<T>;
};

const db = () => supabaseAdmin as unknown as LooseDb;

export type FinanceScopes = {
  superAdmin: boolean;
  houses: Array<{ id: string; nome: string; isDemo: boolean; status: string | null }>;
  groups: Array<{ id: string; nome: string; isDemo: boolean }>;
};

type TenantRow = { id: string; nome: string; is_demo: boolean | null; status: string | null };
type GroupRow = { id: string; nome: string; is_demo: boolean | null };

async function isSuperAdmin(userId: string): Promise<boolean> {
  const { data, error } = await db().rpc<boolean>("is_super_admin", { _user_id: userId });
  if (error) throw new Error(error.message);
  return data === true;
}

const sortByNome = <T extends { nome: string }>(rows: T[]) =>
  [...rows].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));

const toHouse = (row: TenantRow) => ({
  id: row.id,
  nome: row.nome,
  isDemo: row.is_demo === true,
  status: row.status ?? null,
});

const toGroup = (row: GroupRow) => ({
  id: row.id,
  nome: row.nome,
  isDemo: row.is_demo === true,
});

async function allTenants(): Promise<TenantRow[]> {
  const { data, error } = await db().from<TenantRow[]>("tenants").select("id,nome,is_demo,status");
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function tenantsByIds(ids: string[]): Promise<TenantRow[]> {
  if (!ids.length) return [];
  const { data, error } = await db()
    .from<TenantRow[]>("tenants")
    .select("id,nome,is_demo,status")
    .in("id", ids);
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function allGroups(): Promise<GroupRow[]> {
  const { data, error } = await db().from<GroupRow[]>("tenant_groups").select("id,nome,is_demo");
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function groupsByIds(ids: string[]): Promise<GroupRow[]> {
  if (!ids.length) return [];
  const { data, error } = await db()
    .from<GroupRow[]>("tenant_groups")
    .select("id,nome,is_demo")
    .in("id", ids);
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function tenantIdsOfUserRoles(userId: string): Promise<string[]> {
  const { data, error } = await db()
    .from<Array<{ tenant_id: string }>>("user_roles")
    .select("tenant_id")
    .eq("user_id", userId)
    .not("tenant_id", "is", null);
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => row.tenant_id);
}

async function tenantIdsOfFinanceViewer(userId: string): Promise<string[]> {
  const { data, error } = await db()
    .from<Array<{ tenant_id: string }>>("tenant_finance_viewers")
    .select("tenant_id")
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => row.tenant_id);
}

async function tenantIdsOfGroups(groupIds: string[]): Promise<string[]> {
  if (!groupIds.length) return [];
  const { data, error } = await db()
    .from<Array<{ tenant_id: string }>>("tenant_group_tenants")
    .select("tenant_id")
    .in("group_id", groupIds);
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => row.tenant_id);
}

/**
 * Scopes `userId` may act on. A super admin gets every tenant (demo/inactive
 * marked as-is) and every group. Otherwise: candidate houses are the union of
 * `user_roles` memberships, `tenant_finance_viewers` grants and the houses of
 * the groups the user manages, kept only where `finance_can_view` actually
 * holds — this function never grants anything by itself, it only lists what
 * each later tool's own permission check (`can`/`requirePermission`) would
 * allow. Groups are simply the ones the user manages.
 */
export async function listFinanceScopesFor(userId: string): Promise<FinanceScopes> {
  const superAdmin = await isSuperAdmin(userId);

  if (superAdmin) {
    const [tenants, groups] = await Promise.all([allTenants(), allGroups()]);
    return {
      superAdmin,
      houses: sortByNome(tenants.map(toHouse)),
      groups: sortByNome(groups.map(toGroup)),
    };
  }

  const groupIds = await managedGroupIds(userId);
  const [roleIds, viewerIds, groupHouseIds] = await Promise.all([
    tenantIdsOfUserRoles(userId),
    tenantIdsOfFinanceViewer(userId),
    tenantIdsOfGroups(groupIds),
  ]);
  const candidateIds = Array.from(new Set([...roleIds, ...viewerIds, ...groupHouseIds]));

  const allowedIds: string[] = [];
  await Promise.all(
    candidateIds.map(async (id) => {
      if (await can("finance_can_view", userId, id)) allowedIds.push(id);
    }),
  );

  const [tenants, groups] = await Promise.all([tenantsByIds(allowedIds), groupsByIds(groupIds)]);

  return {
    superAdmin,
    houses: sortByNome(tenants.map(toHouse)),
    groups: sortByNome(groups.map(toGroup)),
  };
}
