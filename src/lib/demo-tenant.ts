// Demo tenant errors and UI copy. No server-only import here: the UI imports
// this module directly (banners, empty states, blocked-send toasts), while
// `tenant-access.server.ts` throws these same errors from the guards.

export type DemoTenantBlockedErrorCode = "DEMO_SEND_BLOCKED" | "DEMO_ACTION_BLOCKED";

// UI copy (Global Constraints, verbatim).
export const DEMO_ENVIRONMENT_BANNER_TEXT =
  "Ambiente de demonstração — nenhuma mensagem é enviada e nada aqui é real";
export const DEMO_SEND_BLOCKED_TEXT = "Ambiente de demonstração: nenhum envio é feito";
export const DEMO_EMPTY_STATE_TEXT = "Nenhum dado neste ambiente de demonstração";
export const DEMO_AI_UNAVAILABLE_TEXT = "Indisponível no ambiente de demonstração";
export const DEMO_ACTION_BLOCKED_TEXT = "Ambiente de demonstração: esta ação não está disponível";

const demoTenantBlockedMessages: Record<DemoTenantBlockedErrorCode, string> = {
  DEMO_SEND_BLOCKED: DEMO_SEND_BLOCKED_TEXT,
  DEMO_ACTION_BLOCKED: DEMO_ACTION_BLOCKED_TEXT,
};

/**
 * Thrown by the server guards whenever a demo tenant, or an unknown/missing
 * tenant (fail-closed), attempts something that would reach a real provider
 * or mutate team/integration/config state.
 *
 * `message` is the clean, user-facing copy with NO code prefix (R13): many
 * call sites toast `error.message` directly, and server code builds
 * result-object `error`/`reason` fields from it too (e.g.
 * `demoSendBlockedReason`), so keeping it clean here means every one of
 * those surfaces shows the right copy exactly once, with no code leaking
 * through. The code itself lives in `code`, and is still recoverable from a
 * serialized message because `isDemoBlockedError` also recognizes the raw
 * code substring (see below) for the few server-internal places that embed
 * the bare code rather than the message.
 */
export class DemoTenantBlockedError extends Error {
  code: DemoTenantBlockedErrorCode;

  constructor(code: DemoTenantBlockedErrorCode) {
    super(demoTenantBlockedMessages[code]);
    this.name = "DemoTenantBlockedError";
    this.code = code;
  }
}

const demoTenantBlockedCodes: DemoTenantBlockedErrorCode[] = [
  "DEMO_SEND_BLOCKED",
  "DEMO_ACTION_BLOCKED",
];
const demoTenantBlockedCopies = [DEMO_SEND_BLOCKED_TEXT, DEMO_ACTION_BLOCKED_TEXT];

/**
 * Recognizes a demo-tenant block from any shape it might arrive in:
 * - a `DemoTenantBlockedError` instance (same process),
 * - any Error/object exposing a matching `code`,
 * - any Error/string whose `message`/text contains one of the raw codes
 *   (kept for server-internal result objects that still carry the bare
 *   code, and for a server function error serialized to the client as
 *   plain text before this fix shipped),
 * - any Error/string whose `message`/text, trimmed, is exactly one of the
 *   two clean copy strings (the normal case post-R13).
 */
export function isDemoBlockedError(e: unknown): e is DemoTenantBlockedError {
  if (e instanceof DemoTenantBlockedError) return true;
  if (!e) return false;

  if (typeof e === "string") {
    return matchesBlockedText(e);
  }

  if (typeof e === "object") {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && demoTenantBlockedCodes.includes(code as DemoTenantBlockedErrorCode)) {
      return true;
    }
    const message = (e as { message?: unknown }).message;
    if (typeof message === "string") {
      return matchesBlockedText(message);
    }
  }

  return false;
}

function matchesBlockedText(text: string): boolean {
  const trimmed = text.trim();
  return (
    demoTenantBlockedCodes.some((code) => text.includes(code)) ||
    demoTenantBlockedCopies.includes(trimmed)
  );
}

/**
 * Maps a blocked-error (in any shape `isDemoBlockedError` recognizes) to the
 * UI copy to toast: the send copy for `DEMO_SEND_BLOCKED`, the action copy
 * for `DEMO_ACTION_BLOCKED`/anything else recognized. Checks `.code` first
 * (the reliable signal, same-process or a plain `{code}` result object),
 * then falls back to the message text (serialized/string form). Pure
 * function so the global error handler's mapping is unit-testable without
 * mounting React.
 */
export function demoBlockedErrorText(e: unknown): string {
  const code = e && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
  if (code === "DEMO_SEND_BLOCKED") return DEMO_SEND_BLOCKED_TEXT;
  if (code === "DEMO_ACTION_BLOCKED") return DEMO_ACTION_BLOCKED_TEXT;

  const text = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return text.includes("DEMO_SEND_BLOCKED") || text.trim() === DEMO_SEND_BLOCKED_TEXT
    ? DEMO_SEND_BLOCKED_TEXT
    : DEMO_ACTION_BLOCKED_TEXT;
}
