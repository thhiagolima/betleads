// MCP financeiro, Task 9: screens — super admin access panel and the
// "Conectar ao Claude" page (spec §9). Every admin read/write here goes
// through `mcp_access`/`mcp_connections`/`mcp_oauth_clients` directly (no
// finance table involved — out of this file's global constraint), and every
// admin change writes one `mcp_call_log` row via `logCall`, with the super
// admin as `user_id` and no `connection_id` (an admin action is not an MCP
// connection).
//
// MCP do grupo (spec 2026-11-17 §4.3): the super admin also picks each
// user's areas (Financeiro / Operação) — `adminSetMcpAreas`, audited as
// `mcp.areas_set`. Operação may only go to a super admin, the admin of some
// house or the manager of some group (`operacaoElegivel`).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { auditAdminAction } from "@/lib/admin-audit.server";
import { isSuperAdminUser } from "@/lib/billing/billing-state.server";
import { dbUuid } from "@/lib/zod-helpers";

import {
  MCP_AREAS,
  getMcpAccess,
  getMcpLevel,
  parseAreas,
  type McpArea,
  type McpLevel,
} from "./access.server";
import { logCall } from "./call-log.server";
import { isMcpEnabled } from "./config.server";
import { publicBaseUrlFromEnv, removeMcpAccessForUser, revokeConnection } from "./oauth.server";

/* eslint-disable @typescript-eslint/no-explicit-any -- loose client typing, same pattern as access.server.ts's db(). */
const db = () => supabaseAdmin as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const MCP_OFF = "Conexão com o Claude indisponível neste ambiente.";
const FORBIDDEN = "Apenas o super admin pode realizar esta ação.";
const CONNECTION_NOT_FOUND = "Conexão não encontrada.";
const AREAS_EMPTY = "Escolha pelo menos uma área.";
const AREAS_NO_LEVEL = "Conceda um nível de acesso antes de escolher as áreas.";
const OPS_NOT_ELIGIBLE =
  "A área de operação só pode ser liberada para super admin, admin de casa ou gestor de grupo.";

