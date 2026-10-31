// Área do Expert §8 — /publicos e /campanhas são as MESMAS telas para a casa
// e para o expert (decisão do produto: reaproveitar, não duplicar). O que
// muda é a fonte de dados: este módulo escolhe, pelo papel do shell
// (ShellRole), entre as server functions da casa e as do expert, com uma
// interface comum para públicos e rascunhos. Os envios em si (SMS, e-mail,
// voz) têm payloads diferentes — a casa manda a lista resolvida, o expert
// manda o critério e o servidor resolve — e ficam em ramos explícitos do
// compositor.

import {
  deleteCampaignDraft,
  getCampaignDraft,
  listCampaignDrafts,
  saveCampaignDraft,
  submitCampaignDraft,
  type CampaignDraft,
  type CampaignDraftPayload,
} from "@/lib/campaign-drafts.functions";
import {
  deleteExpertAudience,
  deleteExpertCampaignDraft,
  getExpertCampaignDraft,
  listExpertAudiences,
  listExpertCampaignDrafts,
  saveExpertAudience,
  saveExpertCampaignDraft,
  markExpertCampaignDraftSubmitted,
} from "@/lib/expert-campaigns.functions";
import type { ShellRole } from "@/lib/navigation";
import {
  deleteSmsAudience,
  listSmsAudiences,
  saveSmsAudience,
} from "@/lib/sms-audience-crud.functions";

export type CampaignSourceKind = "house" | "expert";

/** The expert role reads/writes through the expert functions; every other role through the house ones. */
export function campaignSourceKind(role: ShellRole | null | undefined): CampaignSourceKind {
  return role === "expert" ? "expert" : "house";
}

/** One saved audience as both lists return it. `owner`/`readOnly` only come from the expert list. */
export type CampaignAudienceRow = {
  id: string;
  name: string;
  description: string | null;
  criteria: unknown;
  /** "meu": the expert's own (editable); "casa": the house's, read-only (total-access expert). */
  owner?: "meu" | "casa";
  readOnly?: boolean;
};

export type CampaignAudienceSaveInput = {
  id?: string;
  name: string;
  description?: string;
  criteria: Record<string, unknown>;
};

export type CampaignDraftSaveInput = CampaignDraftPayload & {
  id?: string | null;
  version?: number | null;
  idempotencyKey: string;
};

type Call<I, O> = (opts: { data: I }) => Promise<O>;

export type CampaignDataSource = {
  kind: CampaignSourceKind;
  /** Separate cache entries per role: an expert never reads the house cache and vice versa. */
  queryKeys: {
    audiences: readonly string[];
    drafts: readonly string[];
    draft: (id: string | null) => readonly unknown[];
  };
  listAudiences: () => Promise<CampaignAudienceRow[]>;
  saveAudience: Call<CampaignAudienceSaveInput, unknown>;
  deleteAudience: Call<{ id: string }, unknown>;
  listDrafts: () => Promise<{ items: CampaignDraft[] }>;
  getDraft: Call<{ id: string }, CampaignDraft>;
  saveDraft: Call<CampaignDraftSaveInput, CampaignDraft>;
  deleteDraft: Call<{ id: string }, unknown>;
  submitDraft: Call<{ id: string }, unknown>;
};

/* The server functions' inferred types carry router/middleware generics;
   the shapes below are the ones the screens rely on. */
const as = <T>(fn: unknown) => fn as T;

export const HOUSE_CAMPAIGN_SOURCE: CampaignDataSource = {
  kind: "house",
  queryKeys: {
    audiences: ["sms-audiences"],
    drafts: ["campaign-drafts"],
    draft: (id) => ["campaign-draft", id],
  },
  listAudiences: as<CampaignDataSource["listAudiences"]>(listSmsAudiences),
  saveAudience: as<CampaignDataSource["saveAudience"]>(saveSmsAudience),
  deleteAudience: as<CampaignDataSource["deleteAudience"]>(deleteSmsAudience),
  listDrafts: as<CampaignDataSource["listDrafts"]>(listCampaignDrafts),
  getDraft: as<CampaignDataSource["getDraft"]>(getCampaignDraft),
  saveDraft: as<CampaignDataSource["saveDraft"]>(saveCampaignDraft),
  deleteDraft: as<CampaignDataSource["deleteDraft"]>(deleteCampaignDraft),
  submitDraft: as<CampaignDataSource["submitDraft"]>(submitCampaignDraft),
};

export const EXPERT_CAMPAIGN_SOURCE: CampaignDataSource = {
  kind: "expert",
  queryKeys: {
    audiences: ["expert-audiences"],
    drafts: ["expert-campaign-drafts"],
    draft: (id) => ["expert-campaign-draft", id],
  },
  listAudiences: as<CampaignDataSource["listAudiences"]>(listExpertAudiences),
  saveAudience: as<CampaignDataSource["saveAudience"]>(saveExpertAudience),
  deleteAudience: as<CampaignDataSource["deleteAudience"]>(deleteExpertAudience),
  listDrafts: as<CampaignDataSource["listDrafts"]>(listExpertCampaignDrafts),
  getDraft: as<CampaignDataSource["getDraft"]>(getExpertCampaignDraft),
  saveDraft: as<CampaignDataSource["saveDraft"]>(saveExpertCampaignDraft),
  deleteDraft: as<CampaignDataSource["deleteDraft"]>(deleteExpertCampaignDraft),
  // The composer creates the campaign itself and then only marks the draft;
  // submitExpertCampaignDraft would create a second campaign.
  submitDraft: as<CampaignDataSource["submitDraft"]>(markExpertCampaignDraftSubmitted),
};

export function campaignDataSourceFor(role: ShellRole | null | undefined): CampaignDataSource {
  return campaignSourceKind(role) === "expert" ? EXPERT_CAMPAIGN_SOURCE : HOUSE_CAMPAIGN_SOURCE;
}
