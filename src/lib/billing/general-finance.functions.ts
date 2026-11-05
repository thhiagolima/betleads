// Task 3 — super admin server function for the "Financeiro geral" view. Only
// the createServerFn export lives here; the logic (and every *.server
// import) is in general-finance.server.ts.
import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

import { adminGeneralFinanceFor, generalFinanceInput } from "./general-finance.server";

type AuthContext = { userId: string };

export const adminGeneralFinance = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => generalFinanceInput.parse(data))
  .handler(async ({ data, context }) => adminGeneralFinanceFor(context as AuthContext, data));
