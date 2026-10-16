// Server-only logic behind the privileged WhatsApp/Evolution server functions
// (whatsapp.functions.ts). Kept outside the createServerFn handlers so the
// authorization and tenant-scoping rules are unit-testable.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { evolutionFetch } from "./evolution.server";
import { assertSuperAdmin } from "./provider-governance.server";
import { assertTenantNotDemo } from "./tenant-access.server";
import { evolutionWebhookSetBody, evolutionWebhookUrl } from "./whatsapp-evolution-auth.server";

/** Rows created before multi-tenancy carry this default tenant id. */
export const LEGACY_TENANT_ID = "00000000-0000-0000-0000-000000000001";

export const EVOLUTION_WEBHOOK_EVENTS = [
  "MESSAGES_UPSERT",
  "MESSAGES_UPDATE",
  "SEND_MESSAGE",
  "CONNECTION_UPDATE",
  "CHATS_UPSERT",
  "CONTACTS_UPSERT",
];

function evolutionEnv() {
  const url = process.env.EVOLUTION_API_URL?.trim().replace(/\/$/, "") ?? "";
  const key = (process.env.EVOLUTION_API_KEY ?? "").trim().replace(/^['"]|['"]$/g, "");
  return { url, key };
}

async function fingerprintKey(key: string): Promise<string> {
  try {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
    return Array.from(new Uint8Array(hash))
      .slice(0, 4)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return "n/a";
  }
}

/**
 * (Re)registers the inbound webhook of one Evolution instance. Platform
 * operation: super admin only. The secret goes in a header, never in the URL,
 * and is never returned.
 */
export async function configureEvolutionWebhookFor(userId: string, instanceName: string) {
  await assertSuperAdmin(userId);
  // Super admin can target any instance, so the demo tenant is blocked here
  // too: resolve the owning tenant of this instance (no row, no owner, or a
  // demo tenant all fail closed via `assertTenantNotDemo`).
  const { data: owner, error: ownerError } = await supabaseAdmin
    .from("whatsapp_sessions")
    .select("tenant_id")
    .eq("instance_name", instanceName)
    .maybeSingle();
  if (ownerError) throw new Error(ownerError.message);
  await assertTenantNotDemo((owner as { tenant_id?: string } | null)?.tenant_id ?? "");
  // Throws a clear error when EVOLUTION_WEBHOOK_SECRET is not configured.
  const body = evolutionWebhookSetBody(EVOLUTION_WEBHOOK_EVENTS);
  try {
    await evolutionFetch(`/webhook/set/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      body,
    });
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    console.warn("[whatsapp] webhook/set failed:", message);
    throw new Error(`Falha ao configurar webhook: ${message}`);
  }
  // The URL has no credentials in it; safe to show.
  return { ok: true as const, url: evolutionWebhookUrl() };
}

/**
 * Connectivity diagnostic against Evolution. Super admin only. Returns the
 * number of instances, never the raw list (it contains per-instance tokens).
 */
export async function diagnoseEvolutionFor(userId: string) {
  await assertSuperAdmin(userId);
  const { url, key } = evolutionEnv();
  if (!url || !key) {
    return { ok: false as const, error: "EVOLUTION_API_URL / EVOLUTION_API_KEY not configured" };
  }
  const target = `${url}/instance/fetchInstances`;
  const apikeyFingerprint = await fingerprintKey(key);
  try {
    const data = await evolutionFetch("/instance/fetchInstances");
    return {
      ok: true as const,
      url: target,
      method: "GET",
      apikeyFingerprint,
      apikeyLength: key.length,
      responseStatus: 200,
      instanceCount: Array.isArray(data) ? data.length : null,
    };
  } catch (e) {
    const err = e as { status?: number; message?: string };
    return {
      ok: false as const,
      url: target,
      method: "GET",
      apikeyFingerprint,
      apikeyLength: key.length,
      responseStatus: err?.status ?? 0,
      error: String(err?.message ?? e).slice(0, 300),
    };
  }
}

/**
 * Evolution URL + global apikey for the browser socket.io QR flow. Super admin
 * only (SEC-29 residual risk: the key still reaches the super admin browser).
 */
export async function evolutionRealtimeConfigFor(userId: string) {
  await assertSuperAdmin(userId);
  const { url, key } = evolutionEnv();
  if (!url || !key) throw new Error("Evolution não configurada");
  return { url, apikey: key };
}

// The user-scoped Supabase client (RLS). Structural type so tests can pass a
// lightweight double.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UserDb = { from: (table: string) => any };

/**
 * Deletes a WhatsApp session of the caller's tenant (SEC-15).
 * Ownership is proven by reading the session through RLS; nothing is deleted
 * with the service role unless that read succeeds, and service-role deletes
 * are limited to the session's tenant (plus legacy default-tenant rows that
 * otherwise keep the FK alive).
 */
export async function deleteWhatsappSessionFor(
  supabase: UserDb,
  input: { id: string; force?: boolean },
) {
  const { data: session, error: readError } = await supabase
    .from("whatsapp_sessions")
    .select("id, tenant_id, instance_name")
    .eq("id", input.id)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  if (!session) throw new Error("Sessão não encontrada");
  await assertTenantNotDemo(session.tenant_id as string);

  const tenantScope = Array.from(new Set([session.tenant_id as string, LEGACY_TENANT_ID]));

  if (!input.force) {
    // Blocks deletion while leads are still linked — reassign first.
    const { count: assignedCount } = await supabaseAdmin
      .from("lead_whatsapp_assignments")
      .select("id", { count: "exact", head: true })
      .eq("session_id", input.id)
      .in("tenant_id", tenantScope);
    if ((assignedCount ?? 0) > 0) {
      throw new Error(
        `Esta sessão tem ${assignedCount} lead(s) vinculado(s). Realoque para outra sessão antes de excluir.`,
      );
    }
  } else {
    const { error: assignErr } = await supabaseAdmin
      .from("lead_whatsapp_assignments")
      .delete()
      .eq("session_id", input.id)
      .in("tenant_id", tenantScope);
    if (assignErr) throw new Error(assignErr.message);
    const { error: msgErr } = await supabaseAdmin
      .from("whatsapp_messages")
      .delete()
      .eq("session_id", input.id)
      .in("tenant_id", tenantScope);
    if (msgErr) throw new Error(msgErr.message);
    const { error: chatErr } = await supabaseAdmin
      .from("whatsapp_chats")
      .delete()
      .eq("session_id", input.id)
      .in("tenant_id", tenantScope);
    if (chatErr) throw new Error(chatErr.message);
  }

  try {
    await evolutionFetch(`/instance/delete/${encodeURIComponent(session.instance_name)}`, {
      method: "DELETE",
    });
  } catch (e) {
    console.warn("[whatsapp] delete instance failed:", (e as Error)?.message);
  }

  const { error } = await supabase.from("whatsapp_sessions").delete().eq("id", input.id);
  if (error) throw new Error(error.message);
  return { ok: true as const };
}