type ConnectionRow = {
  id: string;
  user_id: string;
  client_id: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

type ConnectionView = {
  id: string;
  clientName: string;
  createdAt: string;
  lastUsedAt: string | null;
};

async function clientNamesByIds(clientIds: string[]): Promise<Map<string, string>> {
  if (clientIds.length === 0) return new Map();
  const { data, error } = await db()
    .from("mcp_oauth_clients")
    .select("id, client_name")
    .in("id", Array.from(new Set(clientIds)));
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{ id: string; client_name: string | null }>;
  return new Map(rows.map((row) => [row.id, row.client_name ?? "Cliente MCP"]));
}

/** Non-revoked connections of `userId`, most recent first. */
async function connectionsOf(userId: string): Promise<ConnectionView[]> {
  const { data, error } = await db()
    .from("mcp_connections")
    .select("id, user_id, client_id, created_at, last_used_at, revoked_at")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as ConnectionRow[];
  const clientNames = await clientNamesByIds(rows.map((row) => row.client_id));
  return rows.map((row) => ({
    id: row.id,
    clientName: clientNames.get(row.client_id) ?? "Cliente MCP",
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }));
}

/** Non-revoked connections of several users at once, grouped by `user_id`. */
async function connectionsByUser(userIds: string[]): Promise<Map<string, ConnectionView[]>> {
  const out = new Map<string, ConnectionView[]>();
  if (userIds.length === 0) return out;
  const { data, error } = await db()
    .from("mcp_connections")
    .select("id, user_id, client_id, created_at, last_used_at, revoked_at")
    .in("user_id", Array.from(new Set(userIds)))
    .is("revoked_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as ConnectionRow[];
  const clientNames = await clientNamesByIds(rows.map((row) => row.client_id));
  for (const row of rows) {
    const view: ConnectionView = {
      id: row.id,
      clientName: clientNames.get(row.client_id) ?? "Cliente MCP",
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    };
    const list = out.get(row.user_id) ?? [];
    list.push(view);
    out.set(row.user_id, list);
  }
  return out;
}

/** `${base}/api/mcp`, `base` = VITE_PUBLIC_APP_URL without a trailing slash. */
function mcpUrl(): string {
  return `${publicBaseUrlFromEnv()}/api/mcp`;
}

// ---------------------------------------------------------------------------
// getMyMcpStatus
// ---------------------------------------------------------------------------

export type MyMcpStatus = {
  enabled: boolean;
  level: McpLevel;
  /** Areas granted (financeiro / operacao); drives the example questions on /mcp. */
  areas: McpArea[];
  mcpUrl: string;
  connections: ConnectionView[];
  /** True once any Claude connection of this user has called a tool (the tutorial's last step). */
  hasUsedTools: boolean;
};

/** Whether the user ever called a tool through a Claude connection (admin.* rows have no connection). */
async function hasUsedTools(userId: string): Promise<boolean> {
  const { data, error } = await db()
    .from("mcp_call_log")
    .select("id")
    .eq("user_id", userId)
    .not("connection_id", "is", null)
    .limit(1);
  if (error) return false;
  return (data ?? []).length > 0;
}

export async function getMyMcpStatusFor(ctx: { userId: string }): Promise<MyMcpStatus> {
  const enabled = isMcpEnabled();
  if (!enabled) {
    return {
      enabled,
      level: "none",
      areas: [],
      mcpUrl: mcpUrl(),
      connections: [],
      hasUsedTools: false,
    };
  }
  const [{ level, areas }, connections, used] = await Promise.all([
    getMcpAccess(ctx.userId),
    connectionsOf(ctx.userId),
    hasUsedTools(ctx.userId),
  ]);
  return {
    enabled,
    level,
    areas: level === "none" ? [] : areas,
    mcpUrl: mcpUrl(),
    connections,
    hasUsedTools: used,
  };
}

export const getMyMcpStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => getMyMcpStatusFor({ userId: context.userId }));

// ---------------------------------------------------------------------------
// revokeMyConnection
// ---------------------------------------------------------------------------

const revokeMyConnectionInput = z.object({ connectionId: dbUuid() });

export async function revokeMyConnectionFor(
  ctx: { userId: string },
  data: z.infer<typeof revokeMyConnectionInput>,
): Promise<{ ok: true }> {
  if (!isMcpEnabled()) throw new Error(MCP_OFF);
  const { data: conn, error } = await db()
    .from("mcp_connections")
    .select("id, user_id")
    .eq("id", data.connectionId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  // Same message whether the connection doesn't exist or belongs to someone
  // else — never confirms another user's connection id exists.
  if (!conn || conn.user_id !== ctx.userId) throw new Error(CONNECTION_NOT_FOUND);
  await revokeConnection(data.connectionId);
  return { ok: true };
}

export const revokeMyConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => revokeMyConnectionInput.parse(data))
  .handler(async ({ data, context }) => revokeMyConnectionFor({ userId: context.userId }, data));

// ---------------------------------------------------------------------------
// adminListMcpAccess
// ---------------------------------------------------------------------------

export type McpAccessRow = {
  userId: string;
  nome: string;
  email: string;
  level: McpLevel;
  areas: McpArea[];
  /** May receive the operação area: super admin, admin of a house or manager of a group. */
  operacaoElegivel: boolean;
  connections: ConnectionView[];
};

type AuthUser = {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
};

async function distinctUserIds(table: string, column = "user_id"): Promise<string[]> {
  const { data, error } = await db().from(table).select(column);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  return rows.map((row) => String(row[column]));
}

/**
 * Every user who could plausibly be given MCP access: super admins, any
 * admin/owner/gestor in `user_roles`, finance viewers and group managers —
 * plus which of them may get the operação area (super admin, admin of a
 * house, group manager: the same people `mcp_ops_tenant_ids` gives houses
 * to). This never grants anything — the actual level and areas come from
 * `mcp_access`, read separately for each candidate.
 */
async function candidateUserIds(): Promise<{ ids: string[]; opsEligible: Set<string> }> {
  const { data: roleRows, error: roleError } = await db()
    .from("user_roles")
    .select("user_id, role")
    .in("role", ["super_admin", "admin", "owner", "gestor"]);
  if (roleError) throw new Error(roleError.message);
  const [viewerIds, managerIds] = await Promise.all([
    distinctUserIds("tenant_finance_viewers"),
    distinctUserIds("tenant_group_managers"),
  ]);
  const roles = (roleRows ?? []) as Array<{ user_id: string; role: string }>;
  const roleIds = roles.map((row) => row.user_id);
  const opsEligible = new Set([
    ...roles
      .filter((row) => row.role === "super_admin" || row.role === "admin")
      .map((row) => row.user_id),
    ...managerIds,
  ]);
  return { ids: Array.from(new Set([...roleIds, ...viewerIds, ...managerIds])), opsEligible };
}

/** Whether `userId` may receive the operação area (see candidateUserIds). */
async function isOpsEligible(userId: string): Promise<boolean> {
  if (await isSuperAdminUser(userId)) return true;
  const [roles, managers] = await Promise.all([
    db()
      .from("user_roles")
      .select("user_id")
      .eq("user_id", userId)
      .eq("role", "admin")
      .not("tenant_id", "is", null)
      .limit(1),
    db().from("tenant_group_managers").select("user_id").eq("user_id", userId).limit(1),
  ]);
  if (roles.error) throw new Error(roles.error.message);
  if (managers.error) throw new Error(managers.error.message);
  return (roles.data ?? []).length > 0 || (managers.data ?? []).length > 0;
}

function displayName(user: AuthUser | undefined, userId: string): string {
  const meta = user?.user_metadata ?? {};
  const nome = meta.nome ?? meta.name ?? meta.full_name;
  if (typeof nome === "string" && nome.trim()) return nome.trim();
  return user?.email ?? userId;
}

export async function adminListMcpAccessFor(ctx: { userId: string }): Promise<McpAccessRow[]> {
  if (!(await isSuperAdminUser(ctx.userId))) throw new Error(FORBIDDEN);

  const { ids: userIds, opsEligible } = await candidateUserIds();
  if (userIds.length === 0) return [];

  const [accessRows, connections, authResult] = await Promise.all([
    db().from("mcp_access").select("user_id, level, areas").in("user_id", userIds),
    connectionsByUser(userIds),
    supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 }),
  ]);
  if (accessRows.error) throw new Error(accessRows.error.message);
  if (authResult.error) throw new Error(authResult.error.message);

  const accessByUser = new Map(
    (
      (accessRows.data ?? []) as Array<{ user_id: string; level: McpLevel; areas?: unknown }>
    ).map((row) => [row.user_id, { level: row.level, areas: parseAreas(row.areas) }]),
  );
  const authByUser = new Map((authResult.data?.users ?? []).map((user) => [user.id, user as AuthUser]));

  const rows: McpAccessRow[] = userIds.map((userId) => {
    const authUser = authByUser.get(userId);
    return {
      userId,
      nome: displayName(authUser, userId),
      email: authUser?.email ?? "",
      level: accessByUser.get(userId)?.level ?? "none",
      areas: accessByUser.get(userId)?.areas ?? ["financeiro"],
      operacaoElegivel: opsEligible.has(userId),
      connections: connections.get(userId) ?? [],
    };
  });

  return rows.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
}

