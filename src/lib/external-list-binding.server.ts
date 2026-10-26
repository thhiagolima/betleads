// Binds tracked links sent to an external phone list (SMS campaigns to numbers
// that were not players) to the player that registers with that phone. After
// the bind, the regular first-party click attribution — keyed by
// `link_dispatches.recipient_player_id` — credits the campaign that brought the
// registration, and its later login/FTD/deposits, like any player campaign.
import type { SupabaseClient } from "@supabase/supabase-js";
import { externalRecipientHash } from "./campaign-external-list";
import { normalizeBrazilianPhone } from "./phone-normalization";

/** Older dispatches cannot be credited anyway (14-day click window). */
const BIND_LOOKBACK_DAYS = 30;

export async function bindExternalListDispatches(
  sb: SupabaseClient,
  args: { tenantId: string; playerId: string; phone: string | null; now?: Date },
): Promise<number> {
  const phone = normalizeBrazilianPhone(args.phone);
  if (!phone) return 0;
  const hash = await externalRecipientHash(args.tenantId, phone);
  const since = new Date(
    (args.now ?? new Date()).getTime() - BIND_LOOKBACK_DAYS * 86_400_000,
  ).toISOString();
  const { data, error } = await sb
    .from("link_dispatches")
    .update({ recipient_player_id: args.playerId })
    .eq("tenant_id", args.tenantId)
    .eq("recipient_hash", hash)
    .eq("source_type", "campaign")
    .is("recipient_player_id", null)
    .gte("created_at", since)
    .select("id");
  if (error) throw new Error(`Falha ao vincular links da lista externa: ${error.message}`);
  return Array.isArray(data) ? data.length : 0;
}
