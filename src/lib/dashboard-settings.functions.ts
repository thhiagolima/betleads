// Marco global de "zerar dashboards". Não apaga dados — apenas define o
// timestamp a partir do qual as 4 dashboards contam.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const EPOCH = "1970-01-01T00:00:00Z";

export const getDashboardResetAt = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ reset_at: string }> => {
    const { data } = await context.supabase
      .from("dashboard_settings")
      .select("reset_at")
      .eq("id", "global")
      .maybeSingle();
    return { reset_at: (data?.reset_at as string) ?? EPOCH };
  });

export const resetDashboards = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ reset_at: string }> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // Verifica admin
    const { data: isAdmin } = await supabaseAdmin.rpc("has_role", {
      _user_id: context.userId,
      _role: "admin",
    });
    if (!isAdmin) throw new Error("Apenas administradores podem zerar as dashboards");
    const now = new Date().toISOString();
    const { error } = await supabaseAdmin
      .from("dashboard_settings")
      .upsert({ id: "global", reset_at: now, updated_at: now, updated_by: context.userId });
    if (error) throw new Error(error.message);
    return { reset_at: now };
  });

/** Helper para uso dentro de outras server fns. Não exporta como server fn. */
export async function readResetAtAdmin(): Promise<string> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("dashboard_settings")
    .select("reset_at")
    .eq("id", "global")
    .maybeSingle();
  return (data?.reset_at as string) ?? EPOCH;
}