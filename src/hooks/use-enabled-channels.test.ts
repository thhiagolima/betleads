import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tenants.functions", () => ({ getTenantSwitcher: vi.fn() }));

import { enabledChannelsIn, isChannelEnabledIn } from "./use-enabled-channels";
import type { ProviderChannel } from "@/lib/tenant-channels.shared";

const HOUSE = "00000000-0000-4000-8000-00000000a0a0";
const OTHER = "00000000-0000-4000-8000-00000000b0b0";

const switcher = (enabled: ProviderChannel[]) => ({
  activeTenantId: HOUSE,
  tenants: [
    { id: HOUSE, enabled_channels: enabled },
    { id: OTHER, enabled_channels: ["sms"] as ProviderChannel[] },
  ],
});

describe("enabledChannelsIn", () => {
  it("is undefined while loading, regardless of data", () => {
    expect(enabledChannelsIn(switcher(["sms"]), true)).toBeUndefined();
    expect(enabledChannelsIn(undefined, true)).toBeUndefined();
  });

  it("is undefined with no data yet (not loading, but nothing fetched)", () => {
    expect(enabledChannelsIn(undefined, false)).toBeUndefined();
  });

  it("follows the active tenant's enabled_channels once loaded", () => {
    expect(enabledChannelsIn(switcher(["sms", "email"]), false)).toEqual(["sms", "email"]);
  });

  it("is undefined if the active tenant is unknown (e.g. no house yet)", () => {
    expect(enabledChannelsIn({ activeTenantId: null, tenants: [] }, false)).toBeUndefined();
  });
});

describe("isChannelEnabledIn", () => {
  it("falls back to DEFAULT_ENABLED_CHANNELS when enabled is undefined (still loading)", () => {
    expect(isChannelEnabledIn(undefined, "sms")).toBe(true);
    expect(isChannelEnabledIn(undefined, "email")).toBe(true);
    expect(isChannelEnabledIn(undefined, "voice")).toBe(true);
    expect(isChannelEnabledIn(undefined, "webpush")).toBe(false);
  });

  it("checks membership in the real list once known", () => {
    expect(isChannelEnabledIn(["sms", "email"], "sms")).toBe(true);
    expect(isChannelEnabledIn(["sms", "email"], "voice")).toBe(false);
    expect(isChannelEnabledIn([], "sms")).toBe(false);
  });
});
