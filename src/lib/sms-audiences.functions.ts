import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertTenantCanOperate, resolveCurrentTenantId } from "@/lib/tenant-access.server";
import {
  normalizeSmsAudienceCriteria,
  smsAudienceCriteriaSchema,
} from "@/lib/sms-audience-criteria";
import { withServerResultCache } from "@/lib/server-result-cache";
import { channelEligibility, type BlockReason } from "@/lib/channel-eligibility.server";

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
    await assertTenantCanOperate(tenantId);
    const criteria = normalizeSmsAudienceCriteria(data.criteria);
    const criteriaKey = JSON.stringify(criteria);

    return withServerResultCache(`audience:${tenantId}:${criteriaKey}`, 30_000, async () => {
      const { data: result, error } = await supabase.rpc("resolve_sms_audience_v2", {
        _tenant: tenantId,
        _criteria: criteria,
      });
      if (error) throw new Error(error.message);
      if (!result) throw new Error("Sem acesso aos jogadores desta conta.");
      return result as ResolvedSmsAudience;
    });
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
    await assertTenantCanOperate(tenantId);
    const criteria = normalizeSmsAudienceCriteria(data.criteria);
    const { data: raw, error } = await context.supabase.rpc("resolve_sms_audience_v2", {
      _tenant: tenantId,
      _criteria: criteria,
    });
    if (error || !raw) throw new Error("Não foi possível calcular o público desta campanha.");
    const base = raw as unknown as ResolvedSmsAudience;
    const exclusions: Partial<Record<BlockReason, number>> = {};
    const bump = (reason: BlockReason) => {
      exclusions[reason] = (exclusions[reason] ?? 0) + 1;
    };

    if (data.channel === "email") {
      const ids = base.emailPlayerIds ?? [];
      const { data: players, error: playerError } = ids.length
        ? await context.supabase.from("players").select("id,email,telefone").in("id", ids)
        : { data: [], error: null };
      if (playerError) throw new Error("Não foi possível validar os contatos do público.");
      const eligibleIdentifiers: string[] = [];
      const eligiblePlayerIds: string[] = [];
      for (const player of players ?? []) {
        const result = await channelEligibility(
          "email",
          { email: player.email, telefone: player.telefone },
          tenantId,
        );
        if (result.eligible && result.email) {
          eligibleIdentifiers.push(result.email);
          eligiblePlayerIds.push(player.id);
        } else if (result.reason) bump(result.reason);
      }
      const contactsNotReturned = Math.max(0, base.total - ids.length);
      if (contactsNotReturned) exclusions.missing_email = contactsNotReturned;
      return {
        ...base,
        channel: data.channel,
        eligibleTotal: eligiblePlayerIds.length,
        excludedTotal: Math.max(0, base.total - eligiblePlayerIds.length),
        eligibleIdentifiers,
        eligiblePlayerIds,
        exclusions,
      };
    }

    const eligibleIdentifiers: string[] = [];
    for (const phone of base.phones ?? []) {
      const result = await channelEligibility(
        data.channel === "voice" ? "call" : "sms",
        { telefone: phone, email: null },
        tenantId,
      );
      if (result.eligible && result.phone) eligibleIdentifiers.push(result.phone);
      else if (result.reason) bump(result.reason);
    }
    const contactsNotReturned = Math.max(0, base.total - (base.phones?.length ?? 0));
    if (contactsNotReturned) exclusions.missing_phone = contactsNotReturned;
    return {
      ...base,
      channel: data.channel,
      eligibleTotal: eligibleIdentifiers.length,
      excludedTotal: Math.max(0, base.total - eligibleIdentifiers.length),
      eligibleIdentifiers,
      eligiblePlayerIds: [],
      exclusions,
    };
  });
