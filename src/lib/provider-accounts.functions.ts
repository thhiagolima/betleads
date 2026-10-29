// Server functions of Admin → Integrações → provider accounts (super admin
// only). Bodies live in provider-accounts-admin.server.ts.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  saveProviderAccountInput,
  setProviderAccountStatusInput,
  setTenantChannelProviderInput,
  testProviderAccountInput,
} from "./provider-accounts.shared";

export const adminListProviderAccounts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { adminListProviderAccountsFor } = await import("./provider-accounts-admin.server");
    return adminListProviderAccountsFor(context);
  });

export const adminSaveProviderAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => saveProviderAccountInput.parse(data))
  .handler(async ({ data, context }) => {
    const { adminSaveProviderAccountFor } = await import("./provider-accounts-admin.server");
    return adminSaveProviderAccountFor(context, data);
  });

export const adminSetProviderAccountStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => setProviderAccountStatusInput.parse(data))
  .handler(async ({ data, context }) => {
    const { adminSetProviderAccountStatusFor } = await import("./provider-accounts-admin.server");
    return adminSetProviderAccountStatusFor(context, data);
  });

export const adminTestProviderAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => testProviderAccountInput.parse(data))
  .handler(async ({ data, context }) => {
    const { adminTestProviderAccountFor } = await import("./provider-accounts-admin.server");
    return adminTestProviderAccountFor(context, data);
  });

export const adminSetTenantChannelProvider = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => setTenantChannelProviderInput.parse(data))
  .handler(async ({ data, context }) => {
    const { adminSetTenantChannelProviderFor } = await import("./provider-accounts-admin.server");
    return adminSetTenantChannelProviderFor(context, data);
  });
