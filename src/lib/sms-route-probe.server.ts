// Sonda da rota SMS (Short Brasil): a cada 30 min (cron
// 20261229100100_sms_route_probes_cron.sql) manda um SMS de controle para cada
// número cadastrado pelo super admin, pela conta Short Brasil padrão da
// plataforma. A resposta do provedor diz se há saldo; o callback da Short
// Brasil (sms-webhook.ts → applyRouteProbeCallback) diz se a rota entregou.
// Não cobra nenhuma casa e não grava em sms_send_logs.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireBrazilianPhone } from "@/lib/phone-normalization";
import {
  DEFAULT_SHORT_BRASIL_ACCOUNT_ID,
  loadProviderAccountForAdmin,
  platformDefaultAccountId,
  type ShortBrasilAccount,
} from "@/lib/provider-accounts.server";

import {
  MAX_PROBE_PHONES,
  classifyProbeSend,
  computeProbeStatus,
  newProbeCode,
  probeMessage,
  type ProbeResult,
  type ProbeRow,
  type ProbeStatus,
} from "./sms-route-probe";

const db = () => supabaseAdmin as any; // eslint-disable-line @typescript-eslint/no-explicit-any

export const PROBE_RETENTION_DAYS = 30;
const STATUS_WINDOW_MS = 24 * 3_600_000;

export type ProbeSettings = {
  enabled: boolean;
  phones: string[];
  updatedAt: string | null;
};

export type ProbeHistoryRow = ProbeRow & { message: string; callback_at: string | null };

export type ProbeOverview = {
  settings: ProbeSettings;
  status: ProbeStatus;
  accountLabel: string | null;
  recent: ProbeHistoryRow[];
};

export async function loadProbeSettings(): Promise<ProbeSettings> {
  const { data, error } = await db()
    .from("sms_route_probe_settings")
    .select("enabled, phones, updated_at")
    .eq("id", true)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as { enabled: boolean; phones: string[] | null; updated_at: string } | null;
  return {
    enabled: row?.enabled === true,
    phones: row?.phones ?? [],
    updatedAt: row?.updated_at ?? null,
  };
}

/** Valida e normaliza a lista (+55…, sem repetidos). Lança com a mensagem para a tela. */
export function normalizeProbePhones(raw: string[]): string[] {
  const phones: string[] = [];
  for (const entry of raw) {
    if (!entry.trim()) continue;
    let phone: string;
    try {
      phone = requireBrazilianPhone(entry);
    } catch {
      throw new Error(`Número inválido: "${entry.trim()}". Informe DDD e número.`);
    }
    if (!phones.includes(phone)) phones.push(phone);
  }
  if (phones.length > MAX_PROBE_PHONES) {
    throw new Error(`No máximo ${MAX_PROBE_PHONES} números.`);
  }
  return phones;
}

export async function saveProbeSettings(
  input: { enabled: boolean; phones: string[] },
  userId: string,
): Promise<ProbeSettings> {
  const phones = normalizeProbePhones(input.phones);
  if (input.enabled && phones.length === 0) {
    throw new Error("Cadastre pelo menos um número para ligar o teste.");
  }
  const updatedAt = new Date().toISOString();
  const { error } = await db()
    .from("sms_route_probe_settings")
    .upsert(
      { id: true, enabled: input.enabled, phones, updated_at: updatedAt, updated_by: userId },
      { onConflict: "id" },
    );
  if (error) throw new Error(error.message);
  return { enabled: input.enabled, phones, updatedAt };
}

/** Conta Short Brasil padrão da plataforma; se a padrão for Infobip, a conta Short Brasil do servidor. */
async function probeAccount(): Promise<ShortBrasilAccount> {
  const defaultId = await platformDefaultAccountId("sms");
  const account = await loadProviderAccountForAdmin(defaultId);
  if (account.provider === "short_brasil") return account;
  return (await loadProviderAccountForAdmin(DEFAULT_SHORT_BRASIL_ACCOUNT_ID)) as ShortBrasilAccount;
}

function providerMessageIdFrom(body: unknown): string | null {
  if (Array.isArray(body)) {
    const id = (body[0] as Record<string, unknown> | undefined)?.external_id;
    return typeof id === "string" && id ? id : null;
  }
  if (!body || typeof body !== "object") return null;
  const id = (body as Record<string, unknown>).id;
  if (typeof id === "string" && id) return id;
  if (typeof id === "number") return String(id);
  return null;
}

export type ProbeRunResult = {
  skipped: "disabled" | "no_phones" | null;
  sent: number;
  results: ProbeResult[];
};

/**
 * Uma rodada: um SMS por número. `force` (botão "Testar agora") envia mesmo
 * com a sonda desligada, desde que haja número cadastrado.
 */
