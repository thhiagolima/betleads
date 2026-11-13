// Super admin: configuração e leitura da sonda da rota SMS
// (sms-route-probe.server.ts).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { auditAdminAction } from "@/lib/admin-audit.server";
import { assertSuperAdmin } from "@/lib/provider-governance.server";

import { MAX_PROBE_PHONES } from "./sms-route-probe";
import {
  loadProbeOverview,
  loadProbeSettings,
  loadProbeStatus,
  runSmsRouteProbe,
  saveProbeSettings,
} from "./sms-route-probe.server";

type AuthContext = { userId: string };

export const saveProbeSettingsInput = z.object({
  enabled: z.boolean(),
  phones: z.array(z.string().max(40)).max(MAX_PROBE_PHONES * 3),
});

/** Barra do topo: só o status (leve, consultado a cada minuto). */
export const getSmsRouteProbeStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertSuperAdmin((context as AuthContext).userId);
    return loadProbeStatus(new Date());
  });

/** Painel do admin: configuração, status e últimos envios. */
export const getSmsRouteProbeOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertSuperAdmin((context as AuthContext).userId);
    return loadProbeOverview(new Date());
  });

export const saveSmsRouteProbeSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => saveProbeSettingsInput.parse(data))
  .handler(async ({ data, context }) => {
    const { userId } = context as AuthContext;
    await assertSuperAdmin(userId);
    const before = await loadProbeSettings();
    const saved = await saveProbeSettings(data, userId);
    await auditAdminAction({
      actorUserId: userId,
      action: "sms_route_probe.settings",
      before: { enabled: before.enabled, phones: before.phones },
      after: { enabled: saved.enabled, phones: saved.phones },
    });
    return saved;
  });

/** Botão "Testar agora": uma rodada fora do horário, mesmo com a sonda desligada. */
export const runSmsRouteProbeNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId } = context as AuthContext;
    await assertSuperAdmin(userId);
    const result = await runSmsRouteProbe(new Date(), { force: true });
    await auditAdminAction({
      actorUserId: userId,
      action: "sms_route_probe.run_now",
      after: result,
    });
    return result;
  });
