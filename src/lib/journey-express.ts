/**
 * Express journeys ("Envio imediato — fura fila").
 *
 * The send rules live in SQL (supabase/migrations/20261015122000_express_journeys.sql):
 * an express journey skips the cross-journey cooldown, the global 24h/7d contact
 * limits and priority arbitration, and is claimed first by the dispatcher. It
 * keeps idempotency, its own daily limit, re-entry rules, consent and the send
 * window. This module holds the permission rule and the toggle flow so they
 * can be tested without a server runtime.
 */

export type JourneyEditorRole = "admin" | "gestor" | "member" | "super_admin";

export const EXPRESS_JOURNEY_HINT =
  "Fura fila: ignora o intervalo entre jornadas e os limites globais de contato; envia assim que o lead entra (respeitando consentimento e janela de envio).";

/** Same rule as editing journeys: admin, gestor or super admin. */
export function canToggleJourneyExpress(role: JourneyEditorRole | null | undefined): boolean {
  return role === "admin" || role === "gestor" || role === "super_admin";
}

export type ToggleJourneyExpressDeps = {
  role: () => Promise<JourneyEditorRole | null>;
  loadJourney: () => Promise<{ id: string; express: boolean; status: string } | null>;
  updateExpress: (express: boolean) => Promise<void>;
  /** Pulls items deferred by the rules express skips back to now. */
  requeue: () => Promise<number>;
  audit: (detail: Record<string, unknown>) => Promise<void>;
};

export async function toggleJourneyExpress(
  deps: ToggleJourneyExpressDeps,
  express: boolean,
): Promise<{ ok: true; express: boolean; requeued: number; changed: boolean }> {
  if (!canToggleJourneyExpress(await deps.role()))
    throw new Error("Você não tem permissão para alterar o envio imediato desta jornada.");
  const journey = await deps.loadJourney();
  if (!journey) throw new Error("Jornada não encontrada.");
  if (journey.express === express) return { ok: true, express, requeued: 0, changed: false };
  await deps.updateExpress(express);
  let requeued = 0;
  if (express) {
    try {
      requeued = await deps.requeue();
    } catch {
      // The flag is already saved; requeueing is best-effort (new items are
      // express anyway). Never fail the toggle because of it.
      requeued = 0;
    }
  }
  await deps.audit({ from: journey.express, to: express, requeued });
  return { ok: true, express, requeued, changed: true };
}
