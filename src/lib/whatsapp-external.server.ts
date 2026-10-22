// Integração externa de WhatsApp: em vez de enviar mensagem pela Evolution,
// o BetLeads encaminha o evento de gatilho para o webhook de um CRM terceiro.
//
// Segurança (SEC-12): a URL é escolhida pelo cliente, então só admin/gestor
// da casa (ou super admin) pode configurá-la ou dispará-la; o destino passa
// pelo guard de SSRF (https, sem IP interno após DNS), redirects não são
// seguidos e o corpo da resposta nunca é persistido.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { TRIGGER_NAMES, type TriggerType } from "./triggers.server";
import { priorityRank } from "./priorities";
import {
  assertCallerNotBillingLocked,
  assertTenantNotDemo,
  demoSendBlockedReason,
} from "./tenant-access.server";
import {
  assertSafeOutboundUrl,
  safeOutboundFetch,
  UnsafeOutboundUrlError,
} from "./ssrf-guard.server";

const OUTBOUND_TIMEOUT_MS = 10_000;
const MAX_ERROR_LENGTH = 200;
const MANAGER_ROLES = new Set(["admin", "gestor"]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- user-scoped Supabase client (RLS) or a test double.
type UserDb = { from: (table: string) => any; rpc: (...args: any[]) => PromiseLike<any> };

function shortError(message: unknown): string {
  return String(message ?? "erro").slice(0, MAX_ERROR_LENGTH);
}

/**
 * Resolves the caller's active tenant and requires admin/gestor there (or
 * global super admin). Returns the tenant id.
 */
export async function assertExternalIntegrationManager(
  supabase: UserDb,
  userId: string,
): Promise<string> {
  const { data: tenantId, error: tenantError } = await supabase.rpc("current_tenant_id");
  if (tenantError) throw new Error(tenantError.message);
  if (!tenantId) throw new Error("Conta não identificada");

  const { data: isSuper, error: superError } = await supabaseAdmin.rpc("is_super_admin", {
    _user_id: userId,
  });
  if (superError) throw new Error("Não foi possível validar a permissão.");
  // A house locked for the monthly fee is refused for everyone but the superadmin.
  await assertCallerNotBillingLocked(supabase, String(tenantId), Boolean(isSuper));
  if (isSuper) return String(tenantId);

  const { data: roles, error: roleError } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("tenant_id", String(tenantId))
    .eq("user_id", userId);
  if (roleError) throw new Error("Não foi possível validar a permissão.");
  const allowed = ((roles ?? []) as Array<{ role: string }>).some((r) => MANAGER_ROLES.has(r.role));
  if (!allowed) {
    throw new Error("Acesso restrito a administradores e gestores da casa.");
  }
  return String(tenantId);
}

export type ExternalIntegrationInput = {
  url: string;
  active: boolean;
  triggers: string[];
  disable_internal?: boolean;
};

export async function saveExternalIntegrationFor(
  supabase: UserDb,
  userId: string,
  input: ExternalIntegrationInput,
) {
  const tenantId = await assertExternalIntegrationManager(supabase, userId);
  await assertTenantNotDemo(tenantId);
  const { url } = await assertSafeOutboundUrl(input.url);
  const { data: row, error } = await supabase
    .from("whatsapp_external_integrations")
    .upsert(
      {
        tenant_id: tenantId,
        url: url.toString(),
        active: input.active,
        triggers: input.triggers,
        disable_internal: input.disable_internal ?? true,
      },
      { onConflict: "tenant_id" },
    )
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return { integration: row };
}

/** Integration of the caller's tenant, for manual test / send-all actions. */
export async function loadManagedExternalIntegration(
  supabase: UserDb,
  userId: string,
): Promise<ExternalIntegration> {
  const tenantId = await assertExternalIntegrationManager(supabase, userId);
  const { data: integration, error } = await supabase
    .from("whatsapp_external_integrations")
    .select("id, tenant_id, url, active, triggers, disable_internal")
    .eq("tenant_id", tenantId)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!integration) throw new Error("Configure a URL do webhook primeiro");
  return integration as ExternalIntegration;
}

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

async function postWithRetry(tenantId: string, url: string, payload: unknown) {
  let lastErr: string | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    // Demo guard immediately before each outbound request (fail-closed).
    const blocked = await demoSendBlockedReason(tenantId);
    if (blocked) {
      return { ok: false, status: null as number | null, attempts: attempt - 1, error: blocked };
    }
    try {
      // Re-validated on every attempt (DNS may change between attempts).
      const res = await safeOutboundFetch(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
        { timeoutMs: OUTBOUND_TIMEOUT_MS },
      );
      // The body is drained but never stored or returned (it may echo PII).
      await res.body?.cancel().catch(() => {});
      if (res.ok) return { ok: true, status: res.status, attempts: attempt, error: null };
      if (res.status >= 300 && res.status < 400) {
        return {
          ok: false,
          status: res.status,
          attempts: attempt,
          error: `HTTP ${res.status} (redirect não é seguido)`,
        };
      }
      lastErr = `HTTP ${res.status}`;
      if (res.status < 500 && res.status !== 429) {
        return { ok: false, status: res.status, attempts: attempt, error: lastErr };
      }
    } catch (e) {
      if (e instanceof UnsafeOutboundUrlError) {
        return {
          ok: false,
          status: null as number | null,
          attempts: attempt,
          error: shortError(`Destino bloqueado: ${e.message}`),
        };
      }
      lastErr = shortError((e as Error)?.message ?? "network error");
    }
    await new Promise((r) => setTimeout(r, attempt * 800));
  }
  return { ok: false, status: null as number | null, attempts: 3, error: shortError(lastErr) };
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
  // Demo guard before the event is reserved: a demo (or unknown) tenant gets
  // a DEMO_SEND_BLOCKED result and nothing is written or sent. Returned, not
  // thrown, so a multi-tenant automation loop keeps going.
  const blocked = await demoSendBlockedReason(integration.tenant_id);
  if (blocked) return { sent: false, reason: blocked, httpStatus: null };
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

  const result = await postWithRetry(integration.tenant_id, integration.url, payload);

  await supabaseAdmin
    .from("whatsapp_external_events")
    .update({
      status: result.ok ? "sent" : "failed",
      http_status: result.status,
      response_body: null,
      error: result.error ? shortError(result.error) : null,
      attempts: result.attempts,
    })
    .eq("id", reserved.id);

  await supabaseAdmin
    .from("whatsapp_external_integrations")
    .update(
      result.ok
        ? { last_success_at: new Date().toISOString(), last_error: null }
        : { last_error: shortError(result.error) },
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