export async function runSmsRouteProbe(
  now: Date,
  options: { force?: boolean } = {},
): Promise<ProbeRunResult> {
  const settings = await loadProbeSettings();
  if (settings.phones.length === 0) return { skipped: "no_phones", sent: 0, results: [] };
  if (!settings.enabled && !options.force) return { skipped: "disabled", sent: 0, results: [] };

  const account = await probeAccount();
  const { postShortBrasilSingle, summarizeProviderError } = await import("@/lib/sms.functions");
  const roundId = crypto.randomUUID();
  // Modelo diferente a cada envio: parte de um ponto que anda com o relógio.
  const baseIndex = Math.floor(now.getTime() / (60_000 * 30));
  const results: ProbeResult[] = [];

  for (const [i, phone] of settings.phones.entries()) {
    const code = newProbeCode();
    const message = probeMessage(code, baseIndex + i, now);
    const idempotencyKey = crypto.randomUUID();
    let ok = false;
    let httpStatus: number | null = null;
    let body: unknown = null;
    let errorSummary: string | null = null;
    try {
      const r = await postShortBrasilSingle(account, phone, message, idempotencyKey);
      ok = r.ok;
      httpStatus = r.status;
      body = r.body;
      errorSummary = r.ok ? null : summarizeProviderError(r.status, r.body);
    } catch (error) {
      errorSummary = error instanceof Error ? error.message : String(error);
    }
    const result = classifyProbeSend(ok, errorSummary);
    results.push(result);
    const { error } = await db()
      .from("sms_route_probes")
      .insert({
        round_id: roundId,
        probe_code: code,
        phone,
        message,
        provider_account_id: account.id,
        idempotency_key: idempotencyKey,
        sent_at: new Date().toISOString(),
        result,
        http_status: httpStatus,
        error: errorSummary,
        provider_message_id: ok ? providerMessageIdFrom(body) : null,
        provider_response: body ?? null,
      });
    if (error) console.error("[sms-route-probe] insert failed", error.message);
  }

  const cutoff = new Date(now.getTime() - PROBE_RETENTION_DAYS * 86_400_000).toISOString();
  const { error: purgeError } = await db().from("sms_route_probes").delete().lt("sent_at", cutoff);
  if (purgeError) console.error("[sms-route-probe] purge failed", purgeError.message);

  return { skipped: null, sent: results.length, results };
}

const PROBE_COLUMNS =
  "round_id, probe_code, phone, message, sent_at, result, error, delivery_status, delivered_at, callback_at";

export async function loadProbeOverview(now: Date): Promise<ProbeOverview> {
  const settings = await loadProbeSettings();
  const since = new Date(now.getTime() - STATUS_WINDOW_MS).toISOString();
  const { data, error } = await db()
    .from("sms_route_probes")
    .select(PROBE_COLUMNS)
    .gte("sent_at", since)
    .order("sent_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as ProbeHistoryRow[];
  let accountLabel: string | null = null;
  try {
    accountLabel = (await probeAccount()).label;
  } catch {
    accountLabel = null;
  }
  return {
    settings,
    status: computeProbeStatus(rows, settings.enabled, now),
    accountLabel,
    recent: rows.slice(0, 30),
  };
}

/** Status que a barra do topo usa (sem histórico). */
export async function loadProbeStatus(now: Date): Promise<ProbeStatus> {
  const settings = await loadProbeSettings();
  if (!settings.enabled) return computeProbeStatus([], false, now);
  const since = new Date(now.getTime() - STATUS_WINDOW_MS).toISOString();
  const { data, error } = await db()
    .from("sms_route_probes")
    .select(PROBE_COLUMNS)
    .gte("sent_at", since)
    .order("sent_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  return computeProbeStatus((data ?? []) as ProbeRow[], true, now);
}

const FINAL = new Set(["delivered", "failed"]);

/**
 * Callback da Short Brasil de um SMS de controle. Chamado pelo sms-webhook só
 * quando o callback não casou com nenhum envio em sms_send_logs. Um status
 * não final nunca sobrescreve um final. Devolve true quando era uma sonda.
 */
export async function applyRouteProbeCallback(args: {
  providerMessageId: string | null;
  idempotencyKey: string | null;
  deliveryStatus: string;
  deliveredAt: string | null;
  error: string | null;
  payload: unknown;
}): Promise<boolean> {
  if (!args.providerMessageId && !args.idempotencyKey) return false;
  // Duas buscas simples (sem montar filtro `or` com texto vindo do callback).
  let data: unknown = null;
  for (const [column, value] of [
    ["provider_message_id", args.providerMessageId],
    ["idempotency_key", args.idempotencyKey],
  ] as const) {
    if (!value) continue;
    const found = await db()
      .from("sms_route_probes")
      .select("id, delivery_status")
      .eq(column, value)
      .limit(1);
    if (found.error) {
      console.error("[sms-route-probe] callback lookup failed", found.error.message);
      return false;
    }
    if (found.data?.length) {
      data = found.data;
      break;
    }
  }
  const probe = (data as Array<{ id: string; delivery_status: string | null }> | null)?.[0];
  if (!probe) return false;
  const isFinal = FINAL.has(args.deliveryStatus);
  if (!isFinal && probe.delivery_status && FINAL.has(probe.delivery_status)) return true;
  const patch: Record<string, unknown> = {
    delivery_status: args.deliveryStatus,
    last_callback: args.payload,
    callback_at: new Date().toISOString(),
  };
  if (args.deliveredAt) patch.delivered_at = args.deliveredAt;
  if (args.error) patch.error = args.error;
  const { error: updateError } = await db().from("sms_route_probes").update(patch).eq("id", probe.id);
  if (updateError) console.error("[sms-route-probe] callback update failed", updateError.message);
  return true;
}

