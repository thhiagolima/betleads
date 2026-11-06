// Web push (OneSignal) — Task 10: server functions for creating, listing,
// counting the audience of, and cancelling push campaigns. Thin wrappers:
// all logic lives in campaigns.server.ts (tested against createFakeDb()).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { dbUuid } from "@/lib/zod-helpers";
import {
  assertTenantCanOperate,
  assertTenantNotDemoForSend,
  resolveCurrentTenantId,
} from "@/lib/tenant-access.server";
import { assertChannelEnabled } from "@/lib/tenant-channels.server";
import {
  cancelWebpushCampaign,
  countWebpushAudience,
  listWebpushCampaigns,
  resumeWebpushCampaign,
  scheduleWebpushCampaign,
  type WebpushAudience,
  type WebpushCampaignsDb,
} from "@/lib/webpush/campaigns.server";

// `supabaseAdmin`'s generated rpc() type only accepts the known function
// names as literals; the campaign module (shared with resolveAudienceForTenant's
// SelectionDb) takes a generic string so it also works with the test fake
// db. Same cast pattern as every other resolveAudienceForTenant call site
// (e.g. sms-audiences.functions.ts: `supabase as unknown as SelectionDb`).
const campaignsDb = supabaseAdmin as unknown as WebpushCampaignsDb;

const webpushAudienceInput = z.union([
  z.object({ kind: z.literal("todos") }),
  z.object({ kind: z.literal("filtro"), criteria: z.unknown() }),
]);

function toAudience(input: z.infer<typeof webpushAudienceInput>): WebpushAudience {
  return input.kind === "todos" ? { kind: "todos" } : { kind: "filtro", criteria: input.criteria };
}

export const countWebpushAudienceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ audience: webpushAudienceInput }).parse(input))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveCurrentTenantId(context.supabase);
    return countWebpushAudience(campaignsDb, tenantId, toAudience(data.audience));
  });

const scheduleWebpushCampaignInput = z.object({
  name: z.string().min(1).max(200),
  title: z.string().min(1).max(64),
  body: z.string().min(1).max(240),
  url: z.string().min(1).max(2000),
  imageUrl: z.string().url().nullable().optional(),
  audience: webpushAudienceInput,
  scheduledAt: z.string().nullable(),
});

/**
 * Guard sequence for `scheduleWebpushCampaignFn`, extracted so it can be
 * unit-tested directly (createServerFn handlers can't — see
 * `journeys.functions.ts`'s `assertNoNewDisabledChannelSteps`). Same guard
 * order as `assertBulkSmsCanSend` (sms.functions.ts): resolve the caller's
 * tenant, refuse an operationally blocked house, then a demo house, then a
 * disabled web push channel — before anything is written. Covers the
 * brief's Task 7 case: a house with no `tenant_channels` row (web push off
 * by default) throws `CHANNEL_DISABLED_MESSAGE("webpush")`.
 */
export async function assertWebpushCampaignCanSend(tenantId: string): Promise<void> {
  await assertTenantCanOperate(tenantId);
  await assertTenantNotDemoForSend(tenantId);
  await assertChannelEnabled(tenantId, "webpush");
}

export const scheduleWebpushCampaignFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => scheduleWebpushCampaignInput.parse(input))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveCurrentTenantId(context.supabase);
    await assertWebpushCampaignCanSend(tenantId);
    return scheduleWebpushCampaign(campaignsDb, {
      tenantId,
      name: data.name,
      title: data.title,
      body: data.body,
      url: data.url,
      imageUrl: data.imageUrl ?? null,
      audience: toAudience(data.audience),
      scheduledAt: data.scheduledAt,
      createdBy: context.userId,
    });
  });

export const listWebpushCampaignsFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await resolveCurrentTenantId(context.supabase);
    return listWebpushCampaigns(campaignsDb, tenantId);
  });

const cancelWebpushCampaignInput = z.object({ id: dbUuid() });

export const cancelWebpushCampaignFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => cancelWebpushCampaignInput.parse(input))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveCurrentTenantId(context.supabase);
    return cancelWebpushCampaign(campaignsDb, { tenantId, id: data.id });
  });

const resumeWebpushCampaignInput = z.object({ id: dbUuid() });

/**
 * Resumes a push campaign paused for lack of balance, once the house has
 * topped up. Controller ruling: same guard order as `scheduleWebpushCampaignFn`
 * (operate, then demo) — resuming re-activates a send, it is not a read.
 */
export const resumeWebpushCampaignFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => resumeWebpushCampaignInput.parse(input))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveCurrentTenantId(context.supabase);
    await assertTenantCanOperate(tenantId);
    await assertTenantNotDemoForSend(tenantId);
    return resumeWebpushCampaign(campaignsDb, { tenantId, id: data.id });
  });
