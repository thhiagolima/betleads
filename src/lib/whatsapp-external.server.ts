// Integração externa de WhatsApp: em vez de enviar mensagem pela Evolution,
// o BetLeads encaminha o evento de gatilho para o webhook de um CRM terceiro.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { TRIGGER_NAMES, type TriggerType } from "./triggers.server";
import { priorityRank } from "./priorities";

export type ExternalIntegration = {
  id: string;
  tenant_id: string;
  url: string;
  active: boolean;
  triggers: string[];
  disable_internal: boolean;
};

export type ExternalLeadInput = {
  id: string | null;
  player_external_id?: string | null;
  nome?: string | null;
  telefone: string;
  email?: string | null;
  vip?: boolean | null;
  total_depositado?: number | null;
  total_sacado?: number | null;
  saldo_carteira?: number | null;
  media_deposito?: number | null;
  dep_30d?: number | null;
  qtd_logins_30d?: number | null;
  ultimo_login?: string | null;
  ultimo_deposito?: string | null;
  ultimo_jogo?: string | null;
  ftd_em?: string | null;
  created_at?: string | null;
};

// Cache curto por execução do worker.
export async function loadActiveIntegrations(): Promise<Map<string, ExternalIntegration>> {
  const { data } = await supabaseAdmin
    .from("whatsapp_external_integrations")
    .select("id, tenant_id, url, active, triggers, disable_internal")
    .eq("active", true);
  const map = new Map<string, ExternalIntegration>();
  for (const row of (data ?? []) as ExternalIntegration[]) {
    map.set(row.tenant_id, row);
  }
  return map;
}

export function pickExternalTrigger(
  triggers: TriggerType[],
  integration: ExternalIntegration,
): TriggerType | null {
  const allowed = integration.triggers.length
    ? triggers.filter((t) => integration.triggers.includes(t))
    : triggers;
  if (!allowed.length) return null;
  return [...allowed].sort((a, b) => priorityRank(a) - priorityRank(b))[0];
}

function buildPayload(
  trigger: TriggerType,
  lead: ExternalLeadInput,
  tenantId: string,
) {
  return {
    event: "trigger",
    trigger,
    trigger_label: TRIGGER_NAMES[trigger] ?? trigger,
    priority_rank: priorityRank(trigger),
    occurred_at: new Date().toISOString(),
    tenant_id: tenantId,
    lead: {
      id: lead.id,
      external_id: lead.player_external_id ?? null,
      nome: lead.nome ?? null,
      telefone: lead.telefone,
      email: lead.email ?? null,
      vip: Boolean(lead.vip),
    },
    metrics: {
      total_depositado: Number(lead.total_depositado ?? 0),
      total_sacado: Number(lead.total_sacado ?? 0),
      saldo_carteira: Number(lead.saldo_carteira ?? 0),
      media_deposito: Number(lead.media_deposito ?? 0),
      depositos_30d: Number(lead.dep_30d ?? 0),
      logins_30d: Number(lead.qtd_logins_30d ?? 0),
      ultimo_login: lead.ultimo_login ?? null,
      ultimo_deposito: lead.ultimo_deposito ?? null,
      ultimo_jogo: lead.ultimo_jogo ?? null,
      ftd_em: lead.ftd_em ?? null,
      cadastrado_em: lead.created_at ?? null,
    },
  };
}

async function postWithRetry(url: string, payload: unknown) {
  let lastErr: string | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.text().catch(() => "")).slice(0, 800);
      if (res.ok) return { ok: true, status: res.status, body, attempts: attempt, error: null };
      lastErr = `HTTP ${res.status}`;
      if (res.status < 500 && res.status !== 429) {
        return { ok: false, status: res.status, body, attempts: attempt, error: lastErr };
      }
    } catch (e: any) {
      lastErr = e?.message ?? "network error";
    }
    await new Promise((r) => setTimeout(r, attempt * 800));
  }
  return { ok: false, status: null as number | null, body: "", attempts: 3, error: lastErr };
}

// Envia um evento de gatilho para o webhook externo.
// Idempotente: o índice único (tenant, player, trigger) garante 1x por gatilho.
export async function sendExternalTriggerEvent(opts: {
  integration: ExternalIntegration;
  trigger: TriggerType;
  lead: ExternalLeadInput;
  isTest?: boolean;
}): Promise<{ sent: boolean; reason?: string; httpStatus?: number | null }> {
  const { integration, trigger, lead } = opts;
  const isTest = Boolean(opts.isTest);
  const payload = buildPayload(trigger, lead, integration.tenant_id);

  // Reserva antes de enviar — evita duplicidade em execuções concorrentes.
  const { data: reserved, error: reserveErr } = await supabaseAdmin
    .from("whatsapp_external_events")
    .insert({
      tenant_id: integration.tenant_id,
      player_id: isTest ? null : lead.id,
      phone_e164: lead.telefone,
      trigger_type: trigger,
      payload,
      status: "pending",
      is_test: isTest,
    })
    .select("id")
    .maybeSingle();

  if (reserveErr || !reserved) {
    return { sent: false, reason: "already_sent" };
  }

  const result = await postWithRetry(integration.url, payload);

  await supabaseAdmin
    .from("whatsapp_external_events")
    .update({
      status: result.ok ? "sent" : "failed",
      http_status: result.status,
      response_body: result.body || null,
      error: result.error,
      attempts: result.attempts,
    })
    .eq("id", reserved.id);

  await supabaseAdmin
    .from("whatsapp_external_integrations")
    .update(
      result.ok
        ? { last_success_at: new Date().toISOString(), last_error: null }
        : { last_error: result.error },
    )
    .eq("id", integration.id);

  return { sent: result.ok, reason: result.error ?? undefined, httpStatus: result.status };
}

// Dispara 1 evento de amostra de cada gatilho existente.
// Continua mesmo quando o destino responde erro — retorna o resultado de cada um.
export async function sendAllTriggerSamples(integration: ExternalIntegration): Promise<
  Array<{ trigger: string; label: string; ok: boolean; httpStatus: number | null; reason: string | null }>
> {
  const now = new Date().toISOString();
  const results: Array<{
    trigger: string;
    label: string;
    ok: boolean;
    httpStatus: number | null;
    reason: string | null;
  }> = [];

  const triggers = Object.keys(TRIGGER_NAMES) as TriggerType[];
  for (const trigger of triggers) {
    const lead: ExternalLeadInput = {
      id: null,
      player_external_id: `AMOSTRA-${trigger.toUpperCase()}`,
      nome: `Lead amostra ${TRIGGER_NAMES[trigger]}`,
      telefone: "5511999999999",
      email: "amostra@betleads.io",
      vip: true,
      total_depositado: 1250,
      total_sacado: 300,
      saldo_carteira: 87.5,
      media_deposito: 62.5,
      dep_30d: 400,
      qtd_logins_30d: 12,
      ultimo_login: now,
      ultimo_deposito: now,
      ultimo_jogo: now,
      ftd_em: now,
      created_at: now,
    };

    try {
      const res = await sendExternalTriggerEvent({ integration, trigger, lead, isTest: true });
      results.push({
        trigger,
        label: TRIGGER_NAMES[trigger],
        ok: res.sent,
        httpStatus: res.httpStatus ?? null,
        reason: res.reason ?? null,
      });
    } catch (e: any) {
      results.push({
        trigger,
        label: TRIGGER_NAMES[trigger],
        ok: false,
        httpStatus: null,
        reason: e?.message ?? "erro inesperado",
      });
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  return results;
}