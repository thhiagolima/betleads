import { describe, expect, it } from "vitest";

import {
  campaignRiskSignature,
  campaignSendLabel,
  requiresTypedConfirmation,
  typedCountMatches,
  type CampaignRiskInputs,
} from "./campaign-send-confirmation";

const base: CampaignRiskInputs = {
  channel: "sms",
  audienceId: "aud-1",
  recipients: 12430,
  sendableRecipients: 12430,
  cost: 12430,
  smsContent: "Olá {primeiro_nome}",
  smsTemplateId: "",
  emailTemplateId: "",
  voiceMode: "asset",
  voiceSourceId: "",
  when: "now",
  scheduledAt: "",
};

describe("campaign risk signature", () => {
  it("stays the same when nothing reviewed changed", () => {
    expect(campaignRiskSignature({ ...base })).toBe(campaignRiskSignature(base));
  });

  it.each<[string, Partial<CampaignRiskInputs>]>([
    ["channel", { channel: "email" }],
    ["audience", { audienceId: "aud-2" }],
    ["recipient count", { recipients: 12431 }],
    ["resolved recipients", { sendableRecipients: 12000 }],
    ["cost", { cost: 24860 }],
    ["SMS content", { smsContent: "Outra mensagem" }],
    ["SMS template", { smsTemplateId: "tpl-1" }],
    ["e-mail template", { emailTemplateId: "tpl-2" }],
    ["voice mode", { voiceMode: "script" }],
    ["voice source", { voiceSourceId: "asset-1" }],
    ["send moment", { when: "schedule" }],
  ])("changes when the %s changes", (_, change) => {
    expect(campaignRiskSignature({ ...base, ...change })).not.toBe(campaignRiskSignature(base));
  });

  it("changes with the schedule date only while scheduling", () => {
    const scheduled = { ...base, when: "schedule" as const, scheduledAt: "2026-10-20T10:00" };
    expect(campaignRiskSignature({ ...scheduled, scheduledAt: "2026-10-21T10:00" })).not.toBe(
      campaignRiskSignature(scheduled),
    );
    expect(campaignRiskSignature({ ...base, scheduledAt: "2026-10-21T10:00" })).toBe(
      campaignRiskSignature(base),
    );
  });
});

describe("typed confirmation", () => {
  it("is required only above 1.000 recipients", () => {
    expect(requiresTypedConfirmation(999)).toBe(false);
    expect(requiresTypedConfirmation(1000)).toBe(false);
    expect(requiresTypedConfirmation(1001)).toBe(true);
  });

  it("accepts the count with or without thousands separators", () => {
    expect(typedCountMatches("12430", 12430)).toBe(true);
    expect(typedCountMatches(" 12.430 ", 12430)).toBe(true);
    expect(typedCountMatches("12 430", 12430)).toBe(true);
  });

  it("rejects a different, empty or malformed number", () => {
    expect(typedCountMatches("12431", 12430)).toBe(false);
    expect(typedCountMatches("", 12430)).toBe(false);
    expect(typedCountMatches(null, 12430)).toBe(false);
    expect(typedCountMatches("12,430", 12430)).toBe(false);
    expect(typedCountMatches("sim", 12430)).toBe(false);
  });
});

describe("send button label", () => {
  it("states recipients and credits for SMS", () => {
    expect(campaignSendLabel({ channel: "sms", when: "now", recipients: 12430, cost: 12430 })).toBe(
      "Enviar para 12.430 jogadores · 12.430 créditos",
    );
    expect(campaignSendLabel({ channel: "sms", when: "schedule", recipients: 1, cost: 2 })).toBe(
      "Agendar para 1 jogador · 2 créditos",
    );
  });

  it("states calls for voice and only recipients for e-mail", () => {
    expect(campaignSendLabel({ channel: "voice", when: "now", recipients: 150, cost: 150 })).toBe(
      "Enviar para 150 jogadores · 150 chamadas",
    );
    expect(campaignSendLabel({ channel: "email", when: "now", recipients: 1200, cost: 1200 })).toBe(
      "Enviar para 1.200 jogadores",
    );
  });
});
