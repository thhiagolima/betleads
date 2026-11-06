// Web push (OneSignal) — Task 6: super admin server functions to activate a
// house's origin and change an app's status. Provider infrastructure is
// platform-owned (assertSuperAdmin, same guard as every other provider
// credential screen), and never available for the demo tenant
// (assertTenantNotDemo).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { dbUuid } from "@/lib/zod-helpers";
import { assertSuperAdmin } from "@/lib/provider-governance.server";
import { assertTenantNotDemo, resolveOperationalTenantId } from "@/lib/tenant-access.server";
import { assertChannelEnabled } from "@/lib/tenant-channels.server";
import { checkSuperAdmin, checkTenantAdmin, requireHouseAdmin } from "@/lib/house-config.functions";
import {
  activateWebpushOrigin,
  getWebpushIntegrationState,
  listRecentWebpushSubscriptions,
  saveWebpushPrompt,
  sendWebpushTest,
  setWebpushAppStatus,
  verifyWebpushWorker,
} from "@/lib/webpush/apps.server";

const activateWebpushOriginInput = z.union([
  z.object({
    tenantId: dbUuid(),
    origin: z.string().min(1).max(500),
    mode: z.literal("api"),
  }),
  z.object({
    tenantId: dbUuid(),
    origin: z.string().min(1).max(500),
    mode: z.literal("manual"),
    appId: z.string().min(1).max(200),
    apiKey: z.string().min(1).max(2000),
  }),
]);

export const activateWebpushOriginFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => activateWebpushOriginInput.parse(v))
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context.userId);
    await assertTenantNotDemo(data.tenantId);
    await assertChannelEnabled(data.tenantId, "webpush");
    return activateWebpushOrigin(supabaseAdmin, data);
  });

const setWebpushAppStatusInput = z.object({
  tenantId: dbUuid(),
  appRowId: dbUuid(),
  status: z.enum(["legado", "desativado", "ativo"]),
});

export const setWebpushAppStatusFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => setWebpushAppStatusInput.parse(v))
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context.userId);
    await assertTenantNotDemo(data.tenantId);
    await setWebpushAppStatus(supabaseAdmin, data);
    return { ok: true };
  });

// ============================================================================
// Task 7: integration state, invite and test push.
// ============================================================================

type TenantSiteRow = { nome: string; site_url: string | null };

async function fetchTenantSite(tenantId: string): Promise<TenantSiteRow> {
  const { data, error } = await supabaseAdmin
    .from("tenants")
    .select("nome,site_url")
    .eq("id", tenantId)
    .single();
  if (error) throw new Error(error.message);
  return data as TenantSiteRow;
}

/**
 * The house's web push integration screen: installed apps, the "current" app
 * driving activation, loader/player snippets, prompt copy, plus (controller
 * ruling) `tenantId` and `siteUrl` for the super admin activation block.
 * `canEdit` gates the house-side write actions (prompt, test push); any
 * tenant member can view.
 */
export const getWebpushIntegrationFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);

    const [state, tenant, canEdit, isSuperAdmin] = await Promise.all([
      getWebpushIntegrationState(supabaseAdmin, tenantId),
      fetchTenantSite(tenantId),
      checkTenantAdmin(context.supabase, tenantId),
      checkSuperAdmin(context.supabase, context.userId),
    ]);

    return {
      ...state,
      tenantId,
      siteUrl: tenant.site_url,
      canEdit,
      isSuperAdmin,
    };
  });

export const verifyWebpushWorkerFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ appRowId: dbUuid() }).parse(v))
  .handler(async ({ data, context }) => {
    const tenantId = await requireHouseAdmin(context);
    return verifyWebpushWorker(supabaseAdmin, { tenantId, appRowId: data.appRowId });
  });

const saveWebpushPromptInput = z.object({
  promptText: z.string().min(1).max(90),
  acceptLabel: z.string().min(1).max(15),
  cancelLabel: z.string().min(1).max(15),
  iconUrl: z.string().url().nullable().optional(),
});

export const saveWebpushPromptFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => saveWebpushPromptInput.parse(v))
  .handler(async ({ data, context }) => {
    const tenantId = await requireHouseAdmin(context);
    return saveWebpushPrompt(supabaseAdmin, { tenantId, ...data });
  });

export const listRecentWebpushSubscriptionsFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ appRowId: dbUuid() }).parse(v))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    return listRecentWebpushSubscriptions(supabaseAdmin, { tenantId, appRowId: data.appRowId });
  });

export const sendWebpushTestFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ subscriptionRowId: dbUuid() }).parse(v))
  .handler(async ({ data, context }) => {
    const tenantId = await requireHouseAdmin(context);
    await assertChannelEnabled(tenantId, "webpush");
    return sendWebpushTest(supabaseAdmin, { tenantId, subscriptionRowId: data.subscriptionRowId });
  });
