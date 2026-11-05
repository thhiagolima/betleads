// Shared TanStack Query key for the web push integration screen, so every
// mutation that changes server state (prompt, verify, activate, status,
// test send) can invalidate the same cache entry — mirrors
// HOUSE_CONFIG_QUERY_KEY in house-config-query.ts.
export const WEBPUSH_INTEGRATION_QUERY_KEY = ["webpush-integration"];
