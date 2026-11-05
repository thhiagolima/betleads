// Super-admin "Saúde" console (F1): server function exports. Only
// `createServerFn` exports live here; the logic (and every *.server import)
// is in platform-health.server.ts.
import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

import { adminPlatformHealthFor } from "./platform-health.server";

type AuthContext = { userId: string };

export const adminPlatformHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => adminPlatformHealthFor(context as AuthContext));
