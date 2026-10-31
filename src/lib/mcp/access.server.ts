// MCP financeiro: access level lookup and bearer token resolution.
// Access level always comes from the DB (mcp_access), never from the token
// itself (global-constraints.md). resolveBearer hashes the incoming token
// with sha256Hex and looks up mcp_tokens by that hash only.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { sha256Hex } from "./crypto.server";

export type McpLevel = "none" | "read" | "write";

export type McpIdentity = {
  userId: string;
  connectionId: string;
  clientId: string;
  level: Exclude<McpLevel, "none">;
};

/* eslint-disable @typescript-eslint/no-explicit-any -- loose client typing, same pattern as finance-data.server.ts's db(). */
const db = () => supabaseAdmin as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Current access level for `userId`. Absence of a row in mcp_access means "none". */
export async function getMcpLevel(userId: string): Promise<McpLevel> {
  const { data, error } = await db()
    .from("mcp_access")
    .select("level")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return "none";
  return data.level as McpLevel;
}

/**
 * Resolves a bearer token to its MCP identity. Null when: the hash is
 * unknown, the token's kind isn't "access", it's expired, its connection is
 * revoked, or the user's current level is "none". On success, bumps
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

  const level = await getMcpLevel(connRow.user_id);
  if (level === "none") return null;

  await db().from("mcp_connections").update({ last_used_at: nowIso }).eq("id", connRow.id);

  return {
    userId: connRow.user_id,
    connectionId: connRow.id,
    clientId: connRow.client_id,
    level,
  };
}
