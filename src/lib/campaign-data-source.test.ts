import { describe, expect, it, vi } from "vitest";

// Server function modules: stubs named after the function, so the test can
// tell which side each slot points to without loading server code.
const { stub } = vi.hoisted(() => ({
  stub: (name: string) => Object.assign(() => Promise.resolve(name), { fnName: name }),
}));

vi.mock("@/lib/campaign-drafts.functions", () => ({
  listCampaignDrafts: stub("listCampaignDrafts"),
  getCampaignDraft: stub("getCampaignDraft"),
  saveCampaignDraft: stub("saveCampaignDraft"),
  deleteCampaignDraft: stub("deleteCampaignDraft"),
  submitCampaignDraft: stub("submitCampaignDraft"),
}));
vi.mock("@/lib/sms-audience-crud.functions", () => ({
  listSmsAudiences: stub("listSmsAudiences"),
  saveSmsAudience: stub("saveSmsAudience"),
  deleteSmsAudience: stub("deleteSmsAudience"),
}));
vi.mock("@/lib/expert-campaigns.functions", () => ({
  listExpertAudiences: stub("listExpertAudiences"),
  saveExpertAudience: stub("saveExpertAudience"),
  deleteExpertAudience: stub("deleteExpertAudience"),
  listExpertCampaignDrafts: stub("listExpertCampaignDrafts"),
  getExpertCampaignDraft: stub("getExpertCampaignDraft"),
  saveExpertCampaignDraft: stub("saveExpertCampaignDraft"),
  deleteExpertCampaignDraft: stub("deleteExpertCampaignDraft"),
  submitExpertCampaignDraft: stub("submitExpertCampaignDraft"),
}));

import {
  EXPERT_CAMPAIGN_SOURCE,
  HOUSE_CAMPAIGN_SOURCE,
  campaignDataSourceFor,
  campaignSourceKind,
} from "./campaign-data-source";

const nameOf = (fn: unknown) => (fn as { fnName: string }).fnName;

describe("campaign data source", () => {
  it("picks the expert source only for the expert role", () => {
    expect(campaignSourceKind("expert")).toBe("expert");
    for (const role of ["admin", "gestor", "member", "super_admin", null, undefined] as const) {
      expect(campaignSourceKind(role)).toBe("house");
      expect(campaignDataSourceFor(role)).toBe(HOUSE_CAMPAIGN_SOURCE);
    }
    expect(campaignDataSourceFor("expert")).toBe(EXPERT_CAMPAIGN_SOURCE);
  });

  it("house source keeps the house functions and cache keys", () => {
    const house = HOUSE_CAMPAIGN_SOURCE;
    expect(house.queryKeys.audiences).toEqual(["sms-audiences"]);
    expect(house.queryKeys.drafts).toEqual(["campaign-drafts"]);
    expect(house.queryKeys.draft("d1")).toEqual(["campaign-draft", "d1"]);
    expect(nameOf(house.listAudiences)).toBe("listSmsAudiences");
    expect(nameOf(house.saveAudience)).toBe("saveSmsAudience");
    expect(nameOf(house.deleteAudience)).toBe("deleteSmsAudience");
    expect(nameOf(house.saveDraft)).toBe("saveCampaignDraft");
    expect(nameOf(house.submitDraft)).toBe("submitCampaignDraft");
  });

  it("expert source uses the expert functions and its own cache keys", () => {
    const expert = EXPERT_CAMPAIGN_SOURCE;
    expect(expert.queryKeys.audiences).not.toEqual(HOUSE_CAMPAIGN_SOURCE.queryKeys.audiences);
    expect(expert.queryKeys.drafts).not.toEqual(HOUSE_CAMPAIGN_SOURCE.queryKeys.drafts);
    expect(nameOf(expert.listAudiences)).toBe("listExpertAudiences");
    expect(nameOf(expert.saveAudience)).toBe("saveExpertAudience");
    expect(nameOf(expert.deleteAudience)).toBe("deleteExpertAudience");
    expect(nameOf(expert.listDrafts)).toBe("listExpertCampaignDrafts");
    expect(nameOf(expert.getDraft)).toBe("getExpertCampaignDraft");
    expect(nameOf(expert.saveDraft)).toBe("saveExpertCampaignDraft");
    expect(nameOf(expert.deleteDraft)).toBe("deleteExpertCampaignDraft");
    expect(nameOf(expert.submitDraft)).toBe("submitExpertCampaignDraft");
  });
});
