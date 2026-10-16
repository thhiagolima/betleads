import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertTenantNotDemo } from "@/lib/tenant-access.server";

async function getWebhookAccess(context: { supabase: any }) {
  const { data: tenantId, error: tenantError } = await context.supabase.rpc("current_tenant_id");
  if (tenantError) throw new Error(tenantError.message);
  if (!tenantId) throw new Error("Tenant atual não encontrado.");

  const { data: canManage, error: accessError } = await context.supabase.rpc("is_tenant_admin", {
    _tenant: tenantId,
  });
  if (accessError) throw new Error(accessError.message);
  return { tenantId: tenantId as string, canManage: Boolean(canManage) };
}

export const getMyWebhookAccess = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => getWebhookAccess(context));

async function requireWebhookManager(context: { supabase: any }) {
  const access = await getWebhookAccess(context);
  if (!access.canManage)
    throw new Error("Apenas administradores da conta podem acessar integrações de webhook.");
  return access.tenantId;
}

function randomHex(bytes: number) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export const rotateMyWebhookCredentials = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await requireWebhookManager(context);
    await assertTenantNotDemo(tenantId);
    const webhook_token = randomHex(24);
    const webhook_secret = randomHex(32);
    const { error } = await (supabaseAdmin as any)
      .from("tenants")
      .update({ webhook_token, webhook_secret, webhook_hmac_enforced: false })
      .eq("id", tenantId);
    if (error) throw new Error(error.message);
    await supabaseAdmin.from("tenant_audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: context.userId,
      action: "webhook.credentials_rotated",
      entity_type: "tenant",
      entity_id: tenantId,
      metadata: { token_rotated: true, hmac_rotated: true, hmac_enforced: false },
    });
    return { token: webhook_token, secret: webhook_secret };
  });

export const provisionMyWebhookHmacSecret = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await requireWebhookManager(context);
    await assertTenantNotDemo(tenantId);
    const webhook_secret = randomHex(32);
    const { error } = await (supabaseAdmin as any)
      .from("tenants")
      .update({ webhook_secret, webhook_hmac_enforced: false })
      .eq("id", tenantId);
    if (error) throw new Error(error.message);
    await supabaseAdmin.from("tenant_audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: context.userId,
      action: "webhook.hmac_secret_provisioned",
      entity_type: "tenant",
      entity_id: tenantId,
      metadata: { hmac_enforced: false },
    });
    return { secret: webhook_secret };
  });

export const setMyWebhookHmacEnforcement = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => z.object({ enforce: z.boolean() }).parse(value))
  .handler(async ({ data, context }) => {
    const tenantId = await requireWebhookManager(context);
    await assertTenantNotDemo(tenantId);
    if (data.enforce) {
      const { data: tenant, error: lookupError } = await (supabaseAdmin as any)
        .from("tenants")
        .select("webhook_secret")
        .eq("id", tenantId)
        .maybeSingle();
      if (lookupError) throw new Error(lookupError.message);
      if (!tenant?.webhook_secret)
        throw new Error("Gere uma chave HMAC antes de exigir assinatura.");
    }
    const { error } = await (supabaseAdmin as any)
      .from("tenants")
      .update({ webhook_hmac_enforced: data.enforce })
      .eq("id", tenantId);
    if (error) throw new Error(error.message);
    await supabaseAdmin.from("tenant_audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: context.userId,
      action: "webhook.hmac_enforcement_changed",
      entity_type: "tenant",
      entity_id: tenantId,
      metadata: { enforced: data.enforce },
    });
    return { enforced: data.enforce };
  });

// Retorna o webhook_token do tenant do usuário logado.
// Usa a view "tenants" via RLS (has_tenant_access cobre o SELECT).
export const getMyWebhookToken = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const currentTenantId = await requireWebhookManager(context);
    await assertTenantNotDemo(currentTenantId);
    const { data, error } = await supabaseAdmin
      .from("tenants")
      .select("id, nome, legacy_webhook, webhook_token, webhook_secret, webhook_hmac_enforced")
      .eq("id", currentTenantId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const tenantId = (data?.id as string | undefined) ?? null;
    const token = (data?.webhook_token as string | null | undefined) ?? null;
    return {
      token,
      tenantId,
      tenantNome: (data?.nome as string | undefined) ?? null,
      // Mesmo o tenant legado usa agora URL/token próprios. O campo histórico
      // legacy_webhook não deve mais gerar endpoint global.
      legacy: false,
      hmacConfigured: Boolean((data as any)?.webhook_secret),
      hmacEnforced: Boolean((data as any)?.webhook_hmac_enforced),
    };
  });

export const getMyWebhookLogs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await requireWebhookManager(context);
    await assertTenantNotDemo(tenantId);
    const { data, error } = await supabaseAdmin
      .from("webhook_logs")
      .select("id, tenant_id, evento, status, created_at, payload")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const getMyWebhookHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await requireWebhookManager(context);
    await assertTenantNotDemo(tenantId);

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const countStatus = async (status?: string) => {
      let query = supabaseAdmin
        .from("webhook_logs")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .gte("created_at", since);
      if (status) query = query.eq("status", status);
      const { count, error } = await query;
      if (error) throw new Error(error.message);
      return count ?? 0;
    };

    const [received, processed, duplicates, failed, ignored, latest] = await Promise.all([
      countStatus(),
      countStatus("processado"),
      countStatus("duplicado"),
      countStatus("erro"),
      countStatus("sem_player"),
      supabaseAdmin
        .from("webhook_logs")
        .select("created_at,evento,status")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (latest.error) throw new Error(latest.error.message);

    return {
      since,
      received,
      processed,
      duplicates,
      failed,
      ignored,
      latest: latest.data ?? null,
    };
  });
