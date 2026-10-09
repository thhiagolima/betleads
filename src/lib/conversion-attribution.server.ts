import { supabaseAdmin } from "@/integrations/supabase/client.server";

type AttributionEvent = {
  tenantId: string;
  playerId: string;
  eventType: "registered" | "login" | "game" | "deposit_approved";
  eventId: string;
  occurredAt: string;
  trackingToken: string | null;
  touchAt?: string | null;
  tokenSource?: "bl_click_id" | "utm_content" | "player";
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
  return !!value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function resolveAttributionWindow(
  sentAtValue: string,
  occurredAtValue: string,
  touchAtValue?: string | null,
) {
  const sentAt = Date.parse(sentAtValue);
  const occurredAt = Date.parse(occurredAtValue);
  if (!Number.isFinite(sentAt) || !Number.isFinite(occurredAt) || occurredAt < sentAt) return null;

  const suppliedTouchAt = touchAtValue ? Date.parse(touchAtValue) : Number.NaN;
  const hasValidTouchAt =
    Number.isFinite(suppliedTouchAt) && suppliedTouchAt >= sentAt && suppliedTouchAt <= occurredAt;
  const windowStartedAt = hasValidTouchAt ? suppliedTouchAt : sentAt;
  if (occurredAt > windowStartedAt + 14 * 86_400_000) return null;

  return {
    classification:
      occurredAt <= windowStartedAt + 7 * 86_400_000 ? ("direct" as const) : ("assisted" as const),
    windowStartedAt: new Date(windowStartedAt).toISOString(),
    anchor: hasValidTouchAt ? ("click_captured_at" as const) : ("sent_at" as const),
  };
}

/**
 * Records only deterministic, direct attribution. A follow-up event may reuse
 * the token captured at signup, but it must belong to the same player and fit
 * the frozen seven-day P0 window. Events from day 8 to day 14 are retained
 * separately as assisted, never added to direct revenue.
 */
export async function attributeConversionEvent(input: AttributionEvent) {
  const db = supabaseAdmin as any;
  const reject = async (
    reason:
      "missing_token" | "token_without_dispatch" | "invalid_origin_or_player" | "dispatch_not_sent",
    dispatch?: Dispatch | null,
  ) => {
    const { error } = await db.from("conversion_attribution_issues").upsert(
      {
        tenant_id: input.tenantId,
        event_type: input.eventType,
        event_id: input.eventId,
        reason,
        source_type: dispatch?.source_type ?? null,
        source_id: isUuid(dispatch?.source_id ?? null) ? dispatch!.source_id : null,
      },
      { onConflict: "tenant_id,event_type,event_id,reason", ignoreDuplicates: true },
    );
    if (error) console.error("Falha ao registrar alerta de atribuição", error.message);
    return { attributed: false as const, reason };
  };
  if (!isUuid(input.trackingToken)) return reject("missing_token");
  const { data: dispatch, error: dispatchError } = await db
    .from("link_dispatches")
    .select("id,source_type,source_id,recipient_player_id,tracking_token,sent_at")
    .eq("tenant_id", input.tenantId)
    .eq("tracking_token", input.trackingToken)
    .maybeSingle();
  if (dispatchError)
    throw new Error(`Falha ao resolver token de atribuição: ${dispatchError.message}`);
  if (!dispatch) return reject("token_without_dispatch");

  const candidate = dispatch as Dispatch;
  if (
    (candidate.source_type !== "campaign" && candidate.source_type !== "journey") ||
    !isUuid(candidate.source_id) ||
    (candidate.recipient_player_id && candidate.recipient_player_id !== input.playerId)
  ) {
    return reject("invalid_origin_or_player", candidate);
  }
  if (!candidate.sent_at) return reject("dispatch_not_sent", candidate);

  const window = resolveAttributionWindow(candidate.sent_at, input.occurredAt, input.touchAt);
  if (!window) return { attributed: false as const, reason: "outside_window" };
  const occurredAt = Date.parse(input.occurredAt);
  const { classification, windowStartedAt, anchor } = window;
  const attributionModel =
    classification === "direct" ? "last_tracked_click" : "last_tracked_click_assisted";
  if (anchor === "click_captured_at") {
    const { error: touchError } = await db
      .from("link_dispatches")
      .update({ landing_captured_at: windowStartedAt })
      .eq("tenant_id", input.tenantId)
      .eq("id", candidate.id);
    if (touchError) throw new Error(`Falha ao gravar instante do clique: ${touchError.message}`);
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
      attribution_model: attributionModel,
      attribution_window_days: classification === "direct" ? 7 : 14,
      window_started_at: windowStartedAt,
      attribution_window_anchor: anchor,
      classification,
      evidence: {
        token_source: input.tokenSource ?? "bl_click_id",
        dispatch_sent_at: candidate.sent_at,
        supplied_touch_at: input.touchAt ?? null,
      },
    },
    {
      onConflict: "tenant_id,event_type,event_id,attribution_model,classification",
      ignoreDuplicates: true,
    },
  );
  if (insertError) throw new Error(`Falha ao gravar atribuição: ${insertError.message}`);
  return {
    attributed: true as const,
    classification,
    sourceType: candidate.source_type,
    sourceId: candidate.source_id,
  };
}
