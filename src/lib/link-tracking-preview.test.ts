import { describe, expect, it } from "vitest";
import { estimateSms, previewTrackedText } from "./link-tracking-preview";

describe("SMS tracking preview", () => {
  it("uses GSM-7 concatenation and extension characters", () => {
    expect(estimateSms("a".repeat(161))).toMatchObject({ encoding: "GSM-7", parts: 2 });
    expect(estimateSms("^".repeat(80))).toMatchObject({ units: 160, parts: 1 });
  });
  it("uses UCS-2 and replaces every URL", () => {
    expect(estimateSms("😀".repeat(71))).toMatchObject({ encoding: "UCS-2", parts: 2 });
    expect(previewTrackedText("https://a.example/x https://b.example/y", true)).toBe("bmkt.click/abc123 bmkt.click/abc123");
  });
});
