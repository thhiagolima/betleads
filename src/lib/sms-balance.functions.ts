// Saldo da Short Brasil lido do painel (sms-balance.server.ts): a barra do
// topo vale para o super admin e para os usuários que ele escolheu; o resto é
// só do super admin.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { auditAdminAction } from "@/lib/admin-audit.server";
import { assertSuperAdmin } from "@/lib/provider-governance.server";

import { MAX_BALANCE_VIEWERS, type BalanceStatus } from "./sms-balance";
import {
  loadBalanceOverview,
  loadBalanceSettings,
  loadBalanceStatus,
  runSmsBalanceCheck,
  saveBalanceSettings,
} from "./sms-balance.server";

type AuthContext = { userId: string };

export const saveBalanceSettingsInput = z.object({
  lowThreshold: z.number().int().min(0).max(10_000_000),
  viewerUserIds: z.array(z.string().uuid()).max(MAX_BALANCE_VIEWERS),
});

export type BalanceBannerData = { status: BalanceStatus; isSuperAdmin: boolean };

async function isSuperAdmin(userId: string): Promise<boolean> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.rpc("is_super_admin", { _user_id: userId });
  return !error && data === true;
}

/** Barra do topo. null = este usuário não acompanha o saldo. */
export const getSmsBalanceBanner = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<BalanceBannerData | null> => {
    const { userId } = context as AuthContext;
    const superAdmin = await isSuperAdmin(userId);
    if (!superAdmin) {
      const settings = await loadBalanceSettings();
      if (!settings.viewerUserIds.includes(userId)) return null;
    }
    return { status: await loadBalanceStatus(new Date()), isSuperAdmin: superAdmin };
  });

/** Painel do admin: saldo, limite, quem vê e últimas leituras. */
export const getSmsBalanceOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertSuperAdmin((context as AuthContext).userId);
    return loadBalanceOverview(new Date());
  });

export const saveSmsBalanceSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => saveBalanceSettingsInput.parse(data))
  .handler(async ({ data, context }) => {
    const { userId } = context as AuthContext;
    await assertSuperAdmin(userId);
    const before = await loadBalanceSettings();
    const saved = await saveBalanceSettings(data, userId);
    await auditAdminAction({
      actorUserId: userId,
      action: "sms_balance.settings",
      before: { lowThreshold: before.lowThreshold, viewerUserIds: before.viewerUserIds },
      after: { lowThreshold: saved.lowThreshold, viewerUserIds: saved.viewerUserIds },
    });
    return saved;
  });

/** Botão "Ler agora": uma leitura fora do horário. */
export const runSmsBalanceCheckNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertSuperAdmin((context as AuthContext).userId);
    return runSmsBalanceCheck(new Date());
  });
