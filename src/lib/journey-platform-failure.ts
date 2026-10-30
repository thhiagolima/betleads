/**
 * Journey send failures caused by the PLATFORM, not by the player: a house
 * without a Short.io domain, Short.io down, a send log the database refused,
 * a deploy ahead of its migration, missing provider credentials. They happen
 * before anything reaches the provider, so retrying never resends a message.
 *
 * The dispatcher holds these items on the same step instead of spending
 * max_attempts and failing the enrollment for good: on 22-23/10/2026 a missing
 * SHORTIO_DOMAIN ended 19,056 enrollments in minutes, and on 28/10/2026 a
 * missing column ended 292 more. Messages are matched because the errors are
 * plain `Error`s thrown by the link, log and account layers.
 */

export type PlatformFailureReason =
  | "provider_misconfigured"
  | "shortio_not_configured"
  | "shortio_unavailable"
  | "send_log_unavailable"
  | "schema_mismatch";

/** A held step comes back after this, so a fix or deploy resumes it. */
export const PLATFORM_HOLD_MS = 30 * 60_000;

/**
 * Holds per step before the normal attempts policy takes over (3 days at
 * PLATFORM_HOLD_MS): a misread player-specific error can never loop forever.
 */
export const MAX_PLATFORM_HOLDS = 144;

const PATTERNS: Array<[RegExp, PlatformFailureReason]> = [
  [/SHORTIO_DOMAIN não configurado/i, "shortio_not_configured"],
  [/Falha ao criar link Short\.io/i, "shortio_unavailable"],
  [/Falha ao registrar envio SMS/i, "send_log_unavailable"],
  [
    /schema cache|Could not find the '[^']+' column|(column|relation|function) "?[\w.]+"? does not exist/i,
    "schema_mismatch",
  ],
];

/** The platform reason behind a `fail` decision, or null when it may be the player's. */
export function journeyPlatformFailure(
  error: unknown,
  decisionReason: string,
): PlatformFailureReason | null {
  if (decisionReason === "provider_misconfigured") return "provider_misconfigured";
  const message = error instanceof Error ? error.message : String(error ?? "");
  for (const [pattern, reason] of PATTERNS) if (pattern.test(message)) return reason;
  return null;
}
