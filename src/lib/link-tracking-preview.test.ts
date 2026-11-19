import { describe, expect, it } from "vitest";
import { estimateSms, messageUrls, previewTrackedText, smsHasLink } from "./link-tracking-preview";

describe("SMS tracking preview", () => {
  it("uses GSM-7 concatenation and extension characters", () => {
    expect(estimateSms("a".repeat(161))).toMatchObject({ encoding: "GSM-7", parts: 2 });
    expect(estimateSms("^".repeat(80))).toMatchObject({ units: 160, parts: 1 });
  });
  it("uses UCS-2 and replaces every URL", () => {
    expect(estimateSms("😀".repeat(71))).toMatchObject({ encoding: "UCS-2", parts: 2 });
    expect(previewTrackedText("https://a.example/x https://b.example/y", true)).toBe("https://bmkt.click/abc123 https://bmkt.click/abc123");
  });
  it("previews and reports compact www links as HTTPS destinations", () => {
    expect(messageUrls("Acesse www.sortealta.io agora")).toEqual([
      "https://www.sortealta.io",
    ]);
    expect(previewTrackedText("Acesse www.sortealta.io agora", true)).toBe(
      "Acesse https://bmkt.click/abc123 agora",
    );
  });
  it("previews the link with the chosen shortener domain", () => {
    expect(
      previewTrackedText("Jogue https://bravabet365.com/?utm_source=sms", true, "betgreen.online"),
    ).toBe("Jogue https://betgreen.online/abc123");
  });
});

describe("smsHasLink", () => {
  it("accepts written URLs and link variables", () => {
    expect(smsHasLink("Jogue https://bravabet365.com")).toBe(true);
    expect(smsHasLink("Acesse www.sortealta.io")).toBe(true);
    expect(smsHasLink("Deposite agora {link_deposito}")).toBe(true);
    expect(smsHasLink("Volte {link}")).toBe(true);
  });
  it("flags text with no link and ignores empty text", () => {
    expect(smsHasLink("Oi {primeiro_nome}, seu bônus te espera!")).toBe(false);
    expect(smsHasLink("   ")).toBe(true);
  });
});
