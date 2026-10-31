// MCP financeiro, Task 9: screens — super admin access panel and the
// "Conectar ao Claude" page (spec §9). Every admin read/write here goes
// through `mcp_access`/`mcp_connections`/`mcp_oauth_clients` directly (no
// finance table involved — out of this file's global constraint), and every
// admin change writes one `mcp_call_log` row via `logCall`, with the super
// admin as `user_id` and no `connection_id` (an admin action is not an MCP
// connection).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isSuperAdminUser } from "@/lib/billing/billing-state.server";
import { dbUuid } from "@/lib/zod-helpers";

import { getMcpLevel, type McpLevel } from "./access.server";
import { logCall } from "./call-log.server";
import { isMcpEnabled } from "./config.server";
import { publicBaseUrlFromEnv, revokeConnection } from "./oauth.server";

/* eslint-disable @typescript-eslint/no-explicit-any -- loose client typing, same pattern as access.server.ts's db(). */
const db = () => supabaseAdmin as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const MCP_OFF = "Conexão com o Claude indisponível neste ambiente.";
const FORBIDDEN = "Apenas o super admin pode realizar esta ação.";
const CONNECTION_NOT_FOUND = "Conexão não encontrada.";

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
  mcpUrl: string;
  connections: ConnectionView[];
};

export async function getMyMcpStatusFor(ctx: { userId: string }): Promise<MyMcpStatus> {
  const enabled = isMcpEnabled();
  if (!enabled) {
    return { enabled, level: "none", mcpUrl: mcpUrl(), connections: [] };
  }
  const level = await getMcpLevel(ctx.userId);
  const connections = await connectionsOf(ctx.userId);
  return { enabled, level, mcpUrl: mcpUrl(), connections };
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
 * admin/owner/gestor in `user_roles`, finance viewers and group managers.
 * This never grants anything — the actual level comes from `mcp_access`,
 * read separately for each candidate.
 */
async function candidateUserIds(): Promise<string[]> {
  const { data: roleRows, error: roleError } = await db()
    .from("user_roles")
    .select("user_id, role")
    .in("role", ["super_admin", "admin", "owner", "gestor"]);
  if (roleError) throw new Error(roleError.message);
  const [viewerIds, managerIds] = await Promise.all([
    distinctUserIds("tenant_finance_viewers"),
    distinctUserIds("tenant_group_managers"),
  ]);
  const roleIds = ((roleRows ?? []) as Array<{ user_id: string }>).map((row) => row.user_id);
  return Array.from(new Set([...roleIds, ...viewerIds, ...managerIds]));
}

function displayName(user: AuthUser | undefined, userId: string): string {
  const meta = user?.user_metadata ?? {};
  const nome = meta.nome ?? meta.name ?? meta.full_name;
  if (typeof nome === "string" && nome.trim()) return nome.trim();
  return user?.email ?? userId;
}

export async function adminListMcpAccessFor(ctx: { userId: string }): Promise<McpAccessRow[]> {
  if (!(await isSuperAdminUser(ctx.userId))) throw new Error(FORBIDDEN);

  const userIds = await candidateUserIds();
  if (userIds.length === 0) return [];

  const [accessRows, connections, authResult] = await Promise.all([
    db().from("mcp_access").select("user_id, level").in("user_id", userIds),
    connectionsByUser(userIds),
    supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 }),
  ]);
  if (accessRows.error) throw new Error(accessRows.error.message);
  if (authResult.error) throw new Error(authResult.error.message);

  const levelByUser = new Map(
    ((accessRows.data ?? []) as Array<{ user_id: string; level: McpLevel }>).map((row) => [
      row.user_id,
      row.level,
    ]),
  );
  const authByUser = new Map((authResult.data?.users ?? []).map((user) => [user.id, user as AuthUser]));

  const rows: McpAccessRow[] = userIds.map((userId) => {
    const authUser = authByUser.get(userId);
    return {
      userId,
      nome: displayName(authUser, userId),
      email: authUser?.email ?? "",
      level: levelByUser.get(userId) ?? "none",
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

    if (data.level === "none") {
      const { error: deleteError } = await db().from("mcp_access").delete().eq("user_id", data.userId);
      if (deleteError) throw new Error(deleteError.message);
      const { data: conns, error: connError } = await db()
        .from("mcp_connections")
        .select("id")
        .eq("user_id", data.userId)
        .is("revoked_at", null);
      if (connError) throw new Error(connError.message);
      for (const conn of (conns ?? []) as Array<{ id: string }>) {
        await revokeConnection(conn.id);
      }
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
    await revokeConnection(data.connectionId);
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
