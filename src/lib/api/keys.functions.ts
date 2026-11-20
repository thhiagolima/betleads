// API de leitura: the signed-in user's own keys, for the "API" section of
// /mcp (spec 2026-11-20 §4). Creating and revoking a key is logged in
// mcp_call_log (tool api.chave_criada / api.chave_revogada), never the key.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getMcpLevel } from "@/lib/mcp/access.server";
import { logCall } from "@/lib/mcp/call-log.server";
import { publicBaseUrlFromEnv } from "@/lib/mcp/oauth.server";
import { dbUuid } from "@/lib/zod-helpers";

import { isApiEnabled } from "./config.server";
import { createApiKey, listApiKeys, revokeApiKey, type ApiKeyView } from "./keys.server";

const API_OFF = "API desligada neste ambiente.";

export type MyApiKeys = {
  /** False when API_ENABLED is off or the user has no MCP access: the section is hidden. */
  enabled: boolean;
  apiUrl: string;
  keys: ApiKeyView[];
};

export async function getMyApiKeysFor(ctx: { userId: string }): Promise<MyApiKeys> {
  const apiUrl = `${publicBaseUrlFromEnv()}/api/v1`;
  if (!isApiEnabled() || (await getMcpLevel(ctx.userId)) === "none") {
    return { enabled: false, apiUrl, keys: [] };
  }
  return { enabled: true, apiUrl, keys: await listApiKeys(ctx.userId) };
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
