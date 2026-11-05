// Web push (OneSignal) — Task 6: per-origin OneSignal apps, activated by the
// super admin. One row in tenant_webpush_apps per (tenant, origin): the
// "api" mode creates the app and its key at OneSignal (ONESIGNAL_ORG_API_KEY
// configured); the "manual" mode stores an app/key the super admin already
// created at OneSignal's dashboard. Either way the key is stored only
// encrypted (encryptProviderCredentials) and never comes back out of this
// module except through loadAppCredentials, which exists to hand it to the
// send path. `db` is always `supabaseAdmin` in production; tests pass
// `createFakeDb().client`.
import { decryptProviderCredentials, encryptProviderCredentials } from "@/lib/secret-box.server";
import { normalizeOrigin, validatePromptConfig, WORKER_PATH, type PromptConfig } from "@/lib/webpush/shared";
import {
  createOneSignalApp,
  createOneSignalAppKey,
  deterministicUuid,
  sendOneSignalPush,
  updateOneSignalAppIcon,
  type OneSignalSendResult,
} from "@/lib/webpush/onesignal.server";
import { checkWorkerFile, type WorkerCheckResult } from "@/lib/webpush/worker-check.server";

/* eslint-disable @typescript-eslint/no-explicit-any -- accepts the admin client or a test double. */
export type WebpushAppDb = { from: (table: string) => any };

export type WebpushAppStatus = "instalando" | "ativo" | "legado" | "desativado";

export type ActivateWebpushOriginInput =
  | { tenantId: string; origin: string; mode: "api" }
  | { tenantId: string; origin: string; mode: "manual"; appId: string; apiKey: string };

/** Public projection of a `tenant_webpush_apps` row — never the API key. */
export type WebpushAppRow = {
  id: string;
  tenantId: string;
  origin: string;
  onesignalAppId: string;
  status: WebpushAppStatus;
  createdVia: "api" | "manual";
  workerVerifiedAt: string | null;
  scriptSeenAt: string | null;
  playerLinkedAt: string | null;
  testSentAt: string | null;
};

type WebpushAppDbRow = {
  id: string;
  tenant_id: string;
  origin: string;
  onesignal_app_id: string;
  status: string;
  created_via: string;
  worker_verified_at: string | null;
  script_seen_at: string | null;
  player_linked_at: string | null;
  test_sent_at: string | null;
};

function toWebpushAppRow(row: WebpushAppDbRow): WebpushAppRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    origin: row.origin,
    onesignalAppId: row.onesignal_app_id,
    status: row.status as WebpushAppStatus,
    createdVia: row.created_via as "api" | "manual",
    workerVerifiedAt: row.worker_verified_at,
    scriptSeenAt: row.script_seen_at,
    playerLinkedAt: row.player_linked_at,
    testSentAt: row.test_sent_at,
  };
}

async function fetchTenantName(db: WebpushAppDb, tenantId: string): Promise<string> {
  const { data, error } = await db.from("tenants").select("nome").eq("id", tenantId).single();
  if (error) throw new Error(error.message);
  return (data as { nome: string }).nome;
}

/** Ensures `tenant_webpush_settings` has a row for the tenant (prompt defaults apply). */
async function ensureWebpushSettingsRow(db: WebpushAppDb, tenantId: string): Promise<void> {
  const { error } = await db
    .from("tenant_webpush_settings")
    .upsert({ tenant_id: tenantId }, { onConflict: "tenant_id", ignoreDuplicates: true });
  if (error) throw new Error(error.message);
}

/**
 * Activates web push for one origin of a house: validates the address,
 * refuses a duplicate (tenant, origin), creates the OneSignal app/key (mode
 * "api") or stores the ones the super admin already created (mode
 * "manual"), and stores the new `tenant_webpush_apps` row with status
 * "instalando". Also ensures the house has a `tenant_webpush_settings` row.
 */
