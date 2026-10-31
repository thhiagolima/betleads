// Área do Expert §8 — server functions de leitura do admin sobre as
// campanhas dos experts: detalhe com conteúdo (para aprovar) e uso do mês ×
// teto por expert. Só wrappers; o núcleo fica em
// expert-campaigns-admin.server.ts. Guard: admin da casa operacional.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireExpertAdminTenant } from "@/lib/experts-admin.functions";
import {
  getExpertCampaignForAdminCore,
  listExpertUsageForAdminCore,
} from "@/lib/expert-campaigns-admin.server";
import { dbUuid } from "@/lib/zod-helpers";

type AdminContext = Parameters<typeof requireExpertAdminTenant>[0];

export const getExpertCampaignForAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) =>
    z.object({ channel: z.enum(["sms", "email", "voice"]), id: dbUuid() }).parse(v),
  )
  .handler(async ({ data, context }) => {
    const tenantId = await requireExpertAdminTenant(context as unknown as AdminContext);
    return getExpertCampaignForAdminCore(tenantId, data);
  });

export const listExpertUsageForAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) =>
    z.object({ expertId: dbUuid().nullable().optional() }).parse(v ?? {}),
  )
  .handler(async ({ data, context }) => {
    const tenantId = await requireExpertAdminTenant(context as unknown as AdminContext);
    return listExpertUsageForAdminCore(tenantId, data);
  });
