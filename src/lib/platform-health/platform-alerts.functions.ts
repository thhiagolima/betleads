// Super-admin "Saúde" console (Task 5/F3): acknowledge/silence a platform
// alert and read the 30-day resolved history. Reuses `adminPlatformHealthFor`
// (its own 60 s cache) to find the "current" computed alert for a key — the
// `current` the store needs to create the row when the cron hasn't stored it
// yet (ensureOpenAlert in alert-store.server.ts).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertSuperAdmin } from "@/lib/billing/billing-health.server";

import type { PlatformAlert } from "./alert-rules";
import { acknowledgeAlert, listAlertHistory, silenceAlert } from "./alert-store.server";
import { adminPlatformHealthFor, invalidatePlatformHealthCache } from "./platform-health.server";

type AuthContext = { userId: string };

export const alertKeyInput = z.object({ key: z.string().min(1) });

/** The alert matching `key` in this round's computed health, or null if it has vanished. */
async function currentAlertFor(ctx: AuthContext, key: string): Promise<PlatformAlert | null> {
  const health = await adminPlatformHealthFor(ctx);
  return health.alerts.find((alert) => alert.key === key) ?? null;
}

export async function adminAcknowledgeAlertFor(
  ctx: AuthContext,
  data: unknown,
): Promise<{ ok: true }> {
  const input = alertKeyInput.parse(data);
  await assertSuperAdmin(ctx.userId);
  const current = await currentAlertFor(ctx, input.key);
  await acknowledgeAlert(input.key, ctx.userId, current, new Date());
  // Fix round 1: the write above is invisible to the next `adminPlatformHealthFor` call for up
  // to CACHE_MS otherwise — the acting admin's own `invalidateQueries` would refetch into a
  // still-stale server-side cache.
  invalidatePlatformHealthCache();
  return { ok: true };
}

export const adminAcknowledgeAlert = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => alertKeyInput.parse(data))
  .handler(async ({ data, context }) => adminAcknowledgeAlertFor(context as AuthContext, data));

export async function adminSilenceAlertFor(ctx: AuthContext, data: unknown): Promise<{ ok: true }> {
  const input = alertKeyInput.parse(data);
  await assertSuperAdmin(ctx.userId);
  const current = await currentAlertFor(ctx, input.key);
  await silenceAlert(input.key, current, new Date());
  invalidatePlatformHealthCache();
  return { ok: true };
}

export const adminSilenceAlert = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => alertKeyInput.parse(data))
  .handler(async ({ data, context }) => adminSilenceAlertFor(context as AuthContext, data));

export async function adminAlertHistoryFor(ctx: AuthContext) {
  await assertSuperAdmin(ctx.userId);
  return listAlertHistory(new Date());
}

export const adminAlertHistory = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => adminAlertHistoryFor(context as AuthContext));
