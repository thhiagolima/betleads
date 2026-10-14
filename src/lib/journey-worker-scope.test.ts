import { describe, expect, it } from "vitest";
import { resolveJourneyWorkerScope } from "./journey-worker-scope";

describe("journey worker canary scope", () => {
  it("fails closed without an allowlist", () => {
    expect(resolveJourneyWorkerScope({} as NodeJS.ProcessEnv)).toEqual({
      tenantIds: [],
      journeyIds: [],
      allowAll: false,
      allowed: false,
    });
  });

  it("accepts valid tenant and journey UUIDs only", () => {
    expect(
      resolveJourneyWorkerScope({
        JOURNEYS_CANARY_TENANT_IDS:
          "03b73a96-aef7-414d-94fc-93a996f8256b,invalid,03b73a96-aef7-414d-94fc-93a996f8256b",
        JOURNEYS_CANARY_JOURNEY_IDS: "ff35a0fa-5e9f-4b47-b7e6-7263792523f5",
      } as NodeJS.ProcessEnv),
    ).toEqual({
      tenantIds: ["03b73a96-aef7-414d-94fc-93a996f8256b"],
      journeyIds: ["ff35a0fa-5e9f-4b47-b7e6-7263792523f5"],
      allowAll: false,
      allowed: true,
    });
  });

  it("requires an exact lowercase true for global release", () => {
    expect(
      resolveJourneyWorkerScope({ JOURNEYS_ALLOW_ALL_TENANTS: "TRUE" } as NodeJS.ProcessEnv)
        .allowed,
    ).toBe(false);
    expect(
      resolveJourneyWorkerScope({ JOURNEYS_ALLOW_ALL_TENANTS: "true" } as NodeJS.ProcessEnv),
    ).toMatchObject({ allowAll: true, allowed: true });
  });
});
