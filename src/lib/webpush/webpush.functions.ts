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
import { assertTenantNotDemo } from "@/lib/tenant-access.server";
import { activateWebpushOrigin, setWebpushAppStatus } from "@/lib/webpush/apps.server";

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
