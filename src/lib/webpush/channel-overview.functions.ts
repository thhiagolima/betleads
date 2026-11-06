// Web push (OneSignal): server function behind the /webpush overview. Thin
// wrapper: the tenant comes from the caller's session (same resolver as
// listWebpushCampaignsFn), never from the client, and the logic lives in
// channel-overview.server.ts.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resolveCurrentTenantId } from "@/lib/tenant-access.server";
import {
  getWebpushChannelOverview,
  type WebpushOverviewDb,
} from "@/lib/webpush/channel-overview.server";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const overviewInput = z
  .object({ from: day, to: day })
  .refine((period) => period.from <= period.to, "Período inválido");

export const getWebpushChannelOverviewFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => overviewInput.parse(input))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveCurrentTenantId(context.supabase);
    return getWebpushChannelOverview(supabaseAdmin as unknown as WebpushOverviewDb, tenantId, data);
  });
