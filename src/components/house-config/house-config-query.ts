// Shared react-query key for `getHouseConfig`, used by every house-config
// section so one save/mutation invalidates and refetches them all together.
export const HOUSE_CONFIG_QUERY_KEY = ["house-config"];

// Shared react-query key for `getHouseSetupStatus`, used by the onboarding
// gate, the home checklist, the verified-domain notice and the setup wizard
// so one action (complete/skip/mark-seen/any domain change) invalidates the
// same cache entry everywhere it's read.
export const HOUSE_SETUP_STATUS_QUERY_KEY = ["house-setup-status"];
