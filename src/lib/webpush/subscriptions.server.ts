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

// OneSignal subscription ids are UUIDs. The public loader runs on pages we don't
// control; a tampered or buggy caller can send junk (empty string, "undefined",
// a number stringified, garbage over 64 chars) that must never reach a write.
const SUBSCRIPTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SUBSCRIPTION_ID_LENGTH = 64;
const MAX_USER_AGENT_LENGTH = 512;

function isValidSubscriptionId(value: string): boolean {
  return value.length <= MAX_SUBSCRIPTION_ID_LENGTH && SUBSCRIPTION_ID_PATTERN.test(value);
}

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
  if (!isValidSubscriptionId(input.subscriptionId)) return { status: 400 };

  const linkedPlayerId = await resolvePlayerId(db, tenantId, input.playerId);
  const status = input.optedIn ? "ativa" : "inativa";
  const userAgent = input.userAgent ? input.userAgent.slice(0, MAX_USER_AGENT_LENGTH) : input.userAgent;

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
        { status, userAgent, nowIso, linkedPlayerId },
      )
    : await insertOrRelinkSubscription(db, {
        tenantId,
        appId: app.id,
        subscriptionId: input.subscriptionId,
        status,
        userAgent,
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
  // Links or re-links whenever a real player was resolved and it differs
  // from what's currently on the row (design §5.4: "liga (ou religa)").
  // Garbage/unmatched ids resolve to `null` and never reach here, so a
  // previously established link is only ever replaced by another real
  // player, never cleared.
  if (opts.linkedPlayerId && opts.linkedPlayerId !== existing.player_id) {
    patch.player_id = opts.linkedPlayerId;
    patch.linked_at = opts.nowIso;
  }
  const { error } = await db.from("push_subscriptions").update(patch).eq("id", existing.id);
  if (error) throw new Error(error.message);
  return existing.click_key;
}

type InsertSubscriptionOpts = {
  tenantId: string;
  appId: string;
  subscriptionId: string;
  status: string;
  userAgent: string | null;
  nowIso: string;
  linkedPlayerId: string | null;
};

/** PostgREST/Postgres unique-violation error code. */
const UNIQUE_VIOLATION = "23505";

/**
 * Inserts a new `push_subscriptions` row. The caller already checked no row
 * exists for `(app_id, subscription_id)`, but between that select and this
 * insert a concurrent report for the same subscription can land first — the
 * table's `UNIQUE (app_id, subscription_id)` constraint then rejects us with
 * a unique violation (never create a duplicate row for one browser
 * subscription). On that race, falls back to updating the row the other
 * request just created, preserving its original `first_seen_at` (an update
 * never touches that column).
 */
async function insertOrRelinkSubscription(
  db: SubscriptionsDb,
  opts: InsertSubscriptionOpts,
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

  if (!error) return (data as { click_key: string }).click_key;
  if (error.code !== UNIQUE_VIOLATION) throw new Error(error.message);

  const { data: raced, error: racedErr } = await db
    .from("push_subscriptions")
    .select("id,click_key,player_id")
    .eq("app_id", opts.appId)
    .eq("subscription_id", opts.subscriptionId)
    .maybeSingle();
  if (racedErr) throw new Error(racedErr.message);
  if (!raced) {
    throw new Error("push_subscriptions: conflito de chave única sem linha correspondente");
  }
  return updateExistingSubscription(db, raced as ExistingSubscriptionRow, {
    status: opts.status,
    userAgent: opts.userAgent,
    nowIso: opts.nowIso,
    linkedPlayerId: opts.linkedPlayerId,
  });
}
