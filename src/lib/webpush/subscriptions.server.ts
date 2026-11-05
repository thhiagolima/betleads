// Web push (OneSignal) — Task 8: records a browser subscription reported by
// the public loader script. `db` follows the WebpushAppDb pattern from
// apps.server.ts so tests use createFakeDb() from sms-bulk.test-support.
//
// Security: this is reached from a public, unauthenticated endpoint.
// - A token with no tenant → 404.
// - An origin that doesn't match one of the tenant's `instalando`/`ativo`
//   apps → 403 (never trust the caller's claimed origin otherwise).
// - `playerId` is cleaned (`cleanPlayerId`) before ever being looked up;
//   garbage or unmatched ids leave the subscription anonymous and never
//   create a player row.
import { randomBytes } from "node:crypto";

import { cleanPlayerId, normalizeOrigin } from "@/lib/webpush/shared";

/* eslint-disable @typescript-eslint/no-explicit-any -- accepts the admin client or a test double. */
export type SubscriptionsDb = { from: (table: string) => any };

export type RecordSubscriptionInput = {
  token: string;
  origin: string | null;
  subscriptionId: string | null;
  optedIn: boolean;
  playerId: unknown;
  userAgent: string | null;
  now: Date;
};

export type RecordSubscriptionResult =
  | { status: 200; clickKey: string | null }
  | { status: 403 | 404 | 400 };

type AppRow = {
  id: string;
  status: string;
  script_seen_at: string | null;
  player_linked_at: string | null;
};

type ExistingSubscriptionRow = {
  id: string;
  click_key: string;
  player_id: string | null;
};

const INSTALLABLE_STATUSES = new Set(["instalando", "ativo"]);

/**
 * Validates the token → tenant, the origin → app (must be `instalando` or
 * `ativo`), records `script_seen_at` on first contact, and — when a
 * `subscriptionId` is present — upserts the `push_subscriptions` row by
 * `(app_id, subscription_id)`, linking a matched player id without ever
 * unsetting a previously established link.
 */
export async function recordSubscription(
  db: SubscriptionsDb,
  input: RecordSubscriptionInput,
): Promise<RecordSubscriptionResult> {
  if (!input.token) return { status: 400 };

  const { data: settingsData, error: settingsErr } = await db
    .from("tenant_webpush_settings")
    .select("tenant_id")
    .eq("public_token", input.token)
    .maybeSingle();
  if (settingsErr) throw new Error(settingsErr.message);
  if (!settingsData) return { status: 404 };
  const tenantId = (settingsData as { tenant_id: string }).tenant_id;

  const normalizedOrigin = input.origin ? normalizeOrigin(input.origin) : null;
  if (!normalizedOrigin) return { status: 403 };

  const { data: appData, error: appErr } = await db
    .from("tenant_webpush_apps")
    .select("id,status,script_seen_at,player_linked_at")
    .eq("tenant_id", tenantId)
    .eq("origin", normalizedOrigin)
    .maybeSingle();
  if (appErr) throw new Error(appErr.message);
  if (!appData) return { status: 403 };
  const app = appData as AppRow;
  if (!INSTALLABLE_STATUSES.has(app.status)) return { status: 403 };

  const nowIso = input.now.toISOString();

  if (!app.script_seen_at) {
    const { error } = await db
      .from("tenant_webpush_apps")
      .update({ script_seen_at: nowIso })
      .eq("id", app.id);
    if (error) throw new Error(error.message);
  }

  if (!input.subscriptionId) return { status: 200, clickKey: null };

  const linkedPlayerId = await resolvePlayerId(db, tenantId, input.playerId);
  const status = input.optedIn ? "ativa" : "inativa";

  const { data: existingData, error: existingErr } = await db
    .from("push_subscriptions")
    .select("id,click_key,player_id")
    .eq("app_id", app.id)
    .eq("subscription_id", input.subscriptionId)
    .maybeSingle();
  if (existingErr) throw new Error(existingErr.message);

  const clickKey = existingData
    ? await updateExistingSubscription(
        db,
        existingData as ExistingSubscriptionRow,
        { status, userAgent: input.userAgent, nowIso, linkedPlayerId },
      )
    : await insertSubscription(db, {
        tenantId,
        appId: app.id,
        subscriptionId: input.subscriptionId,
        status,
        userAgent: input.userAgent,
        nowIso,
        linkedPlayerId,
      });

  if (linkedPlayerId && !app.player_linked_at) {
    const { error } = await db
      .from("tenant_webpush_apps")
      .update({ player_linked_at: nowIso })
      .eq("id", app.id);
    if (error) throw new Error(error.message);
  }

  return { status: 200, clickKey };
}

/** Cleans `playerId` and looks up the matching player; never creates one. */
async function resolvePlayerId(
  db: SubscriptionsDb,
  tenantId: string,
  rawPlayerId: unknown,
): Promise<string | null> {
  const cleaned = cleanPlayerId(rawPlayerId);
  if (!cleaned) return null;

  const { data, error } = await db
    .from("players")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("player_external_id", cleaned)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? (data as { id: string }).id : null;
}

async function updateExistingSubscription(
  db: SubscriptionsDb,
  existing: ExistingSubscriptionRow,
  opts: { status: string; userAgent: string | null; nowIso: string; linkedPlayerId: string | null },
): Promise<string> {
  const patch: Record<string, unknown> = {
    last_seen_at: opts.nowIso,
    user_agent: opts.userAgent,
    status: opts.status,
  };
  // Only ever establishes a link that wasn't there before — never overwrites
  // or clears one that already exists.
  if (opts.linkedPlayerId && !existing.player_id) {
    patch.player_id = opts.linkedPlayerId;
    patch.linked_at = opts.nowIso;
  }
  const { error } = await db.from("push_subscriptions").update(patch).eq("id", existing.id);
  if (error) throw new Error(error.message);
  return existing.click_key;
}

async function insertSubscription(
  db: SubscriptionsDb,
  opts: {
    tenantId: string;
    appId: string;
    subscriptionId: string;
    status: string;
    userAgent: string | null;
    nowIso: string;
    linkedPlayerId: string | null;
  },
): Promise<string> {
  const clickKey = randomBytes(16).toString("hex");
  const { data, error } = await db
    .from("push_subscriptions")
    .insert({
      tenant_id: opts.tenantId,
      app_id: opts.appId,
      subscription_id: opts.subscriptionId,
      click_key: clickKey,
      status: opts.status,
      user_agent: opts.userAgent,
      first_seen_at: opts.nowIso,
      last_seen_at: opts.nowIso,
      player_id: opts.linkedPlayerId,
      linked_at: opts.linkedPlayerId ? opts.nowIso : null,
    })
    .select("click_key")
    .single();
  if (error) throw new Error(error.message);
  return (data as { click_key: string }).click_key;
}
