// Server functions do painel "Meta Ads por casa" (Admin → Integrações, só super
// admin). Os corpos ficam em meta-admin.server.ts.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type { MetaHouseRow } from "./meta-admin.server";
export type { MetaAlertCode } from "./meta-health.server";

export const adminListMetaHouses = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { adminListMetaHousesFor } = await import("./meta-admin.server");
    return adminListMetaHousesFor(context);
  });

export const adminTestMetaAlert = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { adminTestMetaAlertFor } = await import("./meta-admin.server");
    return adminTestMetaAlertFor(context);
  });
