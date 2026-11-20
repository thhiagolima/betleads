// API de leitura: the signed-in user's own keys, for the "API" section of
// /mcp (spec 2026-11-20 §4). Creating and revoking a key is logged in
// mcp_call_log (tool api.chave_criada / api.chave_revogada), never the key.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getMcpAccess, type McpArea } from "@/lib/mcp/access.server";
import { logCall } from "@/lib/mcp/call-log.server";
import { publicBaseUrlFromEnv } from "@/lib/mcp/oauth.server";
import { dbUuid } from "@/lib/zod-helpers";

import { isApiEnabled } from "./config.server";
import { createApiKey, listApiKeys, revokeApiKey, type ApiKeyView } from "./keys.server";
import { toolsFor } from "./tools.server";

const API_OFF = "API desligada neste ambiente.";

export type ApiToolView = { nome: string; titulo: string; area: McpArea | null };

export type MyApiKeys = {
  /** False when API_ENABLED is off or the user has no MCP access: the screen and menu entry are hidden. */
  enabled: boolean;
  apiUrl: string;
  areas: McpArea[];
  keys: ApiKeyView[];
  /** The queries this user's keys may call (listar_escopos plus the granted areas'). */
  ferramentas: ApiToolView[];
  /** True once one of the user's keys made a query (the tutorial's "first call" step). */
  hasUsedApi: boolean;
};

/** Whether any key of the user made a query (key create/revoke rows are api.*, not queries). */
async function hasUsedApi(userId: string): Promise<boolean> {
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose client typing */
  const { data, error } = await (supabaseAdmin as any)
    .from("mcp_call_log")
    .select("tool")
    .eq("user_id", userId)
    .not("api_key_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) return false;
  return ((data ?? []) as Array<{ tool: string }>).some((row) => !row.tool.startsWith("api."));
}

export async function getMyApiKeysFor(ctx: { userId: string }): Promise<MyApiKeys> {
  const apiUrl = `${publicBaseUrlFromEnv()}/api/v1`;
  const off: MyApiKeys = {
    enabled: false,
    apiUrl,
    areas: [],
    keys: [],
    ferramentas: [],
    hasUsedApi: false,
  };
  if (!isApiEnabled()) return off;
  const access = await getMcpAccess(ctx.userId);
  if (access.level === "none") return off;
  const [keys, used] = await Promise.all([listApiKeys(ctx.userId), hasUsedApi(ctx.userId)]);
  return {
    enabled: true,
    apiUrl,
    areas: access.areas,
    keys,
    ferramentas: toolsFor(access.areas).map((tool) => ({
      nome: tool.name,
      titulo: tool.title,
      area: tool.area,
    })),
    hasUsedApi: used,
  };
}

export const getMyApiKeys = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => getMyApiKeysFor({ userId: context.userId }));

const createInput = z.object({ nome: z.string().trim().min(1, "Dê um nome à chave.").max(80) });

export async function createMyApiKeyFor(
  ctx: { userId: string },
  data: z.infer<typeof createInput>,
): Promise<{ key: string; view: ApiKeyView }> {
  if (!isApiEnabled()) throw new Error(API_OFF);
  const created = await createApiKey(ctx.userId, data.nome);
  await logCall({
    identity: { userId: ctx.userId, connectionId: null },
    apiKeyId: created.view.id,
    tool: "api.chave_criada",
    ok: true,
    durationMs: 0,
    args: { nome: created.view.nome, prefixo: created.view.prefixo },
  });
  return created;
}

export const createMyApiKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => createInput.parse(data))
  .handler(async ({ context, data }) => createMyApiKeyFor({ userId: context.userId }, data));

const revokeInput = z.object({ id: dbUuid() });

export async function revokeMyApiKeyFor(
  ctx: { userId: string },
  data: z.infer<typeof revokeInput>,
): Promise<{ ok: true }> {
  if (!isApiEnabled()) throw new Error(API_OFF);
  await revokeApiKey(ctx.userId, data.id);
  await logCall({
    identity: { userId: ctx.userId, connectionId: null },
    apiKeyId: data.id,
    tool: "api.chave_revogada",
    ok: true,
    durationMs: 0,
  });
  return { ok: true };
}

export const revokeMyApiKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => revokeInput.parse(data))
  .handler(async ({ context, data }) => revokeMyApiKeyFor({ userId: context.userId }, data));
