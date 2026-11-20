// API de leitura: feature flag (spec 2026-11-20 §4). Off (default) => every
// /api/v1 route returns 404 and the keys section of /mcp is hidden. Only the
// literal string "true" turns it on.
export function isApiEnabled(): boolean {
  return (process.env.API_ENABLED ?? "").trim().toLowerCase() === "true";
}
