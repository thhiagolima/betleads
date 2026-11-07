// Delivery reports of SMS sent through an Infobip account
// (/api/public/infobip/sms/events). Infobip posts { results: [...] }; each
// result carries our idempotency key as messageId and callbackData
// (infobip-sms.server.ts), so the sms_send_logs row is found by
// provider_message_id and the tracked links by delivery key, like the Short
// Brasil webhook does.
//
// The callback's scope (provider-callback-tokens.server.ts) decides which
// rows a report may touch: an account token only its own sends, the global
// token never a house-owned account's send. A report for a row outside the
// scope is acknowledged and ignored.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { likeKeyPrefixPattern } from "./sql-like";
import { scopeAllowsRow, type CallbackScope } from "./provider-callback-tokens.server";

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

type ReportFilter = { scope: CallbackScope; ownedAccountIds: ReadonlySet<string> };

type ReportOutcome = "matched" | "ignored" | "unmatched";

/** Applies one delivery report to the send logs the scope allows. */
async function applyReport(report: JsonRecord, filter: ReportFilter): Promise<ReportOutcome> {
  const messageId = str(report.messageId);
  if (!messageId) return "unmatched";

  const { data: candidates, error: lookupError } = await supabaseAdmin
    .from("sms_send_logs")
    .select("id, provider_account_id, idempotency_key")
    .eq("provider_message_id", messageId);
  if (lookupError) throw new Error(lookupError.message);
  const rows = (candidates ?? []) as Array<{
    id: string;
    provider_account_id: string | null;
    idempotency_key?: string | null;
  }>;
  const allowedRows = rows.filter((row) =>
    scopeAllowsRow(filter.scope, row.provider_account_id ?? null, filter.ownedAccountIds),
  );
  const allowedIds = allowedRows.map((row) => row.id);
  if (rows.length > 0 && allowedIds.length === 0) return "ignored";
  // An account token never touches anything it cannot tie to its own send.
  if (allowedIds.length === 0 && filter.scope.kind === "account") return "ignored";

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

  let matched = false;
  if (allowedIds.length > 0) {
    const { data, error: updateError } = await supabaseAdmin
      .from("sms_send_logs")
      .update(patch)
      .in("id", allowedIds)
      .select("id");
    if (updateError) throw new Error(updateError.message);
    matched = (data ?? []).length > 0;
  }

  // Carries the confirmed outcome to the conversion report (never sent/accepted).
  // Keys of the matched rows only; with no row (platform scope only, as
  // before) the report's key, wildcards escaped so it never matches others.
  const payloadKey = str(report.callbackData) ?? messageId;
  const linkKeys = matched
    ? [...new Set(allowedRows.map((row) => row.idempotency_key).filter((k): k is string => !!k))]
    : [payloadKey];
  if (deliveryStatus === "delivered" || deliveryStatus === "failed") {
    for (const key of linkKeys) {
      const pattern = likeKeyPrefixPattern(key);
      if (!pattern) continue;
      await (supabaseAdmin as any) // eslint-disable-line @typescript-eslint/no-explicit-any
        .from("link_dispatches")
        .update({ delivery_status: deliveryStatus, delivered_at: deliveredAt })
        .like("idempotency_key", pattern);
    }
  }
  if (!matched) {
    console.warn("[infobip-sms-callback] report without a matching send", {
      messageId,
      deliveryStatus,
    });
  }
  return matched ? "matched" : "unmatched";
}

/** Applies every report of one callback body, within the callback's scope. */
export async function applyInfobipSmsReports(
  body: unknown,
  filter: ReportFilter,
): Promise<{ received: number; matched: number; ignored: number }> {
  const results = asRecord(body)?.results;
  const reports = (Array.isArray(results) ? results : Array.isArray(body) ? body : [body])
    .map(asRecord)
    .filter((r): r is JsonRecord => r !== null);
  let matched = 0;
  let ignored = 0;
  for (const report of reports) {
    const outcome = await applyReport(report, filter);
    if (outcome === "matched") matched++;
    else if (outcome === "ignored") ignored++;
  }
  return { received: reports.length, matched, ignored };
}
