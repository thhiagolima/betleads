// MCP financeiro: access level lookup and bearer token resolution.
// Access level always comes from the DB (mcp_access), never from the token
// itself (global-constraints.md). resolveBearer hashes the incoming token
// with sha256Hex and looks up mcp_tokens by that hash only.
//
// MCP do grupo (docs/superpowers/specs/2026-11-17-mcp-grupo-design.md §4.3):
// the identity also carries `areas` (financeiro / operacao), read from
// mcp_access on every call like the level, so the super admin turning an
// area off takes effect on the very next call.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { sha256Hex } from "./crypto.server";

export type McpLevel = "none" | "read" | "write";

export const MCP_AREAS = ["financeiro", "operacao"] as const;
export type McpArea = (typeof MCP_AREAS)[number];

export type McpIdentity = {
  userId: string;
  connectionId: string;
  clientId: string;
  level: Exclude<McpLevel, "none">;
  areas: McpArea[];
};

const AREA_LABEL: Record<McpArea, string> = { financeiro: "financeiro", operacao: "operação" };

/**
 * Known areas of a stored `mcp_access.areas`, in canonical order. A missing
 * or empty value means the column default (`{financeiro}`): rows granted
 * before the area column existed only ever had the finance tools.
 */
export function parseAreas(value: unknown): McpArea[] {
  const list = Array.isArray(value) ? value : [];
  const areas = MCP_AREAS.filter((area) => list.includes(area));
  return areas.length ? areas : ["financeiro"];
}

/** Throws the pt-BR area message when the identity lacks `area` (spec §4.3). */
export function assertArea(identity: Pick<McpIdentity, "areas">, area: McpArea): void {
  if (!identity.areas.includes(area)) {
    throw new Error(`Seu acesso ao MCP não inclui ${AREA_LABEL[area]}.`);
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any -- loose client typing, same pattern as finance-data.server.ts's db(). */
const db = () => supabaseAdmin as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export type McpAccess = { level: McpLevel; areas: McpArea[] };

/**
 * Current access level and areas for `userId`. Absence of a row in
 * mcp_access means level "none" (areas are then meaningless; reported as the
 * column default).
 */
export async function getMcpAccess(userId: string): Promise<McpAccess> {
  const { data, error } = await db()
    .from("mcp_access")
    .select("level, areas")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return { level: "none", areas: ["financeiro"] };
  return { level: data.level as McpLevel, areas: parseAreas(data.areas) };
}

/** Current access level for `userId`. Absence of a row in mcp_access means "none". */
export async function getMcpLevel(userId: string): Promise<McpLevel> {
  return (await getMcpAccess(userId)).level;
}

/**
 * Resolves a bearer token to its MCP identity. Null when: the hash is
 * unknown, the token's kind isn't "access", it's expired, its connection is
 * revoked, or the user's current level is "none". Level and areas come
 * from mcp_access at this moment, never from the token. On success, bumps
 * mcp_connections.last_used_at.
 */
export async function resolveBearer(token: string): Promise<McpIdentity | null> {
  const tokenHash = await sha256Hex(token);
  const nowIso = new Date().toISOString();

  const { data: tokenRow, error: tokenError } = await db()
    .from("mcp_tokens")
    .select("connection_id, kind, expires_at")
    .eq("token_hash", tokenHash)
    .eq("kind", "access")
    .gt("expires_at", nowIso)
    .maybeSingle();
  if (tokenError || !tokenRow) return null;

  const { data: connRow, error: connError } = await db()
    .from("mcp_connections")
    .select("id, user_id, client_id, revoked_at")
    .eq("id", tokenRow.connection_id)
    .is("revoked_at", null)
    .maybeSingle();
  if (connError || !connRow) return null;

  const { level, areas } = await getMcpAccess(connRow.user_id);
  if (level === "none") return null;

  await db().from("mcp_connections").update({ last_used_at: nowIso }).eq("id", connRow.id);

  return {
    userId: connRow.user_id,
    connectionId: connRow.id,
    clientId: connRow.client_id,
    level,
    areas,
  };
}