export async function activateWebpushOrigin(
  db: WebpushAppDb,
  input: ActivateWebpushOriginInput,
): Promise<WebpushAppRow> {
  const origin = normalizeOrigin(input.origin);
  if (!origin) throw new Error("Endereço do site inválido");

  const { data: existing, error: existingErr } = await db
    .from("tenant_webpush_apps")
    .select("id")
    .eq("tenant_id", input.tenantId)
    .eq("origin", origin)
    .maybeSingle();
  if (existingErr) throw new Error(existingErr.message);
  if (existing) throw new Error("Este endereço já está ativado");

  await ensureWebpushSettingsRow(db, input.tenantId);

  let onesignalAppId: string;
  let apiKey: string;
  if (input.mode === "api") {
    const siteName = await fetchTenantName(db, input.tenantId);
    const created = await createOneSignalApp({ siteName, origin });
    onesignalAppId = created.appId;
    apiKey = (await createOneSignalAppKey(onesignalAppId)).apiKey;
  } else {
    onesignalAppId = input.appId;
    apiKey = input.apiKey;
  }

  const apiKeyEncrypted = await encryptProviderCredentials({ apiKey });

  const { data: inserted, error: insertErr } = await db
    .from("tenant_webpush_apps")
    .insert({
      tenant_id: input.tenantId,
      origin,
      onesignal_app_id: onesignalAppId,
      api_key_encrypted: apiKeyEncrypted,
      created_via: input.mode,
      status: "instalando",
    })
    .select(
      "id,tenant_id,origin,onesignal_app_id,status,created_via,worker_verified_at,script_seen_at,player_linked_at,test_sent_at",
    )
    .single();
  if (insertErr) throw new Error(insertErr.message);

  return toWebpushAppRow(inserted as WebpushAppDbRow);
}

/**
 * Updates a house's webpush app row to a new status. Scoped to `tenantId` so
 * one house can never touch another's app row.
 */
export async function setWebpushAppStatus(
  db: WebpushAppDb,
  input: { tenantId: string; appRowId: string; status: WebpushAppStatus },
): Promise<void> {
  const { data, error } = await db
    .from("tenant_webpush_apps")
    .update({ status: input.status })
    .eq("id", input.appRowId)
    .eq("tenant_id", input.tenantId)
    .select("id");
  if (error) throw new Error(error.message);
  if (!data || (data as unknown[]).length === 0) {
    throw new Error("App não encontrada para esta casa");
  }
}

/** Decrypts and returns the OneSignal app id + API key for a `tenant_webpush_apps` row. */
export async function loadAppCredentials(
  db: WebpushAppDb,
  appRowId: string,
): Promise<{ appId: string; apiKey: string }> {
  const { data, error } = await db
    .from("tenant_webpush_apps")
    .select("onesignal_app_id,api_key_encrypted")
    .eq("id", appRowId)
    .single();
  if (error) throw new Error(error.message);
  const row = data as { onesignal_app_id: string; api_key_encrypted: string };
  const credentials = await decryptProviderCredentials(row.api_key_encrypted);
  return { appId: row.onesignal_app_id, apiKey: credentials.apiKey };
}

// ============================================================================
// Task 7: integration state, prompt settings, worker check and test push.
// ============================================================================

const DEFAULT_PROMPT: PromptConfig = {
  promptText: "Quer receber promoções e avisos da casa?",
  acceptLabel: "Permitir",
  cancelLabel: "Agora não",
  iconUrl: null,
};

export const WEBPUSH_PLAYER_SNIPPET =
  '<script>window.betleads = { playerId: "ID_DO_JOGADOR" };</script>';

type WebpushSettingsRow = {
  public_token: string;
  prompt_text: string;
  accept_label: string;
  cancel_label: string;
  icon_url: string | null;
};

