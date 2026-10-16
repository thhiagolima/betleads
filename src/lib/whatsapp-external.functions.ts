import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const saveSchema = z.object({
  url: z.string().trim().url().max(500),
  active: z.boolean(),
  triggers: z.array(z.string().trim().min(1).max(60)).max(40),
  disable_internal: z.boolean().optional(),
});

export const getWhatsappExternalIntegration = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("whatsapp_external_integrations")
      .select("*")
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return { integration: data ?? null };
  });

// Admin/gestor (or super admin) only; URL must be public https (SEC-12).
export const saveWhatsappExternalIntegration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => saveSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { saveExternalIntegrationFor } = await import("./whatsapp-external.server");
    return saveExternalIntegrationFor(context.supabase, context.userId, data);
  });

export const listWhatsappExternalEvents = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("whatsapp_external_events")
      .select("id, trigger_type, phone_e164, status, http_status, error, is_test, created_at, player_id")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return { events: data ?? [] };
  });

export const testWhatsappExternalWebhook = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { loadManagedExternalIntegration, sendExternalTriggerEvent } = await import(
      "./whatsapp-external.server"
    );
    const integration = await loadManagedExternalIntegration(context.supabase, context.userId);
    const res = await sendExternalTriggerEvent({
      integration,
      trigger: "recuperacao_vip",
      isTest: true,
      lead: {
        id: null,
        player_external_id: "TESTE-123",
        nome: "Lead de Teste",
        telefone: "5511999999999",
        email: "teste@betleads.io",
        vip: true,
        total_depositado: 1250,
        total_sacado: 300,
        saldo_carteira: 87.5,
        media_deposito: 62.5,
        dep_30d: 400,
        qtd_logins_30d: 12,
        ultimo_login: new Date().toISOString(),
        ultimo_deposito: new Date().toISOString(),
        ultimo_jogo: new Date().toISOString(),
        ftd_em: new Date().toISOString(),
        created_at: new Date().toISOString(),
      },
    });
    return { ok: res.sent, httpStatus: res.httpStatus ?? null, reason: res.reason ?? null };
  });

export const sendAllWhatsappExternalEvents = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { loadManagedExternalIntegration, sendAllTriggerSamples } = await import(
      "./whatsapp-external.server"
    );
    const integration = await loadManagedExternalIntegration(context.supabase, context.userId);
    const results = await sendAllTriggerSamples(integration);
    return {
      total: results.length,
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  });