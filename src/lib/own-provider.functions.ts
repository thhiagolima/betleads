// Server functions da conta própria de provedor por casa. Super admin:
// concessões (corpo em own-provider-admin.server.ts). Casa: cadastro,
// teste, ativação e remoção pelo admin da casa ativa (corpo em
// own-provider.server.ts). Imports *.server só dinâmicos, dentro dos
// handlers, para nada de servidor vazar no bundle do cliente.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  activateOwnProviderInput,
  deactivateOwnProviderInput,
  removeOwnProviderAccountInput,
  resolveRevokedOwnProviderInput,
  saveOwnProviderAccountInput,
  setOwnProviderGrantInput,
  testOwnProviderAccountInput,
} from "./own-provider.shared";

type AuthContext = { userId: string; supabase: unknown };

/** userId + casa ativa do usuário (a mesma resolução das outras telas da casa). */
async function houseContext(context: AuthContext) {
  const { resolveCurrentTenantId } = await import("./tenant-access.server");
  const tenantId = await resolveCurrentTenantId(
    context.supabase as Parameters<typeof resolveCurrentTenantId>[0],
  );
  return { userId: context.userId, tenantId };
}

// ---------------------------------------------------------------------------
// Super admin

export const adminListOwnProviderGrants = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { adminListOwnProviderGrantsFor } = await import("./own-provider-admin.server");
    return adminListOwnProviderGrantsFor(context);
  });

export const adminSetOwnProviderGrant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => setOwnProviderGrantInput.parse(data))
  .handler(async ({ data, context }) => {
    const { adminSetOwnProviderGrantFor } = await import("./own-provider-admin.server");
    return adminSetOwnProviderGrantFor(context, data);
  });

export const adminResolveRevokedOwnProvider = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => resolveRevokedOwnProviderInput.parse(data))
  .handler(async ({ data, context }) => {
    const { adminResolveRevokedOwnProviderFor } = await import("./own-provider-admin.server");
    return adminResolveRevokedOwnProviderFor(context, data);
  });

// ---------------------------------------------------------------------------
// Casa (admin da casa ativa)

export const getOwnProviderState = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { getOwnProviderStateFor } = await import("./own-provider.server");
    return getOwnProviderStateFor(await houseContext(context));
  });

export const saveOwnProviderAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => saveOwnProviderAccountInput.parse(data))
  .handler(async ({ data, context }) => {
    const { saveOwnProviderAccountFor } = await import("./own-provider.server");
    return saveOwnProviderAccountFor(await houseContext(context), data);
  });

export const testOwnProviderAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => testOwnProviderAccountInput.parse(data))
  .handler(async ({ data, context }) => {
    const { testOwnProviderAccountFor } = await import("./own-provider.server");
    return testOwnProviderAccountFor(await houseContext(context), data);
  });

export const activateOwnProvider = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => activateOwnProviderInput.parse(data))
  .handler(async ({ data, context }) => {
    const { activateOwnProviderFor } = await import("./own-provider.server");
    return activateOwnProviderFor(await houseContext(context), data);
  });

export const deactivateOwnProvider = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => deactivateOwnProviderInput.parse(data))
  .handler(async ({ data, context }) => {
    const { deactivateOwnProviderFor } = await import("./own-provider.server");
    return deactivateOwnProviderFor(await houseContext(context), data);
  });

export const removeOwnProviderAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => removeOwnProviderAccountInput.parse(data))
  .handler(async ({ data, context }) => {
    const { removeOwnProviderAccountFor } = await import("./own-provider.server");
    return removeOwnProviderAccountFor(await houseContext(context), data);
  });
