import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Retorna o webhook_token do tenant do usuário logado.
// Usa a view "tenants" via RLS (has_tenant_access cobre o SELECT).
export const getMyWebhookToken = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from("tenants")
      .select("id, nome, legacy_webhook")
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const tenantId = (data?.id as string | undefined) ?? null;
    let token: string | null = null;
    if (tenantId) {
      // get_my_webhook_token returns NULL for non-admins; only owners/admins
      // see the actual webhook token.
      const { data: tok } = await supabase.rpc("get_my_webhook_token", {
        _tenant: tenantId,
      });
      token = (tok as string | null) ?? null;
    }
    return {
      token,
      tenantId,
      tenantNome: (data?.nome as string | undefined) ?? null,
      legacy: Boolean((data as { legacy_webhook?: boolean } | null)?.legacy_webhook),
    };
  });