export const adminListMcpAccess = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => adminListMcpAccessFor({ userId: context.userId }));

// ---------------------------------------------------------------------------
// adminSetMcpAccess
// ---------------------------------------------------------------------------

const adminSetMcpAccessInput = z.object({
  userId: dbUuid(),
  level: z.enum(["none", "read", "write"]),
});

export async function adminSetMcpAccessFor(
  ctx: { userId: string },
  data: z.infer<typeof adminSetMcpAccessInput>,
): Promise<{ ok: true }> {
  const start = Date.now();
  let ok = false;
  let errorMessage: string | undefined;
  try {
    if (!(await isSuperAdminUser(ctx.userId))) throw new Error(FORBIDDEN);

    const beforeLevel = await getMcpLevel(data.userId);
    if (data.level === "none") {
      await removeMcpAccessForUser(data.userId);
    } else {
      const { error: upsertError } = await db()
        .from("mcp_access")
        .upsert(
          {
            user_id: data.userId,
            level: data.level,
            granted_by: ctx.userId,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" },
        );
      if (upsertError) throw new Error(upsertError.message);
    }
    await auditAdminAction({
      actorUserId: ctx.userId,
      action: "mcp.access_set",
      targetUserId: data.userId,
      before: { level: beforeLevel },
      after: { level: data.level },
    });
    ok = true;
    return { ok: true };
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await logCall({
      identity: { userId: ctx.userId, connectionId: null },
      tool: "admin.set_access",
      tenantId: null,
      ok,
      error: errorMessage,
      durationMs: Date.now() - start,
    });
  }
}

export const adminSetMcpAccess = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => adminSetMcpAccessInput.parse(data))
  .handler(async ({ data, context }) => adminSetMcpAccessFor({ userId: context.userId }, data));

