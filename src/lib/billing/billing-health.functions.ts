// PG6-03: superadmin server functions for the "Saúde da cobrança" card.
// Only createServerFn exports live here; the logic (and every *.server
// import) is in billing-health.server.ts.
import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

import { adminBillingHealthFor, adminTestBillingAlertFor } from "./billing-health.server";

type AuthContext = { userId: string };

export const adminBillingHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => adminBillingHealthFor(context as AuthContext));

export const adminTestBillingAlert = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => adminTestBillingAlertFor(context as AuthContext));
