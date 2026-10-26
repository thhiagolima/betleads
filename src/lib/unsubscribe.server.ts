// Server-only logic of the public unsubscribe route (src/routes/u.$token.tsx).
// The route's server function imports this module only inside its handler,
// so the service-role client never reaches the client bundle.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { suppressEmail } from "@/lib/email-deliverability.server";
import { checkDemoTenant } from "@/lib/tenant-access.server";

// Plain function behind the server fn: calling it directly (instead of
// through the createServerFn/SSR-RPC wrapper) is what lets tests exercise
// this logic without a request context.
export async function confirmUnsubscribeFor(data: { token: string }) {
  const { data: row } = await supabaseAdmin
    .from("email_unsubscribe_tokens")
    .select("email, tenant_id, used_at")
    .eq("token", data.token)
    .maybeSingle();
  if (!row) return { ok: false as const, reason: "not_found" as const };
  // Demo tenant: render the normal confirmation UI but write nothing — no
  // suppression, token not marked used. R11: a lookup failure here is never
  // treated as "not demo" (that would suppress/mark-used on an unverified
  // tenant) — it propagates and surfaces as the route's existing error/
  // retry state instead of the success page.
  const tenantId = (row.tenant_id as string | null) ?? null;
  if (tenantId && (await checkDemoTenant(tenantId)) === "demo") {
    return { ok: true as const };
  }
  // Suprime antes de marcar o token: se a supressão falhar, o link continua
  // válido para uma nova tentativa em vez de mostrar "concluído" sem efeito.
  await suppressEmail(
    row.email as string,
    "unsubscribe",
    tenantId,
    "user clicked unsubscribe link",
  );
  if (!row.used_at) {
    const { error } = await supabaseAdmin
      .from("email_unsubscribe_tokens")
      .update({ used_at: new Date().toISOString() })
      .eq("token", data.token);
    if (error) throw new Error(`Falha ao registrar o descadastro: ${error.message}`);
  }
  return { ok: true as const };
}
