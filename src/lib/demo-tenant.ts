// Demo tenant errors and UI copy. No server-only import here: the UI imports
// this module directly (banners, empty states, blocked-send toasts), while
// `tenant-access.server.ts` throws these same errors from the guards.

export type DemoTenantBlockedErrorCode = "DEMO_SEND_BLOCKED" | "DEMO_ACTION_BLOCKED";

/**
 * Thrown by the server guards whenever a demo tenant, or an unknown/missing
 * tenant (fail-closed), attempts something that would reach a real provider
 * or mutate team/integration/config state.
 *
 * The code is embedded in `message` on purpose: TanStack Start server
 * functions serialize thrown errors to plain text on the way to the client,
 * so `isDemoBlockedError` must still recognize the code after that trip.
 */
export class DemoTenantBlockedError extends Error {
  code: DemoTenantBlockedErrorCode;

  constructor(code: DemoTenantBlockedErrorCode) {
    super(`${code}: ${demoTenantBlockedMessages[code]}`);
    this.name = "DemoTenantBlockedError";
    this.code = code;
  }
}

const demoTenantBlockedMessages: Record<DemoTenantBlockedErrorCode, string> = {
  DEMO_SEND_BLOCKED: "Ambiente de demonstração: nenhum envio é feito",
  DEMO_ACTION_BLOCKED: "Ambiente de demonstração: esta ação não está disponível",
};

const demoTenantBlockedCodes: DemoTenantBlockedErrorCode[] = [
  "DEMO_SEND_BLOCKED",
  "DEMO_ACTION_BLOCKED",
];

/**
 * Recognizes a demo-tenant block from any shape it might arrive in:
 * - a `DemoTenantBlockedError` instance (same process),
 * - any Error/object exposing a matching `code`,
 * - any Error/string whose `message`/text contains one of the codes, which is
 *   how it looks once a server function error has been serialized to the
 *   client as plain text.
 */
export function isDemoBlockedError(e: unknown): e is DemoTenantBlockedError {
  if (e instanceof DemoTenantBlockedError) return true;
  if (!e) return false;

  if (typeof e === "string") {
    return demoTenantBlockedCodes.some((code) => e.includes(code));
  }

  if (typeof e === "object") {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && demoTenantBlockedCodes.includes(code as DemoTenantBlockedErrorCode)) {
      return true;
    }
    const message = (e as { message?: unknown }).message;
    if (typeof message === "string") {
      return demoTenantBlockedCodes.some((code) => message.includes(code));
    }
  }

  return false;
}

// UI copy (Global Constraints, verbatim).
export const DEMO_ENVIRONMENT_BANNER_TEXT =
  "Ambiente de demonstração — nenhuma mensagem é enviada e nada aqui é real";
export const DEMO_SEND_BLOCKED_TEXT = "Ambiente de demonstração: nenhum envio é feito";
export const DEMO_EMPTY_STATE_TEXT = "Nenhum dado neste ambiente de demonstração";
export const DEMO_AI_UNAVAILABLE_TEXT = "Indisponível no ambiente de demonstração";
