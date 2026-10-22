// Shared react-query key for `getHouseConfig`, used by every house-config
// section so one save/mutation invalidates and refetches them all together.
export const HOUSE_CONFIG_QUERY_KEY = ["house-config"];

// Shared react-query key for `getHouseSetupStatus`, used by the onboarding
// gate, the home checklist, the verified-domain notice and the setup wizard
// so one action (complete/skip/mark-seen/any domain change) invalidates the
// same cache entry everywhere it's read.
export const HOUSE_SETUP_STATUS_QUERY_KEY = ["house-setup-status"];

// Shared react-query key for `getComposerOptions`, used by every composer
// (campaign composer SMS/e-mail, journey editor SMS/e-mail steps, the legacy
// e-mail campaign editor) so a house-config mutation invalidated alongside
// `HOUSE_CONFIG_QUERY_KEY` also refreshes the pickers' default domain/sender.
export const COMPOSER_OPTIONS_QUERY_KEY = ["composer-options"];

/** Every query a house-config change can affect: the config itself, the
 * composers' pickers and the setup status (wizard "Pronto" summary, home
 * checklist, verified notice). Each section's refresh invalidates all three. */
export const HOUSE_CONFIG_RELATED_QUERY_KEYS = [
  HOUSE_CONFIG_QUERY_KEY,
  COMPOSER_OPTIONS_QUERY_KEY,
  HOUSE_SETUP_STATUS_QUERY_KEY,
] as const;

export function invalidateHouseConfigQueries(qc: {
  invalidateQueries: (filters: { queryKey: readonly unknown[] }) => unknown;
}): void {
  for (const queryKey of HOUSE_CONFIG_RELATED_QUERY_KEYS) {
    void qc.invalidateQueries({ queryKey });
  }
}
