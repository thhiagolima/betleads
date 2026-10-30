// Área do Expert §8 — server functions das campanhas do expert (SMS, e-mail
// e voz) e da aprovação pelo admin. Só wrappers: o núcleo fica em
// expert-campaigns.server.ts (fora do bundle do navegador).
//
// Formas espelham as funções da casa para o compositor e /publicos poderem
// trocar de função conforme o papel:
//   listSmsAudiences        → listExpertAudiences
//   saveSmsAudience         → saveExpertAudience
//   deleteSmsAudience       → deleteExpertAudience
//   createSelectionAudience → createExpertSelectionAudience
//   resolveCampaignAudience → resolveExpertCampaignAudience (só contagens)
//   sendBulkSms / scheduleBulkSms → sendExpertBulkSms / scheduleExpertBulkSms
//   saveEmailCampaign / sendEmailCampaignNow → saveExpertEmailCampaign / sendExpertEmailCampaignNow
//   bulkDispatchCalls       → bulkDispatchExpertCalls
//   getComposerOptions      → getExpertComposerOptions

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireExpertAdminTenant } from "@/lib/experts-admin.functions";
import {
  approveExpertCampaignCore,
  cancelExpertCampaignFor,
  deleteExpertCampaignDraftFor,
  getExpertCampaignDraftFor,
  listExpertCampaignDraftsFor,
  saveExpertCampaignDraftFor,
  submitExpertCampaignDraftFor,
  createExpertSelectionAudienceFor,
  deleteExpertAudienceFor,
  getExpertCampaignUsageFor,
  getExpertComposerOptionsFor,
  listExpertAudiencesFor,
  listExpertCampaignsFor,
  listExpertCampaignsForAdminCore,
  pauseExpertCampaignCore,
  rejectExpertCampaignCore,
  resolveExpertCampaignAudienceFor,
  resumeExpertCampaignCore,
  saveExpertAudienceFor,
  saveExpertEmailCampaignFor,
  saveExpertSmsCampaignFor,
  saveExpertVoiceCampaignFor,
  sendExpertEmailCampaignNowFor,
  type ExpertServerContext,
} from "@/lib/expert-campaigns.server";
import { MAX_SELECTION_PLAYER_IDS, campaignAudienceCriteriaInput } from "@/lib/sms-audience-criteria";
import { campaignDraftSaveSchema } from "@/lib/campaign-drafts.functions";
import { dbUuid } from "@/lib/zod-helpers";

type AdminContext = Parameters<typeof requireExpertAdminTenant>[0];

const channel = z.enum(["sms", "email", "voice"]);
const playerIds = z.array(dbUuid()).max(MAX_SELECTION_PLAYER_IDS).optional();
/** Saved audience id, house audience (total experts) or rules. Never a phone/e-mail list. */
const audienceCriteria = campaignAudienceCriteriaInput;

const ctxOf = (context: unknown) => context as ExpertServerContext;

// ─── Públicos ───────────────────────────────────────────────────────────────

export const listExpertAudiences = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => listExpertAudiencesFor(ctxOf(context)));

const saveAudienceInput = z.object({
  id: dbUuid().optional(),
  name: z.string().min(2).max(120),
  description: z.string().max(300).optional(),
  criteria: z.record(z.string(), z.unknown()),
});

export const saveExpertAudience = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => saveAudienceInput.parse(v))
  .handler(async ({ data, context }) => saveExpertAudienceFor(ctxOf(context), data));

export const deleteExpertAudience = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ id: dbUuid() }).parse(v))
  .handler(async ({ data, context }) => deleteExpertAudienceFor(ctxOf(context), data));

const selectionInput = z.object({
  playerIds: z
    .array(dbUuid())
    .min(1, "Nenhum jogador selecionado.")
    .max(
      MAX_SELECTION_PLAYER_IDS,
      `A seleção passa de ${MAX_SELECTION_PLAYER_IDS.toLocaleString("pt-BR")} jogadores.`,
    ),
  label: z.string().max(120).optional(),
});

export const createExpertSelectionAudience = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => selectionInput.parse(v))
  .handler(async ({ data, context }) => createExpertSelectionAudienceFor(ctxOf(context), data));

const resolveInput = z.object({
  criteria: audienceCriteria,
  channel,
  playerIds,
  /** SMS text, only to estimate the segments/cost. */
  content: z.string().max(480).optional(),
  /** Voice audio length, only to estimate the cost. */
  voiceSeconds: z.number().int().min(1).max(600).nullable().optional(),
});

export const resolveExpertCampaignAudience = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => resolveInput.parse(v))
  .handler(async ({ data, context }) => resolveExpertCampaignAudienceFor(ctxOf(context), data));

// ─── SMS ────────────────────────────────────────────────────────────────────

const smsBase = z.object({
  /** Edit an existing campaign of the expert (back to pending in approval mode). */
  id: dbUuid().optional(),
  campaignName: z.string().min(1).max(120),
  content: z.string().min(1).max(480),
  audienceCriteria: audienceCriteria,
  playerIds,
});

export const sendExpertBulkSms = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => smsBase.parse(v))
  .handler(async ({ data, context }) =>
    saveExpertSmsCampaignFor(ctxOf(context), { ...data, scheduledAt: null }),
  );

