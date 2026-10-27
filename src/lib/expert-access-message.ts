// Client-safe helper for the Área do Expert screens (Fase 1, Task 9).
//
// `getExpertHome`/`listExpertLeads` throw `ExpertAccessError` (server-only,
// so never imported here) for two cases: no active expert access (message
// "Acesso de expert não encontrado ou desativado.") or a suspended house
// ("Esta casa está indisponível no momento."). The second is shown as-is
// (as is "Lead não encontrado.", from the lead sheet's `loadVisibleLead`);
// the first, and any other unexpected error (including a non-Error value),
// collapses to the generic "exclusiva para experts" message so a route
// never leaks internal error details to a non-expert who lands on it.
export const HOUSE_UNAVAILABLE_MESSAGE = "Esta casa está indisponível no momento.";
export const GENERIC_ACCESS_MESSAGE = "Esta área é exclusiva para experts.";
/** `loadVisibleLead` (ficha do lead, Fase 2): lead inexistente ou fora do alcance. */
export const LEAD_NOT_FOUND_MESSAGE = "Lead não encontrado.";

const PASS_THROUGH_MESSAGES = new Set([HOUSE_UNAVAILABLE_MESSAGE, LEAD_NOT_FOUND_MESSAGE]);

export function expertAccessErrorMessage(error: unknown): string {
  if (error instanceof Error && PASS_THROUGH_MESSAGES.has(error.message)) {
    return error.message;
  }
  return GENERIC_ACCESS_MESSAGE;
}
