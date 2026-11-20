// API de leitura: chaves por pessoa (docs/superpowers/specs/2026-11-20-api-leitura-design.md §4).
// The key is shown once at creation; only its SHA-256 is stored. A key only
// works while its owner has MCP access (level != none): level and areas are
// read from mcp_access on every call, never stored with the key.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getMcpAccess, type McpIdentity } from "@/lib/mcp/access.server";
import { randomToken, sha256Hex } from "@/lib/mcp/crypto.server";

/* eslint-disable @typescript-eslint/no-explicit-any -- loose client typing, same pattern as mcp/access.server.ts's db(). */
const db = () => supabaseAdmin as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export const API_KEY_PREFIX = "blk_";
/** Active keys one person may hold at the same time. */
export const MAX_KEYS_PER_USER = 5;

export const API_KEY_LIMIT = `No máximo ${MAX_KEYS_PER_USER} chaves ativas. Revogue uma antes de criar outra.`;
export const API_KEY_NOT_FOUND = "Chave não encontrada.";
export const API_NO_ACCESS = "Seu usuário não tem acesso ao MCP. Peça ao super admin.";

/** What the screen lists: never the key itself. */
export type ApiKeyView = {
  id: string;
  nome: string;
  prefixo: string;
  createdAt: string;
  lastUsedAt: string | null;
};

/** A resolved key: the owner's MCP identity (always read-only here) plus the key id. */
export type ApiIdentity = McpIdentity & { apiKeyId: string };

type KeyRow = {
  id: string;
  user_id: string;
  nome: string;
  prefixo: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

const toView = (row: KeyRow): ApiKeyView => ({
  id: row.id,
  nome: row.nome,
  prefixo: row.prefixo,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
});

export async function listApiKeys(userId: string): Promise<ApiKeyView[]> {
  const { data, error } = await db()
    .from("api_keys")
    .select("id, user_id, nome, prefixo, created_at, last_used_at, revoked_at")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return ((data ?? []) as KeyRow[]).map(toView);
}

/** Creates a key for `userId`; the plain key is returned only here. */
export async function createApiKey(
  userId: string,
  nome: string,
): Promise<{ key: string; view: ApiKeyView }> {
  if ((await getMcpAccess(userId)).level === "none") throw new Error(API_NO_ACCESS);
  if ((await listApiKeys(userId)).length >= MAX_KEYS_PER_USER) throw new Error(API_KEY_LIMIT);
  const key = `${API_KEY_PREFIX}${randomToken(32)}`;
  const { data, error } = await db()
    .from("api_keys")
    .insert({
      user_id: userId,
      nome: nome.trim(),
      prefixo: key.slice(0, API_KEY_PREFIX.length + 6),
      key_hash: await sha256Hex(key),
    })
    .select("id, user_id, nome, prefixo, created_at, last_used_at, revoked_at")
    .single();
  if (error) throw new Error(error.message);
  return { key, view: toView(data as KeyRow) };
}

/** Revokes one of `userId`'s own keys (same message whether it's missing or someone else's). */
export async function revokeApiKey(userId: string, keyId: string): Promise<void> {
  const { data, error } = await db()
    .from("api_keys")
    .select("id, user_id")
    .eq("id", keyId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || data.user_id !== userId) throw new Error(API_KEY_NOT_FOUND);
  const { error: updateError } = await db()
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", keyId);
  if (updateError) throw new Error(updateError.message);
}

/**
 * The identity behind a bearer key, or null when the key is malformed,
 * unknown, revoked, or its owner no longer has MCP access. Bumps last_used_at.
 */
export async function resolveApiKey(key: string): Promise<ApiIdentity | null> {
  if (!key.startsWith(API_KEY_PREFIX) || key.length < API_KEY_PREFIX.length + 20) return null;
  const { data, error } = await db()
    .from("api_keys")
    .select("id, user_id, revoked_at")
    .eq("key_hash", await sha256Hex(key))
    .maybeSingle();
  if (error || !data || data.revoked_at) return null;
  const access = await getMcpAccess(data.user_id);
  if (access.level === "none") return null;
  await db()
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id);
  return {
    userId: data.user_id,
    connectionId: "",
    clientId: "api",
    // The API never writes, whatever the MCP level.
    level: "read",
    areas: access.areas,
    apiKeyId: data.id,
  };
}
