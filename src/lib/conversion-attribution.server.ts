import { supabaseAdmin } from "@/integrations/supabase/client.server";

type AttributionEvent = {
  tenantId: string;
  playerId: string;
  eventType: "registered" | "login" | "game" | "deposit_approved";
  eventId: string;
  occurredAt: string;
  trackingToken: string | null;
  monetaryValue?: number | null;
  isFtd?: boolean;
};

type Dispatch = {
  id: string;
  source_type: string;
  source_id: string | null;
  recipient_player_id: string | null;
  tracking_token: string;
  sent_at: string | null;
};

function isUuid(value: string | null): value is string {
  return (
    !!value &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

/**
 * Records only deterministic, direct attribution. A follow-up event may reuse
 * the token captured at signup, but it must belong to the same player and fit
 * the frozen seven-day P0 window.
 */
export async function attributeConversionEvent(input: AttributionEvent) {
  if (!isUuid(input.trackingToken)) return { attributed: false as const, reason: "missing_token" };

  const db = supabaseAdmin as any;
  const { data: dispatch, error: dispatchError } = await db
    .from("link_dispatches")
    .select("id,source_type,source_id,recipient_player_id,tracking_token,sent_at")
    .eq("tenant_id", input.tenantId)
    .eq("tracking_token", input.trackingToken)
    .maybeSingle();
  if (dispatchError)
    throw new Error(`Falha ao resolver token de atribuição: ${dispatchError.message}`);
  if (!dispatch) return { attributed: false as const, reason: "token_without_dispatch" };

  const candidate = dispatch as Dispatch;
  if (
    (candidate.source_type !== "campaign" && candidate.source_type !== "journey") ||
    !isUuid(candidate.source_id) ||
    (candidate.recipient_player_id && candidate.recipient_player_id !== input.playerId)
  ) {
    return { attributed: false as const, reason: "invalid_origin_or_player" };
  }
  if (!candidate.sent_at) return { attributed: false as const, reason: "dispatch_not_sent" };

  const sentAt = Date.parse(candidate.sent_at);
  const occurredAt = Date.parse(input.occurredAt);
  if (
    !Number.isFinite(sentAt) ||
    !Number.isFinite(occurredAt) ||
    occurredAt < sentAt ||
    occurredAt > sentAt + 7 * 86_400_000
  ) {
    return { attributed: false as const, reason: "outside_window" };
  }

  const { error: insertError } = await db.from("conversion_attributions").upsert(
    {
      tenant_id: input.tenantId,
      source_type: candidate.source_type,
      source_id: candidate.source_id,
      link_dispatch_id: candidate.id,
      tracking_token: candidate.tracking_token,
      player_id: input.playerId,
      event_type: input.eventType,
      event_id: input.eventId,
      occurred_at: new Date(occurredAt).toISOString(),
      monetary_value: input.monetaryValue ?? null,
      is_ftd: input.isFtd === true,
      attribution_model: "last_tracked_click",
      attribution_window_days: 7,
      classification: "direct",
      evidence: { token_source: "utm_content", dispatch_sent_at: candidate.sent_at },
    },
    {
      onConflict: "tenant_id,event_type,event_id,attribution_model,classification",
      ignoreDuplicates: true,
    },
  );
  if (insertError) throw new Error(`Falha ao gravar atribuição: ${insertError.message}`);
  return {
    attributed: true as const,
    sourceType: candidate.source_type,
    sourceId: candidate.source_id,
  };
}
