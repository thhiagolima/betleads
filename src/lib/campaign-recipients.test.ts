import { describe, expect, it } from "vitest";
import {
  buildUnresolvedRecipientsCsv,
  campaignBatchSize,
  campaignDeliveryKey,
  campaignTickQuota,
  countUnresolvedByReason,
  describeUnresolvedCounts,
  maskPhone,
  noRecipientResolvedMessage,
  parseUnresolvedRecipients,
  SMS_CAMPAIGN_TICK_SECONDS,
} from "./campaign-recipients";

describe("campaign per-tick budget (ENV-07)", () => {
  it("matches the real cron cadence: one run per minute delivers the whole rate", () => {
    expect(SMS_CAMPAIGN_TICK_SECONDS).toBe(60);
    expect(campaignTickQuota(1000)).toBe(1000);
    expect(campaignTickQuota(300)).toBe(300);
    expect(campaignTickQuota(5000)).toBe(5000);
    // The old formula (12 rounds/min assumed, 1 actual) delivered ceil(1000/12).
    expect(Math.ceil(1000 / 12)).toBe(84);
  });

  it("scales with the tick length and stays within [1, 5000]", () => {
    expect(campaignTickQuota(1000, 30)).toBe(500);
    expect(campaignTickQuota(1, 60)).toBe(1);
    expect(campaignTickQuota(10, 5)).toBe(1);
    expect(campaignTickQuota(50_000)).toBe(5000);
    expect(campaignTickQuota(null)).toBe(1000);
    expect(campaignTickQuota(0)).toBe(1000);
  });

  it("checkpoints the cursor in bounded batches", () => {
    expect(campaignBatchSize(25, 1000)).toBe(100);
    expect(campaignBatchSize(80, 5000)).toBe(250);
    expect(campaignBatchSize(25, 7)).toBe(7);
    expect(campaignBatchSize(5, 0)).toBe(1);
  });
});

describe("campaign delivery key", () => {
  it("is deterministic per (campaign, player) and UUID-shaped", async () => {
    const a = await campaignDeliveryKey("c1", "p1");
    expect(a).toBe(await campaignDeliveryKey("c1", "p1"));
    expect(a).not.toBe(await campaignDeliveryKey("c1", "p2"));
    expect(a).not.toBe(await campaignDeliveryKey("c2", "p1"));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("unresolved recipients presentation", () => {
  const rows = [
    { phone: "+5511999990001", reason: "sem_cadastro" as const },
    { phone: "+5511999990002", reason: "sem_cadastro" as const },
    { phone: "123", reason: "telefone_invalido" as const },
  ];

  it("masks every digit but the last four in the UI", () => {
    expect(maskPhone("+55 11 99999-1234")).toBe("•••••••••1234");
    expect(maskPhone("123")).toBe("•••123");
    expect(maskPhone(null)).toBe("—");
  });

  it("counts and describes by reason", () => {
    const counts = countUnresolvedByReason(rows);
    expect(counts).toEqual({ sem_cadastro: 2, telefone_invalido: 1, sem_consentimento: 0 });
    expect(describeUnresolvedCounts(counts)).toBe("2 sem cadastro, 1 telefone inválido");
    expect(noRecipientResolvedMessage(rows)).toContain("(2 sem cadastro, 1 telefone inválido)");
  });

  it("exports the full phone in CSV and parses the stored JSON defensively", () => {
    const csv = buildUnresolvedRecipientsCsv(rows);
    expect(csv.split("\n")[0]).toBe("telefone,motivo,descricao");
    expect(csv).toContain('"+5511999990001","sem_cadastro","Sem cadastro"');
    expect(
      parseUnresolvedRecipients([...rows, { phone: 1, reason: "x" }, null, { reason: "sem_cadastro" }]),
    ).toEqual(rows);
    expect(parseUnresolvedRecipients({})).toEqual([]);
  });
});
