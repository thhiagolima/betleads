// PG3 Task 5 — settling a voice call's wallet reservation and recording the
// bill on its call_history row. Shared by the provider's final event
// (routes/api/public/infobip/voice/events.ts) and the 24 h reconciliation
// (infobip-voice-reconciliation.server.ts). Both settle under the same key
// (`voice-settle:<ref>`), so whichever runs second only gets the stored result.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { settleVoiceCall, type SettleVoiceCallResult } from "./billing/wallet.server";

/**
 * Whether the call was answered, from its call_history row: the CML callback
 * (cml.ts) sets `status = 'answered'` and appends a `cml_answered` callback
 * when Infobip fetches the CML, which only happens after the callee picks up.
 * The callback entry survives a later status change (a final event that was
 * processed but whose settlement failed), the status alone does not.
 */
export function voiceCallAnswered(row: {
  status?: string | null;
  provider_response?: unknown;
}): boolean {
  if (row.status === "answered") return true;
  const response = row.provider_response;
  if (!response || typeof response !== "object" || Array.isArray(response)) return false;
  const callbacks = (response as Record<string, unknown>).callbacks;
  return (
    Array.isArray(callbacks) &&
    callbacks.some(
      (callback) =>
        Boolean(callback) &&
        typeof callback === "object" &&
        (callback as Record<string, unknown>).type === "cml_answered",
    )
  );
}

export type SettleVoiceHistoryArgs = {
  tenantId: string;
  referenceId: string;
  /** call_history row to stamp with the bill; null when the row is missing. */
  historyId: string | null;
  durationSeconds: number | null;
  answered: boolean;
};

/**
 * Settles the reservation and, on success, fills billed_blocks, billed_amount
 * and billing_settled_at. Never throws: a failure is logged and returns null
 * (the reservation stays open and the 24 h reconciliation settles it).
 */
export async function settleVoiceHistory(
  args: SettleVoiceHistoryArgs,
): Promise<SettleVoiceCallResult | null> {
  let result: SettleVoiceCallResult;
  try {
    result = await settleVoiceCall(supabaseAdmin, {
      tenantId: args.tenantId,
      referenceId: args.referenceId,
      durationSeconds: args.durationSeconds,
      answered: args.answered,
    });
  } catch (error) {
    console.error("[voice billing] falha ao liquidar a ligação", {
      tenantId: args.tenantId,
      referenceId: args.referenceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  if (!result.ok || !args.historyId) return result;
  const { error } = await supabaseAdmin
    .from("call_history")
    .update({
      billed_blocks: result.blocks,
      billed_amount: result.billedAmount,
      billing_settled_at: new Date().toISOString(),
    } as never)
    .eq("id", args.historyId);
  if (error) {
    // The money is settled (the ledger is the source of truth); only the
    // row's copy of the bill is missing. A repeated final event replays the
    // settlement and writes it again.
    console.error("[voice billing] liquidação gravada, mas o histórico não foi atualizado", {
      tenantId: args.tenantId,
      referenceId: args.referenceId,
      historyId: args.historyId,
      error: (error as { message?: string }).message ?? String(error),
    });
  }
  return result;
}
