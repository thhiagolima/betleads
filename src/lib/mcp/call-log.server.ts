// MCP financeiro, Task 8: one mcp_call_log row per tool call, and the rate
// limits counted from those rows (spec §8, §10: counted in the DB, not in
// memory, so they hold across Node/Workers instances).
//
// - Calls: rows of the connection in the last 60 s, ok or not — a refused call
//   is logged too, so a client hammering the endpoint stays refused until it
//   slows down.
// - Confirmations: ok `confirmar_alteracao` rows of the user in the last hour
//   (failed confirmations wrote nothing, so they don't count).
//
// MCP do grupo (spec 2026-11-17 §6): each row also keeps the call's `args`
// (JSON, cut at LOG_ARGS_MAX_CHARS; tools never take player data) and the
// resolved `scope` ({tipo, id, casas}).
import { supabaseAdmin } from "@/integrations/supabase/client.server";

import type { McpIdentity } from "./access.server";
import { CALLS_PER_MINUTE, CONFIRMS_PER_HOUR, LOG_ARGS_MAX_CHARS } from "./config.server";

/* eslint-disable @typescript-eslint/no-explicit-any -- loose client typing, same pattern as access.server.ts's db(). */
const db = () => supabaseAdmin as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export const CONFIRM_TOOL = "confirmar_alteracao";
export const RATE_LIMITED = "Muitas chamadas. Aguarde um minuto.";
export const CONFIRM_LIMITED = "Limite de confirmações por hora atingido.";
const LIMIT_UNAVAILABLE = "Não foi possível verificar o limite de chamadas. Tente de novo.";

async function countRows(
  apply: (query: any) => any, // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<number> {
  const { count, error } = await apply(
    db().from("mcp_call_log").select("id", { count: "exact", head: true }),
  );
  // Fail closed: a limit that can't be checked is not skipped.
  if (error) throw new Error(LIMIT_UNAVAILABLE);
  return count ?? 0;
}

/** Throws the pt-BR limit message when this call would exceed a limit. */
export async function checkRateLimit(identity: McpIdentity, tool: string): Promise<void> {
  const now = Date.now();
  const lastMinute = new Date(now - 60_000).toISOString();
  const calls = await countRows((q) =>
    q.eq("connection_id", identity.connectionId).gte("created_at", lastMinute),
  );
  if (calls >= CALLS_PER_MINUTE) throw new Error(RATE_LIMITED);

  if (tool === CONFIRM_TOOL) {
    const lastHour = new Date(now - 3_600_000).toISOString();
    const confirms = await countRows((q) =>
      q
        .eq("user_id", identity.userId)
        .eq("tool", CONFIRM_TOOL)
        .eq("ok", true)
        .gte("created_at", lastHour),
    );
    if (confirms >= CONFIRMS_PER_HOUR) throw new Error(CONFIRM_LIMITED);
  }
}

/** API de leitura: throws the pt-BR limit message past CALLS_PER_MINUTE calls of one key. */
export async function checkApiRateLimit(apiKeyId: string): Promise<void> {
  const lastMinute = new Date(Date.now() - 60_000).toISOString();
  const calls = await countRows((q) =>
    q.eq("api_key_id", apiKeyId).gte("created_at", lastMinute),
  );
  if (calls >= CALLS_PER_MINUTE) throw new Error(RATE_LIMITED);
}

/**
 * Who performed the call: the usual MCP identity (bound to a connection), or
 * an admin action taken straight from the admin panel, outside any MCP
 * connection — `mcp_call_log.connection_id` is nullable for exactly this case
 * (see the migration's comment).
 */
export type CallLogIdentity = McpIdentity | { userId: string; connectionId: null };

/** Scope of a call as logged in mcp_call_log.scope. */
export type CallLogScope = { tipo: string; id?: string | null; casas?: number };

export type CallLogEntry = {
  identity: CallLogIdentity;
  tool: string;
  tenantId?: string | null;
  ok: boolean;
  error?: string;
  durationMs: number;
  previewCodeHash?: string;
  /** The call's arguments (already free of secrets — the caller redacts). */
  args?: unknown;
  scope?: CallLogScope | null;
  /** API de leitura: the key that made the call (connection_id is then null). */
  apiKeyId?: string | null;
};

/**
 * The arguments as stored in mcp_call_log.args: as is when their JSON fits in
 * LOG_ARGS_MAX_CHARS, else `{truncado: true, json: <first chars>}` (a jsonb
 * column needs valid JSON, so the cut text goes inside a string).
 */
export function argsForLog(args: unknown): unknown {
  if (args === undefined) return null;
  let json: string;
  try {
    json = JSON.stringify(args) ?? "null";
  } catch {
    return { truncado: true, json: "" };
  }
  if (json.length <= LOG_ARGS_MAX_CHARS) return JSON.parse(json);
  return { truncado: true, json: json.slice(0, LOG_ARGS_MAX_CHARS) };
}

/** Inserts the call's log row. Never throws: a log failure must not fail the call. */
export async function logCall(entry: CallLogEntry): Promise<void> {
  try {
    const { error } = await db()
      .from("mcp_call_log")
      .insert({
        user_id: entry.identity.userId,
        connection_id: entry.identity.connectionId,
        tool: entry.tool,
        tenant_id: entry.tenantId ?? null,
        ok: entry.ok,
        error: entry.error ? entry.error.slice(0, 1000) : null,
        duration_ms: Math.max(0, Math.round(entry.durationMs)),
        preview_code_hash: entry.previewCodeHash ?? null,
        args: argsForLog(entry.args),
        scope: entry.scope ?? null,
        ...(entry.apiKeyId ? { api_key_id: entry.apiKeyId } : {}),
      });
    if (error) console.error("[mcp-call-log]", error.message);
  } catch (error) {
    console.error("[mcp-call-log]", error);
  }
}