async function fetchWebpushSettings(
  db: WebpushAppDb,
  tenantId: string,
): Promise<{ publicToken: string; prompt: PromptConfig } | null> {
  const { data, error } = await db
    .from("tenant_webpush_settings")
    .select("public_token,prompt_text,accept_label,cancel_label,icon_url")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const row = data as WebpushSettingsRow;
  return {
    publicToken: row.public_token,
    prompt: {
      promptText: row.prompt_text,
      acceptLabel: row.accept_label,
      cancelLabel: row.cancel_label,
      iconUrl: row.icon_url,
    },
  };
}

async function fetchWebpushAppsWithCreatedAt(
  db: WebpushAppDb,
  tenantId: string,
): Promise<Array<WebpushAppDbRow & { created_at: string }>> {
  const { data, error } = await db
    .from("tenant_webpush_apps")
    .select(
      "id,tenant_id,origin,onesignal_app_id,status,created_via,worker_verified_at,script_seen_at,player_linked_at,test_sent_at,created_at",
    )
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as Array<WebpushAppDbRow & { created_at: string }>;
}

async function fetchSubscriptionCounts(
  db: WebpushAppDb,
  appIds: string[],
): Promise<Map<string, { active: number; identified: number }>> {
  const counts = new Map<string, { active: number; identified: number }>();
  if (appIds.length === 0) return counts;
  const { data, error } = await db
    .from("push_subscriptions")
    .select("app_id,player_id")
    .in("app_id", appIds)
    .eq("status", "ativa");
  if (error) throw new Error(error.message);
  for (const row of (data ?? []) as Array<{ app_id: string; player_id: string | null }>) {
    const entry = counts.get(row.app_id) ?? { active: 0, identified: 0 };
    entry.active += 1;
    if (row.player_id) entry.identified += 1;
    counts.set(row.app_id, entry);
  }
  return counts;
}

/** `${PUBLIC_APP_URL}/api/public/push/loader.js?t=${publicToken}`, matching
 * the base-url pattern used elsewhere (e.g. `invite-email.server.ts`). */
function buildLoaderSnippet(publicToken: string): string {
  const base = (process.env.PUBLIC_APP_URL ?? "https://betleads.io").replace(/\/$/, "");
  return `<script src="${base}/api/public/push/loader.js?t=${publicToken}" async></script>`;
}

export type WebpushIntegrationApp = WebpushAppRow & {
  workerUrl: string;
  activeSubscriptions: number;
  identifiedSubscriptions: number;
};

export type WebpushIntegrationState = {
  enabled: boolean;
  loaderSnippet: string;
  playerSnippet: string;
  prompt: PromptConfig;
  apps: WebpushIntegrationApp[];
  current: WebpushAppRow | null;
};

/**
 * Builds the house's web push integration screen state: the installed apps
 * (one per origin, each with its worker URL and subscription counts), the
 * "current" app driving the activation flow (most recently created app whose
 * status is still `instalando` or `ativo` — a `legado` or `desativado` app
 * never counts as current, even if it's the newest row), the loader/player
 * snippets and the prompt copy. `enabled` is true only once there is a
 * current app — with no app at all (or only legado/desativado ones) the
 * house hasn't finished activating web push yet.
 */
export async function getWebpushIntegrationState(
  db: WebpushAppDb,
  tenantId: string,
): Promise<WebpushIntegrationState> {
  const [settings, appRows] = await Promise.all([
    fetchWebpushSettings(db, tenantId),
    fetchWebpushAppsWithCreatedAt(db, tenantId),
  ]);

  const counts = await fetchSubscriptionCounts(
    db,
    appRows.map((row) => row.id),
  );

  const apps: WebpushIntegrationApp[] = appRows.map((row) => {
    const appRow = toWebpushAppRow(row);
    const count = counts.get(row.id) ?? { active: 0, identified: 0 };
    return {
      ...appRow,
      workerUrl: `${appRow.origin}${WORKER_PATH}`,
      activeSubscriptions: count.active,
      identifiedSubscriptions: count.identified,
    };
  });

  // Rows come back oldest-first; the last match in that order is the most
  // recently created app still in `instalando`/`ativo`.
  const currentSource = [...appRows]
    .reverse()
    .find((row) => row.status === "instalando" || row.status === "ativo");
  const current = currentSource ? toWebpushAppRow(currentSource) : null;

  return {
    enabled: current !== null,
    loaderSnippet: settings ? buildLoaderSnippet(settings.publicToken) : "",
    playerSnippet: WEBPUSH_PLAYER_SNIPPET,
    prompt: settings?.prompt ?? DEFAULT_PROMPT,
    apps,
    current,
  };
}

