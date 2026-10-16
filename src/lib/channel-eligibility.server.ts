import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isSuppressed } from "./email-deliverability.server";
import {
  getChannelConsentStatus,
  isChannelRevoked,
  normalizeConsentSubject,
} from "./consent.server";
import { normalizeBrazilianPhone } from "./phone-normalization";

export type Channel = "sms" | "email" | "call" | "whatsapp";
export type BlockReason =
  | "missing_phone"
  | "invalid_phone"
  | "missing_email"
  | "invalid_email"
  | "email_opt_out"
  | "sms_opt_out"
  | "voice_opt_out";

export type ChannelEligibility = {
  eligible: boolean;
  reason?: BlockReason;
  phone: string | null;
  email: string | null;
};

export function normalizePhone(raw: string | null | undefined): string | null {
  return normalizeBrazilianPhone(raw);
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  const email = raw?.trim().toLowerCase() ?? "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/**
 * sms_suppressions stores digits only (CHECK phone ~ '^[0-9]{10,20}$'), the
 * same form normalizeConsentSubject gives ("5521980194445"), never "+55..."
 * (QA-04). Fail-closed (QA-03): a lookup error throws, so the caller does not
 * enroll/send and the run is retried.
 */
export async function isSmsSuppressed(tenantId: string, phone: string): Promise<boolean> {
  const subject = normalizeConsentSubject("sms", phone);
  if (!subject) return false;
  const { data, error } = await supabaseAdmin
    .from("sms_suppressions")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("phone", subject)
    .maybeSingle();
  if (error) throw new Error(`Falha ao consultar supressao de SMS: ${error.message}`);
  return Boolean(data);
}

/** Fonte unica de elegibilidade para a entrada nos canais automatizados. */
export async function channelEligibility(
  channel: Channel,
  contact: { telefone: string | null | undefined; email: string | null | undefined },
  tenantId: string,
): Promise<ChannelEligibility> {
  const phone = normalizePhone(contact.telefone);
  const email = normalizeEmail(contact.email);

  if (channel === "email") {
    if (!contact.email?.trim()) return { eligible: false, reason: "missing_email", phone, email };
    if (!email) return { eligible: false, reason: "invalid_email", phone, email };
    const centralStatus = await getChannelConsentStatus(tenantId, "email", email);
    if (
      centralStatus === "revoked" ||
      (centralStatus !== "granted" && (await isSuppressed(email, tenantId)))
    )
      return { eligible: false, reason: "email_opt_out", phone, email };
    return { eligible: true, phone, email };
  }

  if (!contact.telefone?.trim()) return { eligible: false, reason: "missing_phone", phone, email };
  if (!phone) return { eligible: false, reason: "invalid_phone", phone, email };
  if (
    channel === "sms" &&
    ((await isChannelRevoked(tenantId, "sms", phone)) || (await isSmsSuppressed(tenantId, phone)))
  ) {
    return { eligible: false, reason: "sms_opt_out", phone, email };
  }
  if (channel === "call" && (await isChannelRevoked(tenantId, "voice", phone)))
    return { eligible: false, reason: "voice_opt_out", phone, email };
  return { eligible: true, phone, email };
}
