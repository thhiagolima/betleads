// Delivery reports of SMS sent through an Infobip account
// (/api/public/infobip/sms/events). Infobip posts { results: [...] }; each
// result carries our idempotency key as messageId and callbackData
// (infobip-sms.server.ts), so the sms_send_logs row is found by
// provider_message_id and the tracked links by delivery key, like the Short
// Brasil webhook does.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** Infobip status group -> sms_send_logs.delivery_status. */
export function infobipSmsDeliveryStatus(report: JsonRecord): string {
  const status = asRecord(report.status);
  const group = String(status?.groupName ?? "").toUpperCase();
  if (group === "DELIVERED") return "delivered";
  if (group === "PENDING") return "sent";
  if (group === "UNDELIVERABLE" || group === "EXPIRED" || group === "REJECTED") return "failed";
  return "unknown";
}

function isoDate(raw: unknown): string | null {
  const value = str(raw);
  if (!value) return null;
  // Infobip sends "2026-10-29T15:00:00.000+0000".
  const date = new Date(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Applies one delivery report. Returns whether a send log matched. */
async function applyReport(report: JsonRecord): Promise<boolean> {
  const messageId = str(report.messageId);
  const deliveryKey = str(report.callbackData) ?? messageId;
  if (!messageId) return false;
  const deliveryStatus = infobipSmsDeliveryStatus(report);
  const status = asRecord(report.status);
  const error = asRecord(report.error);
  const deliveredAt =
    deliveryStatus === "delivered" ? (isoDate(report.doneAt) ?? new Date().toISOString()) : null;
  const errorText =
    deliveryStatus === "failed"
      ? (str(error?.description) ?? str(status?.description) ?? str(status?.name))
      : null;

  const patch: {
    delivery_status: string;
    last_callback: Json;
    delivered_at?: string;
    error?: string;
  } = { delivery_status: deliveryStatus, last_callback: report as Json };
  if (deliveredAt) patch.delivered_at = deliveredAt;
  if (errorText) patch.error = errorText;

  const { data, error: updateError } = await supabaseAdmin
    .from("sms_send_logs")
    .update(patch)
    .eq("provider_message_id", messageId)
    .select("id");
  if (updateError) throw new Error(updateError.message);
  const matched = (data ?? []).length > 0;

  // Carries the confirmed outcome to the conversion report (never sent/accepted).
  if (deliveryKey && (deliveryStatus === "delivered" || deliveryStatus === "failed")) {
    await (supabaseAdmin as any) // eslint-disable-line @typescript-eslint/no-explicit-any
      .from("link_dispatches")
      .update({ delivery_status: deliveryStatus, delivered_at: deliveredAt })
      .like("idempotency_key", `${deliveryKey}:%`);
  }
  if (!matched) {
    console.warn("[infobip-sms-callback] report without a matching send", {
      messageId,
      deliveryStatus,
    });
  }
  return matched;
}

/** Applies every report of one callback body. */
export async function applyInfobipSmsReports(
  body: unknown,
): Promise<{ received: number; matched: number }> {
  const results = asRecord(body)?.results;
  const reports = (Array.isArray(results) ? results : Array.isArray(body) ? body : [body])
    .map(asRecord)
    .filter((r): r is JsonRecord => r !== null);
  let matched = 0;
  for (const report of reports) if (await applyReport(report)) matched++;
  return { received: reports.length, matched };
}
