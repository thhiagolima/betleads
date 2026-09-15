import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * Rede de segurança do gatilho `cashback_pago`.
 *
 * Varre os pagamentos de cashback do dia corrente (BRT) e enfileira nos fluxos
 * ativos de SMS/Email com gatilho `cashback_pago` os leads que ainda não
 * entraram. Cobre casos em que o webhook falhou ou chegou sem contato.
 *
 * Idempotente: só insere quando não existe enrollment pending/running/completed
 * criado a partir do horário do pagamento.
 */
export interface CashbackCatchupResult {
  payments: number;
  sms_enrolled: number;
  email_enrolled: number;
}

function startOfBrtDayIso(): string {
  const now = new Date();
  const brt = new Date(now.getTime() - 3 * 3600_000);
  const startUtcMs = Date.UTC(brt.getUTCFullYear(), brt.getUTCMonth(), brt.getUTCDate()) + 3 * 3600_000;
  return new Date(startUtcMs).toISOString();
}

export async function runCashbackCatchup(
  opts: { limit?: number; since?: string } = {},
): Promise<CashbackCatchupResult> {
  const limit = opts.limit ?? 500;
  const since = opts.since ?? startOfBrtDayIso();

  const { data: payments } = await supabaseAdmin
    .from("cashback_payments")
    .select("id, tenant_id, player_id, paid_at, telefone, email")
    .gte("paid_at", since)
    .not("player_id", "is", null)
    .order("paid_at", { ascending: true })
    .limit(limit);

  const rows = payments ?? [];
  if (rows.length === 0) return { payments: 0, sms_enrolled: 0, email_enrolled: 0 };

  // Só tenants que NÃO são CRM Expert entram em fluxos por cashback.
  const tenantIds = Array.from(new Set(rows.map((r) => r.tenant_id)));
  const { data: tenants } = await supabaseAdmin
    .from("tenants")
    .select("id, crm_model")
    .in("id", tenantIds);
  const allowedTenants = new Set(
    (tenants ?? []).filter((t) => t.crm_model !== "CRM_EXPERT").map((t) => t.id),
  );

  const { data: smsFlows } = await supabaseAdmin
    .from("sms_flows")
    .select("id, tenant_id")
    .eq("trigger_name", "cashback_pago")
    .eq("is_active", true)
    .in("tenant_id", Array.from(allowedTenants.size ? allowedTenants : new Set(["-"])));
  const { data: emailFlows } = await supabaseAdmin
    .from("email_flows")
    .select("id, tenant_id")
    .eq("trigger_type", "cashback_pago")
    .eq("active", true)
    .in("tenant_id", Array.from(allowedTenants.size ? allowedTenants : new Set(["-"])));

  if ((smsFlows ?? []).length === 0 && (emailFlows ?? []).length === 0) {
    return { payments: rows.length, sms_enrolled: 0, email_enrolled: 0 };
  }

  // Contato: usa o do pagamento e, na falta, o do lead.
  const playerIds = Array.from(new Set(rows.map((r) => r.player_id as string)));
  const contatos = new Map<string, { telefone: string | null; email: string | null }>();
  for (let i = 0; i < playerIds.length; i += 500) {
    const { data: ps } = await supabaseAdmin
      .from("players")
      .select("id, telefone, email")
      .in("id", playerIds.slice(i, i + 500));
    (ps ?? []).forEach((p) => {
      contatos.set(p.id, { telefone: p.telefone ?? null, email: p.email ?? null });
    });
  }

  let smsEnrolled = 0;
  let emailEnrolled = 0;
  const priority = new Date(0).toISOString();

  for (const cb of rows) {
    const tenantId = cb.tenant_id;
    const playerId = cb.player_id as string;
    if (!allowedTenants.has(tenantId)) continue;
    const contato = contatos.get(playerId);
    const phone = (cb.telefone ?? contato?.telefone ?? "").replace(/\D/g, "");
    const email = cb.email ?? contato?.email ?? null;

    for (const f of (smsFlows ?? []).filter((f) => f.tenant_id === tenantId)) {
      if (phone.length < 10) continue;
      // Índice único (flow_id, player_id): reinicia a inscrição existente
      // quando o lead já passou por este fluxo em cashbacks anteriores.
      const { data: existing } = await supabaseAdmin
        .from("sms_flow_leads")
        .select("id, status, created_at")
        .eq("flow_id", f.id)
        .eq("player_id", playerId)
        .maybeSingle();
      if (existing) {
        const active = ["pending", "running"].includes(existing.status as string);
        const jaProcessado = (existing.created_at as string) >= (cb.paid_at as string);
        if (active || jaProcessado) continue;
        const { error } = await supabaseAdmin
          .from("sms_flow_leads")
          .update({
            tenant_id: tenantId,
            phone_e164: phone,
            status: "pending",
            current_step_index: 0,
            next_run_at: priority,
          })
          .eq("id", existing.id);
        if (!error) smsEnrolled++;
        continue;
      }
      const { error } = await supabaseAdmin.from("sms_flow_leads").insert({
        tenant_id: tenantId,
        flow_id: f.id,
        player_id: playerId,
        phone_e164: phone,
        status: "pending",
        current_step_index: 0,
        next_run_at: priority,
      });
      if (!error) smsEnrolled++;
    }

    for (const f of (emailFlows ?? []).filter((f) => f.tenant_id === tenantId)) {
      if (!email) continue;
      const { data: existing } = await supabaseAdmin
        .from("email_flow_leads")
        .select("id, status, created_at")
        .eq("flow_id", f.id)
        .eq("player_id", playerId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existing) {
        const active = ["pending", "running"].includes(existing.status as string);
        const jaProcessado = (existing.created_at as string) >= (cb.paid_at as string);
        if (active || jaProcessado) continue;
        const { error } = await supabaseAdmin
          .from("email_flow_leads")
          .update({
            tenant_id: tenantId,
            email,
            status: "pending",
            current_block_index: 0,
            next_run_at: priority,
          })
          .eq("id", existing.id);
        if (!error) emailEnrolled++;
        continue;
      }
      const { error } = await supabaseAdmin.from("email_flow_leads").insert({
        tenant_id: tenantId,
        flow_id: f.id,
        player_id: playerId,
        email,
        status: "pending",
        current_block_index: 0,
        next_run_at: priority,
      });
      if (!error) emailEnrolled++;
    }
  }

  return { payments: rows.length, sms_enrolled: smsEnrolled, email_enrolled: emailEnrolled };
}