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
import { normalizeOrigin } from "@/lib/webpush/shared";
import { createOneSignalApp, createOneSignalAppKey } from "@/lib/webpush/onesignal.server";

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
