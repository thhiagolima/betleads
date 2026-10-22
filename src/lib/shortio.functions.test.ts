// shortio.functions: the links-settings upsert payload must never touch the
// legacy shortio_settings.domain column (now managed via tenant_domains), and
// the links overview turns the RPC rows into numbers.
import { describe, expect, it } from "vitest";
import { buildShortioSettingsUpsert, overviewFromRows } from "./shortio.functions";

const base = {
  enabled: true,
  attribution_mode: "individual" as const,
  fallback_mode: "passthrough" as const,
  default_ttl_days: null,
  allowed_destination_hosts: ["https://Casa.bet.br/promo", ".casa.bet.br", "casa.bet.br"],
  enabled_channels: ["sms", "email"] as ("sms" | "email")[],
};

describe("buildShortioSettingsUpsert", () => {
  it("never includes the domain column, even when a client still sends it", () => {
    const withDomain = buildShortioSettingsUpsert({ ...base, domain: null }, "t1", "u1");
    const withValue = buildShortioSettingsUpsert({ ...base, domain: "go.casa.bet.br" }, "t1", "u1");
    const without = buildShortioSettingsUpsert(base, "t1", "u1");
    for (const payload of [withDomain, withValue, without]) {
      expect(payload).not.toHaveProperty("domain");
    }
  });

  it("normalizes and dedupes destination hosts and stamps tenant/user", () => {
    const payload = buildShortioSettingsUpsert(base, "t1", "u1", new Date("2026-10-21T00:00:00Z"));
    expect(payload.allowed_destination_hosts).toEqual(["casa.bet.br"]);
    expect(payload.tenant_id).toBe("t1");
    expect(payload.updated_by).toBe("u1");
    expect(payload.updated_at).toBe("2026-10-21T00:00:00.000Z");
  });
});

describe("overviewFromRows", () => {
  it("turns the RPC bigints into numbers and sums the totals", () => {
    const out = overviewFromRows([
      { channel: "sms", source_type: "campaign", sent: "90958", links: "90958", clicks: "2836" },
      { channel: "sms", source_type: "journey", sent: "67493", links: "67493", clicks: "1429" },
    ]);
    expect(out.sent).toBe(158451);
    expect(out.clicks).toBe(4265);
    expect(out.rows[0]).toMatchObject({ sourceType: "campaign", sent: 90958, links: 90958 });
    expect(out.rows[0].ctr).toBeCloseTo(2836 / 90958);
  });

  it("handles no dispatches", () => {
    expect(overviewFromRows([])).toEqual({ rows: [], sent: 0, clicks: 0 });
  });
});
