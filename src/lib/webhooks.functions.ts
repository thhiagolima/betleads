import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// Retorna o webhook_token do tenant do usuário logado.
// Usa a view "tenants" via RLS (has_tenant_access cobre o SELECT).
export const getMyWebhookToken = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data: currentTenantId, error: tenantError } = await supabase.rpc("current_tenant_id");
    if (tenantError) throw new Error(tenantError.message);
    if (!currentTenantId) throw new Error("Tenant atual não encontrado.");
    const { data, error } = await supabaseAdmin
      .from("tenants")
      .select("id, nome, legacy_webhook, webhook_token")
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
    };
  });

export const getMyWebhookLogs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: tenantId, error: tenantError } = await context.supabase.rpc("current_tenant_id");
    if (tenantError) throw new Error(tenantError.message);
    if (!tenantId) throw new Error("Tenant atual não encontrado.");
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
    const { data: tenantId, error: tenantError } = await context.supabase.rpc("current_tenant_id");
    if (tenantError) throw new Error(tenantError.message);
    if (!tenantId) throw new Error("Tenant atual não encontrado.");

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
