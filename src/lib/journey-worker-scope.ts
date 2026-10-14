const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uuidList(value: string | undefined) {
  if (!value?.trim()) return [];
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => UUID.test(item)),
    ),
  ];
}

export function resolveJourneyWorkerScope(env: NodeJS.ProcessEnv = process.env) {
  const tenantIds = uuidList(env.JOURNEYS_CANARY_TENANT_IDS);
  const journeyIds = uuidList(env.JOURNEYS_CANARY_JOURNEY_IDS);
  const allowAll = env.JOURNEYS_ALLOW_ALL_TENANTS === "true";
  return {
    tenantIds,
    journeyIds,
    allowAll,
    allowed: allowAll || tenantIds.length > 0 || journeyIds.length > 0,
  };
}