/**
 * Fetches `origin + WORKER_PATH` for the house's app row and, if the file is
 * there with the right content, records `worker_verified_at`. Scoped to
 * `tenantId` so one house can never probe another's app row.
 */
export async function verifyWebpushWorker(
  db: WebpushAppDb,
  input: { tenantId: string; appRowId: string },
): Promise<WorkerCheckResult> {
  const { data, error } = await db
    .from("tenant_webpush_apps")
    .select("id,origin")
    .eq("id", input.appRowId)
    .eq("tenant_id", input.tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("App não encontrada para esta casa");
  const row = data as { id: string; origin: string };

  const result = await checkWorkerFile(row.origin);
  if (result.ok) {
    const { error: updateErr } = await db
      .from("tenant_webpush_apps")
      .update({ worker_verified_at: new Date().toISOString() })
      .eq("id", row.id);
    if (updateErr) throw new Error(updateErr.message);
  }
  return result;
}

/**
 * Validates and saves the house's push prompt copy. When the icon actually
 * changes, pushes the new icon to every OneSignal app created via "api"
 * that's still `instalando`/`ativo` (a "manual" app was set up by hand at
 * OneSignal's dashboard — its icon isn't ours to touch).
 */
export async function saveWebpushPrompt(
  db: WebpushAppDb,
  input: { tenantId: string } & Parameters<typeof validatePromptConfig>[0],
): Promise<PromptConfig> {
  const validated = validatePromptConfig(input);

  const { data: before, error: beforeErr } = await db
    .from("tenant_webpush_settings")
    .select("icon_url")
    .eq("tenant_id", input.tenantId)
    .maybeSingle();
  if (beforeErr) throw new Error(beforeErr.message);
  const previousIconUrl = (before as { icon_url: string | null } | null)?.icon_url ?? null;

  const { error } = await db.from("tenant_webpush_settings").upsert(
    {
      tenant_id: input.tenantId,
      prompt_text: validated.promptText,
      accept_label: validated.acceptLabel,
      cancel_label: validated.cancelLabel,
      icon_url: validated.iconUrl,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "tenant_id" },
  );
  if (error) throw new Error(error.message);

  if (validated.iconUrl && validated.iconUrl !== previousIconUrl) {
    const { data: appRows, error: appsErr } = await db
      .from("tenant_webpush_apps")
      .select("id,onesignal_app_id,status,created_via")
      .eq("tenant_id", input.tenantId)
      .eq("created_via", "api")
      .in("status", ["instalando", "ativo"]);
    if (appsErr) throw new Error(appsErr.message);
    for (const row of (appRows ?? []) as Array<{ onesignal_app_id: string }>) {
      await updateOneSignalAppIcon(row.onesignal_app_id, validated.iconUrl);
    }
  }

  return validated;
}

export type RecentWebpushSubscription = {
  id: string;
  createdAt: string | null;
  userAgent: string | null;
  playerLinked: boolean;
};

/** Last 10 active subscriptions of a house's app row, newest first. */
export async function listRecentWebpushSubscriptions(
  db: WebpushAppDb,
  input: { tenantId: string; appRowId: string },
): Promise<RecentWebpushSubscription[]> {
  const { data: appData, error: appErr } = await db
    .from("tenant_webpush_apps")
    .select("id")
    .eq("id", input.appRowId)
    .eq("tenant_id", input.tenantId)
    .maybeSingle();
  if (appErr) throw new Error(appErr.message);
  if (!appData) throw new Error("App não encontrada para esta casa");

  const { data, error } = await db
    .from("push_subscriptions")
    .select("id,user_agent,first_seen_at,player_id")
    .eq("app_id", input.appRowId)
    .eq("tenant_id", input.tenantId)
    .eq("status", "ativa")
    .order("first_seen_at", { ascending: false })
    .limit(10);
  if (error) throw new Error(error.message);

  return (
    (data ?? []) as Array<{
      id: string;
      user_agent: string | null;
      first_seen_at: string | null;
      player_id: string | null;
    }>
  ).map((row) => ({
    id: row.id,
    createdAt: row.first_seen_at,
    userAgent: row.user_agent,
    playerLinked: row.player_id !== null,
  }));
}

/**
 * Sends a test push to one of the house's own subscriptions: "Teste da
 * Betleads" / "Se você está vendo isto, o push da casa está funcionando.",
 * linking to the app's origin. Never charges the wallet (`reserveUsage` is
 * never called here — this is a diagnostic send, not a campaign). On a
 * successful send, marks the app row `test_sent_at` and flips its status to
 * `ativo` (the house has now proven the whole pipeline works end to end).
 * Scoped to `tenantId`: a subscription row from another house is reported the
 * same as one that doesn't exist.
 */
export async function sendWebpushTest(
  db: WebpushAppDb,
  input: { tenantId: string; subscriptionRowId: string },
): Promise<OneSignalSendResult> {
  const { data: subData, error: subErr } = await db
    .from("push_subscriptions")
    .select("id,app_id,subscription_id")
    .eq("id", input.subscriptionRowId)
    .eq("tenant_id", input.tenantId)
    .maybeSingle();
  if (subErr) throw new Error(subErr.message);
  if (!subData) throw new Error("Inscrição não encontrada");
  const subscription = subData as { id: string; app_id: string; subscription_id: string };

  const { data: appData, error: appErr } = await db
    .from("tenant_webpush_apps")
    .select("id,origin,status")
    .eq("id", subscription.app_id)
    .eq("tenant_id", input.tenantId)
    .maybeSingle();
  if (appErr) throw new Error(appErr.message);
  if (!appData) throw new Error("Inscrição não encontrada");
  const app = appData as { id: string; origin: string; status: string };
  // A deactivated or superseded app has no business sending a test push —
  // refuse before ever calling OneSignal.
  if (app.status === "desativado" || app.status === "legado") {
    throw new Error("Este domínio não está ativo");
  }

  const { appId, apiKey } = await loadAppCredentials(db, app.id);
  const idempotencyKey = await deterministicUuid(`webpush-test:${subscription.id}:${Date.now()}`);

  const result = await sendOneSignalPush({
    appId,
    apiKey,
    subscriptionIds: [subscription.subscription_id],
    title: "Teste da Betleads",
    body: "Se você está vendo isto, o push da casa está funcionando.",
    url: app.origin,
    idempotencyKey,
  });

  // OneSignal can answer 200 ok and still refuse every id it was given
  // (errors.invalid_player_ids covering the one subscription we sent, or the
  // "All included players are not subscribed" array form) — that is not a
  // successful test: no test_sent_at, no promotion, and a message that tells
  // the house its subscription has gone stale rather than claiming success.
  if (result.ok && result.invalidSubscriptionIds.length > 0) {
    return { ok: false, temporary: false, status: 200, error: "A inscrição não está mais ativa" };
  }

  if (result.ok) {
    // Promote only an app still being set up (`instalando`); an already-`ativo`
    // app keeps its status untouched — this is a re-verification, not a re-activation.
    const patch: Record<string, unknown> = { test_sent_at: new Date().toISOString() };
    if (app.status === "instalando") patch.status = "ativo";
    const { error: updateErr } = await db.from("tenant_webpush_apps").update(patch).eq("id", app.id);
    if (updateErr) throw new Error(updateErr.message);
  }

  return result;
}
