export type ConversionObjective = "acquisition" | "conversion" | "reactivation" | "journey";

const stepsByObjective: Record<ConversionObjective, string[]> = {
  acquisition: ["sent", "delivered", "clicked", "registered", "first_deposit_approved"],
  conversion: ["sent", "delivered", "clicked", "registered", "deposit_approved"],
  reactivation: ["sent", "delivered", "clicked", "login_or_game", "deposit_approved"],
  journey: ["entry", "step_sent", "clicked", "conversion_event", "deposit_approved"],
};

export function conversionFunnelSnapshot(
  objective: ConversionObjective,
  sourceType: "campaign" | "journey",
) {
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
    steps: stepsByObjective[objective],
  };
}