// ---------------------------------------------------------------------------
// adminSetMcpAreas
// ---------------------------------------------------------------------------

const adminSetMcpAreasInput = z.object({
  userId: dbUuid(),
  areas: z.array(z.enum(MCP_AREAS)),
});

/**
 * Sets which MCP areas a user with access may use. Needs an existing access
 * level (areas live on the mcp_access row), at least one area, and operação
 * only for an eligible user. Audited as `mcp.areas_set` with before/after,
 * like a level change.
 */
export async function adminSetMcpAreasFor(
  ctx: { userId: string },
  data: z.infer<typeof adminSetMcpAreasInput>,
): Promise<{ ok: true }> {
  const start = Date.now();
  let ok = false;
  let errorMessage: string | undefined;
  try {
    if (!(await isSuperAdminUser(ctx.userId))) throw new Error(FORBIDDEN);
    const areas = MCP_AREAS.filter((area) => data.areas.includes(area));
    if (areas.length === 0) throw new Error(AREAS_EMPTY);

    const before = await getMcpAccess(data.userId);
    if (before.level === "none") throw new Error(AREAS_NO_LEVEL);
    if (areas.includes("operacao") && !(await isOpsEligible(data.userId))) {
      throw new Error(OPS_NOT_ELIGIBLE);
    }

    const { error: updateError } = await db()
      .from("mcp_access")
      .update({ areas, granted_by: ctx.userId, updated_at: new Date().toISOString() })
      .eq("user_id", data.userId);
    if (updateError) throw new Error(updateError.message);

    await auditAdminAction({
      actorUserId: ctx.userId,
      action: "mcp.areas_set",
      targetUserId: data.userId,
      before: { areas: before.areas },
      after: { areas },
    });
    ok = true;
    return { ok: true };
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await logCall({
      identity: { userId: ctx.userId, connectionId: null },
      tool: "admin.set_areas",
      tenantId: null,
      ok,
      error: errorMessage,
      durationMs: Date.now() - start,
      args: data,
    });
  }
}

export const adminSetMcpAreas = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => adminSetMcpAreasInput.parse(data))
  .handler(async ({ data, context }) => adminSetMcpAreasFor({ userId: context.userId }, data));

// ---------------------------------------------------------------------------
// adminRevokeConnection
// ---------------------------------------------------------------------------

const adminRevokeConnectionInput = z.object({ connectionId: dbUuid() });

export async function adminRevokeConnectionFor(
  ctx: { userId: string },
  data: z.infer<typeof adminRevokeConnectionInput>,
): Promise<{ ok: true }> {
  const start = Date.now();
  let ok = false;
  let errorMessage: string | undefined;
  try {
    if (!(await isSuperAdminUser(ctx.userId))) throw new Error(FORBIDDEN);
    const { data: conn, error: connError } = await db()
      .from("mcp_connections")
      .select("id, user_id")
      .eq("id", data.connectionId)
      .maybeSingle();
    if (connError) throw new Error(connError.message);
    if (!conn) throw new Error(CONNECTION_NOT_FOUND);
    await revokeConnection(data.connectionId);
    await auditAdminAction({
      actorUserId: ctx.userId,
      action: "mcp.connection_revoked",
      targetUserId: conn.user_id,
      after: { connection_id: data.connectionId },
    });
    ok = true;
    return { ok: true };
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await logCall({
      identity: { userId: ctx.userId, connectionId: null },
      tool: "admin.revoke_connection",
      tenantId: null,
      ok,
      error: errorMessage,
      durationMs: Date.now() - start,
    });
  }
}

export const adminRevokeConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => adminRevokeConnectionInput.parse(data))
  .handler(async ({ data, context }) => adminRevokeConnectionFor({ userId: context.userId }, data));
