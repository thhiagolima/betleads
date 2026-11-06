// Server functions of the "Ciente" channel-disabled notice (Task 10). Bodies
// live in tenant-channel-notices.server.ts.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveOperationalTenantId } from "@/lib/tenant-access.server";
import { PROVIDER_CHANNELS } from "@/lib/provider-accounts.shared";
import { dbUuid } from "@/lib/zod-helpers";

const ackChannelNoticeInput = z.object({
  tenantId: dbUuid(),
  channel: z.enum(PROVIDER_CHANNELS),
  disabledAt: z.string(),
});

export const getPendingChannelNotices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const { getPendingChannelNoticesFor } = await import("./tenant-channel-notices.server");
    return getPendingChannelNoticesFor(context.userId, tenantId);
  });

export const ackChannelNotice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => ackChannelNoticeInput.parse(data))
  .handler(async ({ data, context }) => {
    const { ackChannelNoticeFor } = await import("./tenant-channel-notices.server");
    return ackChannelNoticeFor(context.userId, data);
  });
