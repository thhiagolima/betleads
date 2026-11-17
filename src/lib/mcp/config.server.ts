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

// MCP do grupo, área de operação (docs/superpowers/specs/2026-11-17-mcp-grupo-design.md).
/** Most houses one operação call may cover; above it the caller must narrow to a group. */
export const MAX_OPS_TENANTS = 60;
/** Houses queried at the same time by one operação call. */
export const OPS_CONCURRENCY = 6;
/** Default and maximum size of the lists returned by operação tools. */
export const OPS_LIST_DEFAULT = 20;
export const OPS_LIST_MAX = 100;
/** mcp_call_log.args keeps at most this many characters of the call's JSON arguments. */
export const LOG_ARGS_MAX_CHARS = 4096;
