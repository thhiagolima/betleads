import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertTenantCanOperate, resolveCurrentTenantId } from "@/lib/tenant-access.server";
import {
  isSelectionAudience,
  normalizeSmsAudienceCriteria,
  smsAudienceCriteriaSchema,
} from "@/lib/sms-audience-criteria";
import { resolveAudienceForTenant, type SelectionDb } from "@/lib/sms-audience-selection.server";
import { withServerResultCache } from "@/lib/server-result-cache";
import type { BlockReason } from "@/lib/channel-eligibility.server";

const audienceInput = z.object({ criteria: smsAudienceCriteriaSchema });

export type ResolvedSmsAudience = {
  phones: string[];
  total: number;
  recipientTotal: number;
  emailPlayerIds: string[];
  emailRecipientTotal: number;
  facets: {
    activity: {
      depositNever: number;
      depositYes: number;
      pixUnpaid: number;
      withdrawalYes: number;
      withdrawalNever: number;
      withdrawalPending: number;
      cashback: number;
    };
    levels: Record<"bronze" | "silver" | "gold" | "diamond" | "black", number>;
    timings: Record<"cooling" | "sleeping" | "inactive30" | "inactive90", number>;
  };
  settings: {
    thresholds: Record<string, number>;
    cooling: number;
    sleeping: number;
  };
};

export const resolveSmsCampaignAudience = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => audienceInput.parse(input))
  .handler(async ({ data, context }): Promise<ResolvedSmsAudience> => {
    const supabase = context.supabase;
    const tenantId = await resolveCurrentTenantId(supabase);
    await assertTenantCanOperate(tenantId, context.supabase);
    const criteria = normalizeSmsAudienceCriteria(data.criteria);
    const db = supabase as unknown as SelectionDb;
    // Seleção: lista de até 50 mil ids, não vira chave de cache.
    if (isSelectionAudience(criteria)) return resolveAudienceForTenant(db, tenantId, criteria);
    const criteriaKey = JSON.stringify(criteria);

    return withServerResultCache(`audience:${tenantId}:${criteriaKey}`, 30_000, () =>
      resolveAudienceForTenant(db, tenantId, criteria),
    );
  });

const channelAudienceInput = audienceInput.extend({ channel: z.enum(["sms", "email", "voice"]) });

export type ResolvedCampaignAudience = ResolvedSmsAudience & {
  channel: "sms" | "email" | "voice";
  eligibleTotal: number;
  excludedTotal: number;
  eligibleIdentifiers: string[];
  eligiblePlayerIds: string[];
  exclusions: Partial<Record<BlockReason, number>>;
};

/**
 * Channel-explicit audience contract used by count, preview and dispatch.
 * It applies the same consent/suppression function used again by the workers.
 */
export const resolveCampaignAudience = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => channelAudienceInput.parse(input))
  .handler(async ({ data, context }): Promise<ResolvedCampaignAudience> => {
    const tenantId = await resolveCurrentTenantId(context.supabase);
    await assertTenantCanOperate(tenantId, context.supabase);
    const criteria = normalizeSmsAudienceCriteria(data.criteria);
    let base: ResolvedSmsAudience;
    try {
      base = await resolveAudienceForTenant(
        context.supabase as unknown as SelectionDb,
        tenantId,
        criteria,
      );
    } catch {
      throw new Error("Não foi possível calcular o público desta campanha.");
    }
    const candidates = data.channel === "email" ? (base.emailPlayerIds ?? []) : (base.phones ?? []);
    const rpcClient = context.supabase as unknown as {
      rpc: (
        name: string,
        args: Record<string, unknown>,
      ) => Promise<{
        data: unknown;
        error: { message: string } | null;
      }>;
    };
    const { data: eligibilityRaw, error: eligibilityError } = await rpcClient.rpc(
      "resolve_campaign_channel_eligibility",
      { p_tenant_id: tenantId, p_channel: data.channel, p_candidates: candidates },
    );
    if (eligibilityError || !eligibilityRaw)
      throw new Error("Não foi possível validar os contatos do público.");
    const eligibility = eligibilityRaw as {
      candidateCount: number;
      eligibleIdentifiers: string[];
      eligiblePlayerIds: string[];
      invalidCount: number;
      optOutCount: number;
    };
    const eligibleIdentifiers = eligibility.eligibleIdentifiers ?? [];
    const eligiblePlayerIds = eligibility.eligiblePlayerIds ?? [];
    const exclusions: Partial<Record<BlockReason, number>> = {};
    const missing = Math.max(0, base.total - candidates.length);
    if (missing) exclusions[data.channel === "email" ? "missing_email" : "missing_phone"] = missing;
    if (eligibility.invalidCount)
      exclusions[data.channel === "email" ? "invalid_email" : "invalid_phone"] =
        eligibility.invalidCount;
    if (eligibility.optOutCount) {
      const reason =
        data.channel === "email"
          ? "email_opt_out"
          : data.channel === "voice"
            ? "voice_opt_out"
            : "sms_opt_out";
      exclusions[reason] = eligibility.optOutCount;
    }
    return {
      ...base,
      channel: data.channel,
      eligibleTotal: eligibleIdentifiers.length,
      excludedTotal: Math.max(0, base.total - eligibleIdentifiers.length),
      eligibleIdentifiers,
      eligiblePlayerIds,
      exclusions,
    };
  });
