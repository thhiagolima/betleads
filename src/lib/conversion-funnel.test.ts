import { describe, expect, it } from "vitest";
import { conversionFunnelSnapshot } from "./conversion-funnel";

describe("conversionFunnelSnapshot", () => {
  it("freezes the P0 last-click attribution contract", () => {
    expect(conversionFunnelSnapshot("conversion", "campaign")).toMatchObject({
      version: 1,
      objective: "conversion",
      source_type: "campaign",
      attribution: {
        model: "last_tracked_click",
        classification: "direct",
        window_days: 7,
        timezone: "America/Sao_Paulo",
      },
      steps: ["sent", "delivered", "clicked", "registered", "deposit_approved"],
    });
  });

  it("uses entry and per-step sends for journeys", () => {
    expect(conversionFunnelSnapshot("journey", "journey").steps).toEqual([
      "entry",
      "step_sent",
      "clicked",
      "conversion_event",
      "deposit_approved",
    ]);
  });
});
