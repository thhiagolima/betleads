import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertTenantCanOperate, resolveCurrentTenantId } from "@/lib/tenant-access.server";
import {
  normalizeSmsAudienceCriteria,
  smsAudienceCriteriaSchema,
} from "@/lib/sms-audience-criteria";
import { withServerResultCache } from "@/lib/server-result-cache";

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
