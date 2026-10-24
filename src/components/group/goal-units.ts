// The ROI goal is stored as a fraction (0.3, like PeriodSummary.roi) but typed
// in % in the /grupo/metas editor ("30" for 30%). Every other metric is typed
// in its own unit.
import type { GoalMetric } from "@/lib/finance/types";

/** True when the metric's goal is typed as a percentage. */
export function isPercentGoal(metric: GoalMetric): boolean {
  return metric === "roi";
}

/** Stored daily value -> text for the input ("" when there is no goal). */
export function goalValueToInput(metric: GoalMetric, value: number | null): string {
  if (value === null) return "";
  return String(isPercentGoal(metric) ? Number((value * 100).toFixed(2)) : value);
}

/** Input text -> daily value to store (null removes the goal). */
export function goalInputToValue(metric: GoalMetric, input: string): number | null {
  if (input.trim() === "") return null;
  const value = Number(input);
  return isPercentGoal(metric) ? Number((value / 100).toFixed(4)) : value;
}
