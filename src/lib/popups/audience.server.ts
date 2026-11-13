// Popups nas casas — público "filtro do CRM" resolvido de antemão. Resolver o
// filtro a cada visita seria a RPC das campanhas em toda página da casa; aqui
// ele é resolvido ao ativar/salvar e de hora em hora, gravado como uma nova
// geração em site_popup_audience_members, e só então o popup passa a apontar
// para ela (site_popup_set_audience_generation, que apaga as anteriores).
import { resolveAudienceForTenant, type SelectionDb } from "@/lib/sms-audience-selection.server";
import type { PopupsDb } from "@/lib/popups/popups.server";

const MEMBER_CHUNK = 1000;
/** A popup refreshed less than this ago is skipped by the hourly run. */
const REFRESH_EVERY_MS = 55 * 60_000;

type AudiencePopupRow = {
  id: string;
  tenant_id: string;
  audience_criteria: unknown;
  audience_generation: number;
};

export async function refreshPopupAudience(db: PopupsDb, popup: AudiencePopupRow): Promise<number> {
  const resolved = await resolveAudienceForTenant(
    db as unknown as SelectionDb,
    popup.tenant_id,
    popup.audience_criteria,
    undefined,
    { includePlayerIds: true },
  );
  const playerIds = [...new Set(resolved.playerIds ?? [])];
  const generation = popup.audience_generation + 1;
  for (let i = 0; i < playerIds.length; i += MEMBER_CHUNK) {
    const rows = playerIds
      .slice(i, i + MEMBER_CHUNK)
      .map((playerId) => ({ popup_id: popup.id, generation, player_id: playerId }));
    const { error } = await db
      .from("site_popup_audience_members")
      .upsert(rows, { onConflict: "popup_id,generation,player_id", ignoreDuplicates: true });
    if (error) throw new Error(error.message);
  }
  const { error } = await db.rpc("site_popup_set_audience_generation", {
    p_popup_id: popup.id,
    p_generation: generation,
    p_count: playerIds.length,
  });
  if (error) throw new Error(error.message);
  return playerIds.length;
}

/** Re-resolves one popup's audience now (after save/activation), if it is filtro. */
export async function refreshPopupAudienceById(db: PopupsDb, tenantId: string, id: string): Promise<number | null> {
  const { data, error } = await db
    .from("site_popups")
    .select("id,tenant_id,audience_kind,audience_criteria,audience_generation,status")
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as (AudiencePopupRow & { audience_kind: string; status: string }) | null;
  if (!row || row.audience_kind !== "filtro" || row.status === "encerrado") return null;
  return refreshPopupAudience(db, row);
}

export type PopupHourlyResult = {
  encerrados: number;
  refreshed: number;
  errors: Array<{ popupId: string; message: string }>;
  truncated: boolean;
};

/**
 * Hourly job: closes popups past their end date, then refreshes the filtro
 * audience of active/paused popups not refreshed in the last ~hour, within a
 * time budget (the rest wait for the next run).
 */
export async function runPopupHourly(
  db: PopupsDb,
  opts: { now: Date; budgetMs?: number; clock?: () => number },
): Promise<PopupHourlyResult> {
  const clock = opts.clock ?? Date.now;
  const started = clock();
  const budget = opts.budgetMs ?? 50_000;
  const nowIso = opts.now.toISOString();

  const { data: closed, error: closeErr } = await db
    .from("site_popups")
    .update({ status: "encerrado", updated_at: nowIso })
    .in("status", ["ativo", "pausado"])
    .lte("ends_at", nowIso)
    .select("id");
  if (closeErr) throw new Error(closeErr.message);

  const { data, error } = await db
    .from("site_popups")
    .select("id,tenant_id,audience_criteria,audience_generation,audience_refreshed_at")
    .in("status", ["ativo", "pausado"])
    .eq("audience_kind", "filtro")
    .order("audience_refreshed_at", { ascending: true, nullsFirst: true });
  if (error) throw new Error(error.message);
  const due = ((data ?? []) as Array<AudiencePopupRow & { audience_refreshed_at: string | null }>).filter(
    (row) =>
      !row.audience_refreshed_at ||
      opts.now.getTime() - Date.parse(row.audience_refreshed_at) >= REFRESH_EVERY_MS,
  );

  const result: PopupHourlyResult = {
    encerrados: (closed ?? []).length,
    refreshed: 0,
    errors: [],
    truncated: false,
  };
  for (const popup of due) {
    if (clock() - started > budget) {
      result.truncated = true;
      break;
    }
    try {
      await refreshPopupAudience(db, popup);
      result.refreshed += 1;
    } catch (err) {
      result.errors.push({ popupId: popup.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
