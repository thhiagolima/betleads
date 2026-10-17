// Task 12 — the committed Storage placeholders are valid, small and exactly
// what make-placeholders.mjs generates (deterministic).
import { describe, expect, it } from "vitest";

import { PLACEHOLDER_SECONDS, neutralPng, silentMp3 } from "./make-placeholders.mjs";
import { readPlaceholders } from "./storage.mjs";

describe("placeholders", () => {
  const { audio, image, audioSeconds } = readPlaceholders();

  it("silence.mp3 is a short run of valid MPEG-2 Layer III frames", () => {
    expect(audio.equals(silentMp3())).toBe(true);
    expect(audio.length).toBeGreaterThan(1000);
    expect(audio.length).toBeLessThan(20_000);
    expect(audioSeconds).toBe(PLACEHOLDER_SECONDS);
    // Every 104-byte frame starts with the sync word + MPEG-2 L3 32 kbps 22.05 kHz mono header.
    for (let offset = 0; offset < audio.length; offset += 104)
      expect([...audio.subarray(offset, offset + 4)]).toEqual([0xff, 0xf3, 0x40, 0xc0]);
  });

  it("neutral.png is a valid small PNG", () => {
    expect(image.equals(neutralPng())).toBe(true);
    expect([...image.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(image.subarray(12, 16).toString("ascii")).toBe("IHDR");
    expect(image.readUInt32BE(16)).toBe(240);
    expect(image.readUInt32BE(20)).toBe(120);
    expect(image.subarray(image.length - 8, image.length - 4).toString("ascii")).toBe("IEND");
  });
});
