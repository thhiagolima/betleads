import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { deferIfOutsideWindow } from "./send-window.server";

export type ConsentChannel = "sms" | "email" | "voice";
export type ConsentStatus = "granted" | "revoked";

export const DEFAULT_VOICE_FREQUENCY_POLICY = {
  enabled: true,
  cooldown_hours: 24,
  rolling_24h_limit: 1,
} as const;

export function resolveVoiceFrequencyPolicy(
  policy: { enabled: boolean; cooldown_hours: number; rolling_24h_limit: number } | null,
) {
  return policy ?? DEFAULT_VOICE_FREQUENCY_POLICY;
}

export function normalizeConsentSubject(channel: ConsentChannel, subject: string) {
  if (channel === "email") return subject.trim().toLowerCase();
  const digits = subject.replace(/\D/g, "");
  return digits.length === 10 || digits.length === 11 ? `55${digits}` : digits;
}

export async function isChannelRevoked(tenantId: string, channel: ConsentChannel, subject: string) {
  return (await getChannelConsentStatus(tenantId, channel, subject)) === "revoked";
}

export async function getChannelConsentStatus(
  tenantId: string,
  channel: ConsentChannel,
  subject: string,
): Promise<ConsentStatus | null> {
  const normalized = normalizeConsentSubject(channel, subject);
  if (!normalized) return "revoked";
  const { data, error } = await (supabaseAdmin as any)
    .from("channel_consents")
    .select("status")
    .eq("tenant_id", tenantId)
    .eq("channel", channel)
    .eq("subject", normalized)
    .maybeSingle();
  if (error) throw new Error(`Falha ao validar consentimento: ${error.message}`);
  return (data?.status as ConsentStatus | undefined) ?? null;
}

export async function syncLegacySuppression(
  tenantId: string,
  channel: ConsentChannel,
  subject: string,
  status: ConsentStatus,
  reason: string,
  source: string,
) {
  const normalized = normalizeConsentSubject(channel, subject);
  if (channel === "sms") {
    const query = supabaseAdmin.from("sms_suppressions");
    const { error } =
      status === "revoked"
        ? await query.upsert(
            { tenant_id: tenantId, phone: normalized, reason, source },
            { onConflict: "tenant_id,phone" },
          )
        : await query.delete().eq("tenant_id", tenantId).eq("phone", normalized);
    if (error) throw new Error(`Falha ao sincronizar supressao de SMS: ${error.message}`);
  }
  if (channel === "email") {
    const query = supabaseAdmin.from("suppressed_emails");
    const { error } =
      status === "revoked"
        ? await query.upsert(
            { email: normalized, tenant_id: tenantId, reason: "manual", source, notes: reason },
            { onConflict: "email" },
          )
        : await query.delete().eq("tenant_id", tenantId).ilike("email", normalized);
    if (error) throw new Error(`Falha ao sincronizar supressao de e-mail: ${error.message}`);
  }
}

export async function evaluateVoiceContactPolicy(tenantId: string, subject: string) {
  const phone = normalizeConsentSubject("voice", subject);
  if (await isChannelRevoked(tenantId, "voice", phone))
    return { allowed: false as const, reason: "consent_revoked" as const, retryAt: null };
  const deferUntil = await deferIfOutsideWindow(new Date(), tenantId);
  if (deferUntil)
    return {
      allowed: false as const,
      reason: "outside_contact_window" as const,
      retryAt: deferUntil,
    };

  const { data: policy, error: policyError } = await (supabaseAdmin as any)
    .from("voice_contact_policies")
    .select("enabled,cooldown_hours,rolling_24h_limit")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (policyError) throw new Error(`Falha ao validar politica de voz: ${policyError.message}`);
  // Voice is fail-closed for frequency: a missing policy must not turn a
  // configuration/data issue into unlimited automatic calls. Operators can
  // change the values later, but the safe account baseline is always applied.
  const frequencyPolicy = resolveVoiceFrequencyPolicy(policy);
  if (frequencyPolicy.enabled !== true) return { allowed: true as const, reason: null, retryAt: null };

  const cooldownHours = Number(frequencyPolicy.cooldown_hours);
  const dailyLimit = Number(frequencyPolicy.rolling_24h_limit);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const candidates = [phone, `+${phone}`];
  const { data: recent, error } = await supabaseAdmin
    .from("call_history")
    .select("created_at")
    .eq("tenant_id", tenantId)
    .in("to_phone", candidates)
    .in("status", ["pending", "calling", "answered", "completed", "converted"] as any)
    .gte("created_at", since)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Falha ao validar frequencia de voz: ${error.message}`);
  if ((recent?.length ?? 0) >= dailyLimit) {
    const retryAt = new Date(
      new Date(recent![recent!.length - dailyLimit].created_at).getTime() + 24 * 60 * 60 * 1000,
    ).toISOString();
    return { allowed: false as const, reason: "rolling_24h_limit" as const, retryAt };
  }
  if (cooldownHours > 0 && recent?.[0]) {
    const retryAtDate = new Date(
      new Date(recent[0].created_at).getTime() + cooldownHours * 60 * 60 * 1000,
    );
    if (retryAtDate.getTime() > Date.now())
      return {
        allowed: false as const,
        reason: "cooldown" as const,
        retryAt: retryAtDate.toISOString(),
      };
  }
  return { allowed: true as const, reason: null, retryAt: null };
}
