// Server functions of Admin → Integrações → provider accounts (super admin
// only). Bodies live in provider-accounts-admin.server.ts.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  deleteProviderAccountInput,
  saveProviderAccountInput,
  setPlatformDefaultInput,
  setProviderAccountStatusInput,
  setTenantChannelProviderInput,
  testProviderAccountInput,
} from "./provider-accounts.shared";
import { setTenantChannelInput, tenantChannelImpactInput } from "./tenant-channels.shared";

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

export const adminSetPlatformDefault = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => setPlatformDefaultInput.parse(data))
  .handler(async ({ data, context }) => {
    const { adminSetPlatformDefaultFor } = await import("./provider-accounts-admin.server");
    return adminSetPlatformDefaultFor(context, data);
  });

export const adminDeleteProviderAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => deleteProviderAccountInput.parse(data))
  .handler(async ({ data, context }) => {
    const { adminDeleteProviderAccountFor } = await import("./provider-accounts-admin.server");
    return adminDeleteProviderAccountFor(context, data);
  });

export const adminTenantChannelImpact = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => tenantChannelImpactInput.parse(data))
  .handler(async ({ data, context }) => {
    const { adminTenantChannelImpactFor } = await import("./tenant-channels-admin.server");
    return adminTenantChannelImpactFor(context, data);
  });

export const adminSetTenantChannel = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => setTenantChannelInput.parse(data))
  .handler(async ({ data, context }) => {
    const { adminSetTenantChannelFor } = await import("./tenant-channels-admin.server");
    return adminSetTenantChannelFor(context, data);
  });
