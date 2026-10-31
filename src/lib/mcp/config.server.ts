// MCP financeiro: feature flag and shared limits (docs/superpowers/sdd/2026-10-30-mcp-financeiro/global-constraints.md).
// MCP_ENABLED off (default) => every MCP/OAuth/well-known route returns 404
// and the UI hides the feature. Only the literal string "true" turns it on.

/** Feature flag: MCP_ENABLED must be exactly "true" (trim + lowercase) to turn the feature on. */
export function isMcpEnabled(): boolean {
  return (process.env.MCP_ENABLED ?? "").trim().toLowerCase() === "true";
}

/** Access token lifetime, in seconds. */
export const ACCESS_TOKEN_TTL_S = 3600;
/** Refresh token lifetime, in seconds (30 days). */
export const REFRESH_TOKEN_TTL_S = 2_592_000;
/** OAuth authorization code lifetime, in seconds. */
export const AUTH_CODE_TTL_S = 600;
/** Write preview code lifetime, in seconds; single use. */
export const PREVIEW_TTL_S = 600;
/** Maximum number of day entries accepted in a single call. */
export const MAX_DAY_ENTRIES = 31;
/** Rate limit: calls per minute, per connection. */
export const CALLS_PER_MINUTE = 60;
/** Rate limit: write confirmations per hour, per user. */
export const CONFIRMS_PER_HOUR = 30;
