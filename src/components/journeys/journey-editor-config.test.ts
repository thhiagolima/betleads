import { describe, expect, it } from "vitest";

import {
  emailStepFromConfig,
  emailStepIdsForConfig,
  fromBrtInput,
  journeyAudienceDescription,
  journeyExitReasonLabel,
  journeyInProgress,
  journeyStatusLabel,
  smsExtra,
  smsExtraForTemplateChange,
  splitWaitSeconds,
  toBrtInput,
  waitToSeconds,
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

describe("extra after an SMS template change", () => {
  it("keeps short_domain_id and track_links, but drops the old template's variants", () => {
    expect(
      smsExtraForTemplateChange({
        short_domain_id: "d1",
        track_links: true,
        variants: ["a", "b"],
        sender: "old-sender",
      }),
    ).toEqual({ short_domain_id: "d1", track_links: true });
  });

  it("is empty when there was no extra to carry over", () => {
    expect(smsExtraForTemplateChange(undefined)).toEqual({});
    expect(smsExtraForTemplateChange({})).toEqual({});
  });

  it("carries over only whichever of the two keys is present", () => {
    expect(smsExtraForTemplateChange({ variants: ["a"] })).toEqual({});
    expect(smsExtraForTemplateChange({ short_domain_id: null })).toEqual({ short_domain_id: null });
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

describe("wait step units", () => {
  it("shows a saved delay in the largest exact unit", () => {
    expect(splitWaitSeconds(3600)).toEqual({ amount: "1", unit: "hours" });
    expect(splitWaitSeconds(86400 * 3)).toEqual({ amount: "3", unit: "days" });
    expect(splitWaitSeconds(5400)).toEqual({ amount: "90", unit: "minutes" });
    expect(splitWaitSeconds(60)).toEqual({ amount: "1", unit: "minutes" });
    expect(splitWaitSeconds(90000)).toEqual({ amount: "25", unit: "hours" });
  });

  it("shows odd second values in minutes instead of rounding them away", () => {
    expect(splitWaitSeconds(90)).toEqual({ amount: "1.5", unit: "minutes" });
    expect(splitWaitSeconds(0)).toEqual({ amount: "0", unit: "minutes" });
  });

  it("converts amount + unit back to seconds", () => {
    expect(waitToSeconds("1", "hours")).toBe(3600);
    expect(waitToSeconds("2", "days")).toBe(172800);
    expect(waitToSeconds("30", "minutes")).toBe(1800);
    expect(waitToSeconds("1,5", "hours")).toBe(5400);
  });

  it("rejects empty, zero and invalid amounts", () => {
    expect(waitToSeconds("", "hours")).toBeNull();
    expect(waitToSeconds("0", "days")).toBeNull();
    expect(waitToSeconds("-1", "minutes")).toBeNull();
    expect(waitToSeconds("abc", "minutes")).toBeNull();
  });

  it("round-trips the saved value", () => {
    for (const seconds of [60, 1800, 3600, 7200, 86400, 604800, 5400]) {
      const { amount, unit } = splitWaitSeconds(seconds);
      expect(waitToSeconds(amount, unit)).toBe(seconds);
    }
  });
});

describe("journey labels", () => {
  it("names the status with the same words as the actions", () => {
    expect(journeyStatusLabel("active")).toBe("Ativa");
    expect(journeyStatusLabel("paused")).toBe("Pausada");
    expect(journeyStatusLabel("draft")).toBe("Rascunho");
  });

  it("counts players inside the journey the same way everywhere", () => {
    expect(journeyInProgress({ active: 2, waiting: 3, paused_by_priority: 1, completed: 9 })).toBe(
      6,
    );
    expect(journeyInProgress(undefined)).toBe(0);
  });

  it("translates exit reasons and keeps failure messages as written", () => {
    expect(journeyExitReasonLabel("deposit")).toBe("Depositou");
    expect(journeyExitReasonLabel("journey_paused_closed")).toBe("Encerrada ao pausar a jornada");
    expect(journeyExitReasonLabel("Short Brasil: saldo insuficiente")).toBe(
      "Short Brasil: saldo insuficiente",
    );
    expect(journeyExitReasonLabel(null)).toBeNull();
  });

  it("describes the chosen audience", () => {
    expect(journeyAudienceDescription("vip")).toContain("VIP");
    expect(journeyAudienceDescription("all_active")).toContain("ativo");
    expect(journeyAudienceDescription("system:all-leads")).toContain("ativo ou não");
  });
});
