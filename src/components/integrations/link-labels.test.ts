import { describe, expect, it } from "vitest";

import { linkChannelLabel, linkOriginLabel, linkSourceLabel } from "./link-labels";

describe("link labels", () => {
  it("translates the known channels", () => {
    expect(linkChannelLabel("sms")).toBe("SMS");
    expect(linkChannelLabel("email")).toBe("E-mail");
    expect(linkChannelLabel("SMS")).toBe("SMS");
  });

  it("translates the known sources", () => {
    expect(linkSourceLabel("campaign")).toBe("Campanha");
    expect(linkSourceLabel("journey")).toBe("Automação");
    expect(linkSourceLabel("manual")).toBe("Envio manual");
  });

  it("never shows a raw or empty value", () => {
    expect(linkSourceLabel("bulk_send")).toBe("Bulk send");
    expect(linkChannelLabel("")).toBe("Não informado");
    expect(linkSourceLabel(null)).toBe("Não informado");
  });

  it("joins channel and source", () => {
    expect(linkOriginLabel("sms", "journey")).toBe("SMS · Automação");
  });
});
