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
      steps: [
        { id: "sent", enabled: true },
        { id: "delivered", enabled: true },
        { id: "clicked", enabled: true },
        { id: "registered", enabled: true },
        { id: "deposit_approved", enabled: true },
      ],
    });
  });

  it("uses entry and per-step sends for journeys", () => {
    expect(conversionFunnelSnapshot("journey", "journey").steps.map((step) => step.id)).toEqual([
      "entry",
      "step_sent",
      "clicked",
      "conversion_event",
      "deposit_approved",
    ]);
  });

  it("keeps boundary stages enabled when optional stages are hidden", () => {
    expect(conversionFunnelSnapshot("conversion", "campaign", ["clicked"]).steps).toEqual([
      { id: "sent", enabled: true },
      { id: "delivered", enabled: false },
      { id: "clicked", enabled: true },
      { id: "registered", enabled: false },
      { id: "deposit_approved", enabled: true },
    ]);
  });
});
