export type ConversionObjective = "acquisition" | "conversion" | "reactivation" | "journey";

const stepsByObjective: Record<ConversionObjective, string[]> = {
  acquisition: ["sent", "delivered", "clicked", "registered", "first_deposit_approved"],
  conversion: ["sent", "delivered", "clicked", "registered", "deposit_approved"],
  reactivation: ["sent", "delivered", "clicked", "login_or_game", "deposit_approved"],
  journey: ["entry", "step_sent", "clicked", "conversion_event", "deposit_approved"],
};

export function conversionFunnelPreset(objective: ConversionObjective) {
  return stepsByObjective[objective].map((id) => ({ id, enabled: true }));
}

export function normalizeEnabledFunnelSteps(
  objective: ConversionObjective,
  requested?: string[] | null,
) {
  if (!requested) return [...stepsByObjective[objective]];
  const allowed = new Set(stepsByObjective[objective]);
  const enabled = requested.filter(
    (step, index) => allowed.has(step) && requested.indexOf(step) === index,
  );
  // The first and business-result stages are mandatory. This keeps customisation
  // safe for non-technical operators and the resulting funnel comparable.
  const first = stepsByObjective[objective][0];
  const last = stepsByObjective[objective].at(-1)!;
  return stepsByObjective[objective].filter(
    (step) => step === first || step === last || enabled.includes(step),
  );
}

export function conversionFunnelSnapshot(
  objective: ConversionObjective,
  sourceType: "campaign" | "journey",
  enabledSteps = stepsByObjective[objective],
) {
  const normalizedSteps = normalizeEnabledFunnelSteps(objective, enabledSteps);
  return {
    version: 1,
    objective,
    source_type: sourceType,
    attribution: {
      model: "last_tracked_click",
      classification: "direct",
      window_days: 7,
      timezone: "America/Sao_Paulo",
    },
    steps: stepsByObjective[objective].map((step) => ({
      id: step,
      enabled: normalizedSteps.includes(step),
    })),
  };
}