export const scheduleExpertBulkSms = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => smsBase.extend({ scheduledAt: z.string().min(1) }).parse(v))
  .handler(async ({ data, context }) => saveExpertSmsCampaignFor(ctxOf(context), data));

// ─── E-mail ─────────────────────────────────────────────────────────────────

const emailInput = z.object({
  id: dbUuid().optional(),
  nome: z.string().min(1).max(160),
  assunto: z.string().max(300).optional(),
  html: z.string().max(500_000).optional(),
  preheader: z.string().max(300).optional(),
  templateId: dbUuid().nullable().optional(),
  audienceCriteria: audienceCriteria,
  playerIds,
  agendadoPara: z.string().nullable().optional(),
  status: z.enum(["rascunho", "agendada"]).default("agendada"),
});

export const saveExpertEmailCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => emailInput.parse(v))
  .handler(async ({ data, context }) => saveExpertEmailCampaignFor(ctxOf(context), data));

export const sendExpertEmailCampaignNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ campaignId: dbUuid() }).parse(v))
  .handler(async ({ data, context }) => sendExpertEmailCampaignNowFor(ctxOf(context), data));

// ─── Voz ────────────────────────────────────────────────────────────────────

const voiceInput = z
  .object({
    id: dbUuid().optional(),
    campaign_name: z.string().min(1).max(120),
    scheduled_at: z.string().datetime().optional(),
    script_id: dbUuid().optional(),
    asset_id: dbUuid().optional(),
    audienceCriteria: audienceCriteria,
    playerIds,
  })
  .refine((value) => Boolean(value.script_id) !== Boolean(value.asset_id), {
    message: "Selecione um script TTS ou um áudio fixo da biblioteca.",
  });

export const bulkDispatchExpertCalls = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => voiceInput.parse(v))
  .handler(async ({ data, context }) => saveExpertVoiceCampaignFor(ctxOf(context), data));

// ─── Campanhas do expert ────────────────────────────────────────────────────

export const cancelExpertCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ channel, id: dbUuid() }).parse(v))
  .handler(async ({ data, context }) => cancelExpertCampaignFor(ctxOf(context), data));

export const listExpertCampaigns = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => listExpertCampaignsFor(ctxOf(context)));

export const getExpertCampaignUsage = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => getExpertCampaignUsageFor(ctxOf(context)));

export const getExpertComposerOptions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => getExpertComposerOptionsFor(ctxOf(context)));

// ─── Admin ──────────────────────────────────────────────────────────────────

const adminTarget = z.object({ channel, id: dbUuid() });

export const listExpertCampaignsForAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) =>
    z
      .object({ expertId: dbUuid().nullable().optional(), status: z.string().max(40).nullable().optional() })
      .parse(v ?? {}),
  )
  .handler(async ({ data, context }) => {
    const tenantId = await requireExpertAdminTenant(context as unknown as AdminContext);
    return listExpertCampaignsForAdminCore(tenantId, data);
  });

export const approveExpertCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) =>
    adminTarget.extend({ expectedUpdatedAt: z.string().max(64).nullable().optional() }).parse(v),
  )
  .handler(async ({ data, context }) => {
    const tenantId = await requireExpertAdminTenant(context as unknown as AdminContext);
    return approveExpertCampaignCore(tenantId, context.userId, data);
  });

export const rejectExpertCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) =>
    adminTarget.extend({ reason: z.string().min(1).max(500) }).parse(v),
  )
  .handler(async ({ data, context }) => {
    const tenantId = await requireExpertAdminTenant(context as unknown as AdminContext);
    return rejectExpertCampaignCore(tenantId, context.userId, data);
  });

export const pauseExpertCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => adminTarget.parse(v))
  .handler(async ({ data, context }) => {
    const tenantId = await requireExpertAdminTenant(context as unknown as AdminContext);
    return pauseExpertCampaignCore(tenantId, context.userId, data);
  });

export const resumeExpertCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => adminTarget.parse(v))
  .handler(async ({ data, context }) => {
    const tenantId = await requireExpertAdminTenant(context as unknown as AdminContext);
    return resumeExpertCampaignCore(tenantId, context.userId, data);
  });

// ─── Rascunhos do expert (mesmas formas de campaign-drafts.functions) ──────
//   listCampaignDrafts  → listExpertCampaignDrafts
//   getCampaignDraft    → getExpertCampaignDraft
//   saveCampaignDraft   → saveExpertCampaignDraft
//   deleteCampaignDraft → deleteExpertCampaignDraft
//   submitCampaignDraft → submitExpertCampaignDraft (envia pelo caminho do expert)

export const listExpertCampaignDrafts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => listExpertCampaignDraftsFor(ctxOf(context)));

export const getExpertCampaignDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ id: dbUuid() }).parse(v))
  .handler(async ({ data, context }) => getExpertCampaignDraftFor(ctxOf(context), data));

export const saveExpertCampaignDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => campaignDraftSaveSchema.parse(v))
  .handler(async ({ data, context }) => saveExpertCampaignDraftFor(ctxOf(context), data));

export const deleteExpertCampaignDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ id: dbUuid() }).parse(v))
  .handler(async ({ data, context }) => deleteExpertCampaignDraftFor(ctxOf(context), data));

export const submitExpertCampaignDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ id: dbUuid() }).parse(v))
  .handler(async ({ data, context }) => submitExpertCampaignDraftFor(ctxOf(context), data));
