// PG3 Task 5 (addendum a): shared log for a failed voice call_history insert.
// No imports on purpose: used by every voice dispatcher, whose tests mock
// the provider and wallet modules.

/**
 * A call_history insert that fails after the call was placed must not lose
 * the call result (the queue item is still updated and counted), but the
 * reservation then has no row to settle from: logged with the billing
 * reference and the correlation id so it can be traced. The 24 h
 * reconciliation settles such a reservation as unanswered.
 */
export function logCallHistoryInsertError(
  source: string,
  error: { message?: string } | unknown,
  result: { idempotencyKey?: string | null; billing?: { referenceId: string } | null },
): void {
  console.error("[voice] falha ao gravar call_history da ligação", {
    source,
    referenceId: result.billing?.referenceId ?? null,
    correlationId: result.idempotencyKey ?? null,
    error: (error as { message?: string })?.message ?? String(error),
  });
}
