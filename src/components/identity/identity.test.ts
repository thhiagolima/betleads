import { describe, expect, it } from "vitest";

import { CHANNEL_IDENTITY, channelKind, EVENT_IDENTITY, LEVEL_IDENTITY } from "./identity";

describe("identity colours", () => {
  it("gives every level and every channel its own colour", () => {
    const levels = Object.values(LEVEL_IDENTITY).map((tone) => tone.text);
    expect(new Set(levels).size).toBe(levels.length);
    const channels = Object.values(CHANNEL_IDENTITY).map((tone) => tone.text);
    expect(new Set(channels).size).toBe(channels.length);
  });

  it("keeps deposit and bonus events in the audience group colours", () => {
    expect(EVENT_IDENTITY.deposit.dot).toBe("bg-emerald-400");
    expect(EVENT_IDENTITY.bonus.dot).toBe("bg-violet-400");
  });

  it("maps the channel names used around the app", () => {
    expect(channelKind("SMS")).toBe("sms");
    expect(channelKind("e-mail")).toBe("email");
    expect(channelKind("calls")).toBe("voice");
    expect(channelKind("voz")).toBe("voice");
    expect(channelKind("whatsapp")).toBe("whatsapp");
    expect(channelKind("fax")).toBeNull();
  });
});
