import { supabaseAdmin } from "@/integrations/supabase/client.server";

const MIN_AGE_MS = 15 * 60_000;
const MAX_AGE_MS = 3 * 24 * 60 * 60_000;
const ALERT_AGE_MS = 24 * 60 * 60_000;

/**
 * Audits calls for which the CML post-call notification has not reached us.
 *
 * CML exposes `notifyUrl` as the post-call summary mechanism. This job is
 * deliberately not a second dispatcher and does not infer a final result: a
 * status is changed only by an Infobip callback. It leaves an auditable trail
 * and makes missing callbacks visible until a provider report integration is
 * explicitly enabled for the account.
 */
export async function reconcilePendingInfobipVoiceCalls(limit = 500) {
  const now = Date.now();
  const { data: rows, error } = await supabaseAdmin
    .from("call_history")
    .select("id, provider_call_id, created_at, provider_response")
    .eq("provider", "infobip")
    .in("status", ["pending", "answered"])
    .lte("created_at", new Date(now - MIN_AGE_MS).toISOString())
    .gte("created_at", new Date(now - MAX_AGE_MS).toISOString())
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw error;

  let alerted = 0;
  await Promise.all(
    (rows ?? []).map(async (row) => {
      const ageMs = now - new Date(row.created_at).getTime();
      const previous = row.provider_response && typeof row.provider_response === "object"
        ? row.provider_response as Record<string, unknown>
        : {};
      const existing = previous.reconciliation && typeof previous.reconciliation === "object"
        ? previous.reconciliation as Record<string, unknown>
        : {};
      const requiresAttention = ageMs >= ALERT_AGE_MS;
      if (requiresAttention) alerted += 1;
      const { error: updateError } = await supabaseAdmin
        .from("call_history")
        .update({
          provider_response: {
            ...previous,
            reconciliation: {
              ...existing,
              last_audited_at: new Date(now).toISOString(),
              callback_missing: true,
              requires_attention: requiresAttention,
            },
          } as never,
        })
        .eq("id", row.id)
        .in("status", ["pending", "answered"]);
      if (updateError) throw updateError;
    }),
  );

  if (alerted > 0) {
    console.warn("[infobip voice reconciliation] callbacks pendentes ha mais de 24h", { alerted });
  }
  return { audited: rows?.length ?? 0, alerted };
}

async function auditCallbackRows(
  rows: Array<{ id: string; created_at: string; provider_response: unknown }> | null,
  update: (
    id: string,
    response: Record<string, unknown>,
  ) => PromiseLike<{ error: unknown | null }>,
) {
  const now = Date.now();
  let alerted = 0;
  await Promise.all(
    (rows ?? []).map(async (row) => {
      const ageMs = now - new Date(row.created_at).getTime();
      const previous = row.provider_response && typeof row.provider_response === "object"
        ? row.provider_response as Record<string, unknown>
        : {};
      const existing = previous.reconciliation && typeof previous.reconciliation === "object"
        ? previous.reconciliation as Record<string, unknown>
        : {};
      const requiresAttention = ageMs >= ALERT_AGE_MS;
      if (requiresAttention) alerted += 1;
      const { error } = await update(row.id, {
        ...previous,
        reconciliation: {
          ...existing,
          last_audited_at: new Date(now).toISOString(),
          callback_missing: true,
          requires_attention: requiresAttention,
        },
      });
      if (error) throw error;
    }),
  );
  return { audited: rows?.length ?? 0, alerted };
}

/** Same daily safety net for Infobip Email callbacks. */
export async function reconcilePendingInfobipEmails(limit = 500) {
  const now = Date.now();
  const { data: rows, error } = await supabaseAdmin
    .from("email_send_logs")
    .select("id, created_at, provider_response")
    .in("status", ["pending", "sent"])
    .lte("created_at", new Date(now - MIN_AGE_MS).toISOString())
    .gte("created_at", new Date(now - MAX_AGE_MS).toISOString())
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  const result = await auditCallbackRows(rows, (id, providerResponse) =>
    supabaseAdmin
      .from("email_send_logs")
      .update({ provider_response: providerResponse as never })
      .eq("id", id)
      .in("status", ["pending", "sent"]),
  );
  if (result.alerted) console.warn("[infobip email reconciliation] callbacks pendentes ha mais de 24h", result);
  return result;
}

/** SMS is also callback-first; this exposes missing Short Brasil callbacks. */
export async function reconcilePendingShortBrasilSms(limit = 500) {
  const now = Date.now();
  const { data: rows, error } = await supabaseAdmin
    .from("sms_send_logs")
    .select("id, created_at, provider_response")
    .eq("provider", "short-brasil")
    .in("delivery_status", ["pending", "sent"])
    .lte("created_at", new Date(now - MIN_AGE_MS).toISOString())
    .gte("created_at", new Date(now - MAX_AGE_MS).toISOString())
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  const result = await auditCallbackRows(rows, (id, providerResponse) =>
    supabaseAdmin
      .from("sms_send_logs")
      .update({ provider_response: providerResponse as never })
      .eq("id", id)
      .in("delivery_status", ["pending", "sent"]),
  );
  if (result.alerted) console.warn("[short brasil sms reconciliation] callbacks pendentes ha mais de 24h", result);
  return result;
}

export async function reconcileChannelCallbacks() {
  const [voice, email, sms] = await Promise.all([
    reconcilePendingInfobipVoiceCalls(),
    reconcilePendingInfobipEmails(),
    reconcilePendingShortBrasilSms(),
  ]);
  return { voice, email, sms };
}
