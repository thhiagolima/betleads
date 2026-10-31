// MCP financeiro, Task 8: one mcp_call_log row per tool call, and the rate
// limits counted from those rows (spec §8, §10: counted in the DB, not in
// memory, so they hold across Node/Workers instances).
//
// - Calls: rows of the connection in the last 60 s, ok or not — a refused call
//   is logged too, so a client hammering the endpoint stays refused until it
//   slows down.
// - Confirmations: ok `confirmar_alteracao` rows of the user in the last hour
//   (failed confirmations wrote nothing, so they don't count).
import { supabaseAdmin } from "@/integrations/supabase/client.server";

import type { McpIdentity } from "./access.server";
import { CALLS_PER_MINUTE, CONFIRMS_PER_HOUR } from "./config.server";

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

export type CallLogEntry = {
  identity: McpIdentity;
  tool: string;
  tenantId?: string | null;
  ok: boolean;
  error?: string;
  durationMs: number;
  previewCodeHash?: string;
};

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
      });
    if (error) console.error("[mcp-call-log]", error.message);
  } catch (error) {
    console.error("[mcp-call-log]", error);
  }
}
