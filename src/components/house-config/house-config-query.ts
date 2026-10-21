// Shared react-query key for `getHouseConfig`, used by every house-config
// section so one save/mutation invalidates and refetches them all together.
export const HOUSE_CONFIG_QUERY_KEY = ["house-config"];
