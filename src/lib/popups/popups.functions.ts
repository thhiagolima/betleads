// Popups nas casas — server functions do CRM. Finas: a lógica está em
// popups.server.ts / audience.server.ts. Leitura: qualquer membro da casa
// (como a tela de web push); escrita: só administrador da casa e nunca a
// casa demo (requireHouseAdmin).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { checkTenantAdmin, requireHouseAdmin } from "@/lib/house-config.functions";
import { refreshPopupAudienceById } from "@/lib/popups/audience.server";
import { popupsEnabledForTenant } from "@/lib/popups/feature.server";
import {
  deletePopupDraft,
  duplicatePopup,
  getPopup,
  getPopupDailyStats,
  getPopupInstallState,
  listPopups,
  savePopup,
  setPopupStatus,
  type PopupsDb,
} from "@/lib/popups/popups.server";
import { POPUP_STATUSES, popupDraftInput, type PopupDraft } from "@/lib/popups/shared";
import { resolveOperationalTenantId } from "@/lib/tenant-access.server";
import { dbUuid } from "@/lib/zod-helpers";

const db = supabaseAdmin as unknown as PopupsDb;

async function requirePopupsEditor(context: { supabase: unknown; userId: string }): Promise<string> {
  const tenantId = await requireHouseAdmin(context);
  if (!(await popupsEnabledForTenant(tenantId))) throw new Error("Popups não estão liberados para esta casa.");
  return tenantId;
}

export const getPopupsOverviewFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const [enabled, popups, install, canEdit] = await Promise.all([
      popupsEnabledForTenant(tenantId),
      listPopups(db, tenantId, new Date()),
      getPopupInstallState(db, tenantId),
      checkTenantAdmin(context.supabase, tenantId),
    ]);
    return { enabled, popups, install, canEdit };
  });

export const getPopupFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ id: dbUuid() }).parse(v))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    return getPopup(db, tenantId, data.id);
  });

export const getPopupStatsFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ id: dbUuid(), days: z.number().int().min(1).max(90) }).parse(v))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    return getPopupDailyStats(db, { tenantId, id: data.id, days: data.days, now: new Date() });
  });

export const savePopupFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ id: dbUuid().nullable(), draft: popupDraftInput }).parse(v))
  .handler(async ({ data, context }) => {
    const tenantId = await requirePopupsEditor(context);
    const saved = await savePopup(db, {
      tenantId,
      id: data.id,
      draft: data.draft as PopupDraft,
      userId: context.userId,
      now: new Date(),
    });
    // A new/changed CRM audience is resolved now, so the count shows in the
    // editor and an active popup reaches the new audience without waiting
    // for the hourly run.
    const audienceCount = saved.audienceChanged ? await refreshPopupAudienceById(db, tenantId, saved.id) : null;
    return { id: saved.id, audienceCount };
  });

export const setPopupStatusFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ id: dbUuid(), status: z.enum(POPUP_STATUSES) }).parse(v))
  .handler(async ({ data, context }) => {
    const tenantId = await requirePopupsEditor(context);
    const result = await setPopupStatus(db, { tenantId, id: data.id, status: data.status, now: new Date() });
    if (result.needsAudience) await refreshPopupAudienceById(db, tenantId, data.id);
    return { status: result.status };
  });

export const duplicatePopupFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ id: dbUuid() }).parse(v))
  .handler(async ({ data, context }) => {
    const tenantId = await requirePopupsEditor(context);
    return duplicatePopup(db, { tenantId, id: data.id, userId: context.userId });
  });

export const deletePopupFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ id: dbUuid() }).parse(v))
  .handler(async ({ data, context }) => {
    const tenantId = await requirePopupsEditor(context);
    await deletePopupDraft(db, { tenantId, id: data.id });
    return { ok: true };
  });
