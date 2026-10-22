import { describe, expect, it } from "vitest";

import {
  emailStepFromConfig,
  emailStepIdsForConfig,
  fromBrtInput,
  smsExtra,
  toBrtInput,
} from "./journey-editor-config";

describe("journey editor config helpers", () => {
  it("keeps the SMS config keys the editor does not manage", () => {
    expect(
      smsExtra({
        content: "a",
        template_id: "t",
        template_snapshot: { id: "t" },
        track_links: true,
        variants: ["a", "b"],
      }),
    ).toEqual({ track_links: true, variants: ["a", "b"] });
  });

  it("keeps short_domain_id (set by the shortener picker) among the SMS extra keys", () => {
    expect(
      smsExtra({ content: "a", template_id: "t", short_domain_id: "d1", track_links: true }),
    ).toEqual({ short_domain_id: "d1", track_links: true });
  });

  it("round-trips the end date in Brasília time", () => {
    expect(toBrtInput("2026-10-20T02:30:00.000Z")).toBe("2026-10-19T23:30");
    expect(fromBrtInput("2026-10-19T23:30")).toBe("2026-10-20T02:30:00.000Z");
    expect(fromBrtInput(toBrtInput("2026-12-31T23:59:00.000Z"))).toBe("2026-12-31T23:59:00.000Z");
  });

  it("treats an empty or invalid date as no end date", () => {
    expect(toBrtInput(null)).toBe("");
    expect(toBrtInput("not a date")).toBe("");
    expect(fromBrtInput("")).toBeNull();
  });
});

describe("e-mail step sender/short-domain round-trip", () => {
  it("reads sender_id and short_domain_id from a saved step's config", () => {
    expect(
      emailStepFromConfig({ template_id: "t1", sender_id: "s1", short_domain_id: "d1" }),
    ).toEqual({ templateId: "t1", senderId: "s1", shortDomainId: "d1" });
  });

  it("reads 'padrão da casa' (null) when the fields are absent", () => {
    expect(emailStepFromConfig({ template_id: "t1" })).toEqual({
      templateId: "t1",
      senderId: null,
      shortDomainId: null,
    });
  });

  it("round-trips an explicit sender/domain back into the saved config", () => {
    const fields = emailStepFromConfig({
      template_id: "t1",
      sender_id: "s1",
      short_domain_id: "d1",
    });
    expect(emailStepIdsForConfig(fields)).toEqual({ sender_id: "s1", short_domain_id: "d1" });
  });

  it("omits sender_id (keeps the house default) when left on 'padrão da casa'", () => {
    expect(emailStepIdsForConfig({ senderId: null, shortDomainId: null })).toEqual({
      short_domain_id: null,
    });
  });
});
