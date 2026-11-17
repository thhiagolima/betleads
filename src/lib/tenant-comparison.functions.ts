/* eslint-disable @typescript-eslint/no-explicit-any -- CRM result tables precede generated Supabase types. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { comparableTenantIds } from "./tenant-comparison";
import { brtDate, getTenantComparisonFor } from "./tenant-comparison.server";

const db = supabaseAdmin as any;

/**
 * Houses this user may compare, decided on the server on every call: only
 * houses where the user is admin, and only when there are two or more.
 */
async function comparableTenants(userId: string) {
  const [{ data: superAdmin, error: superAdminError }, { data: roles, error: rolesError }] =
    await Promise.all([
      db.rpc("is_super_admin", { _user_id: userId }),
      db.from("user_roles").select("tenant_id,role").eq("user_id", userId),
    ]);
  if (superAdminError || rolesError) throw new Error("Não foi possível validar a permissão.");
  const { data: tenants, error } = await db.from("tenants").select("id,nome,moeda").order("nome");
  if (error) throw new Error("Não foi possível carregar as casas.");
  const allowed = new Set(
    comparableTenantIds(
      (roles ?? []) as Array<{ tenant_id: string | null; role: string }>,
      Boolean(superAdmin),
      ((tenants ?? []) as Array<{ id: string }>).map((tenant) => tenant.id),
    ),
  );
  return ((tenants ?? []) as Array<{ id: string; nome: string; moeda: string | null }>).filter(
    (tenant) => allowed.has(tenant.id),
  );
}

export const getComparisonAccess = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenants = await comparableTenants(context.userId);
    return { allowed: tenants.length > 0, tenants: tenants.map((tenant) => tenant.nome) };
  });

/**
 * The panel's comparison for `userId` over the last `days` days (BRT, today
 * included): permission from comparableTenants, rows from the shared core.
 */
export async function getTenantComparisonForUser(userId: string, days: number) {
  const tenants = await comparableTenants(userId);
  if (tenants.length === 0)
    throw new Error("Disponível apenas para administradores de duas ou mais casas.");
  const now = new Date();
  const from = brtDate(days - 1, now);
  const rows = await getTenantComparisonFor(tenants, { from, to: brtDate(0, now) }, now);
  return { from, days, rows };
}

export const getTenantComparison = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) =>
    z.object({ days: z.number().int().min(1).max(180).default(30) }).parse(value ?? {}),
  )
  .handler(({ data, context }) => getTenantComparisonForUser(context.userId, data.days));
