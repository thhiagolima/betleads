// Pix gateway credentials (Upper, SpacePay) and the active provider, read from
// the database (supabase/migrations/20261227100100_payment_gateway_accounts.sql)
// with the env vars used before as fallback.
//
// Rules:
//   * A payment_gateway_accounts row for a provider wins entirely: no
//     field-by-field mixing with env.
//   * Without a row (or when the row can't be read/decrypted) the env vars of
//     today are used; the env config is "none" when a required one is missing.
//   * Active provider: payment_gateway_settings row > BILLING_PIX_PROVIDER > "upper".
//   * The getters never throw and never log a secret; DB/decrypt failures are
//     logged (error name only for decrypt) and fall back to env.
//   * In-process cache of 30 s, dropped by the write helpers.
//
// Storage: secret-box only round-trips flat string records, so the decrypted
// JSON is flat (payer fields as payerName/payerDocument/payerEmail/payerPhone,
// null optionals omitted); toStored/fromStored convert to the public shapes.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptProviderCredentials, encryptProviderCredentials } from "@/lib/secret-box.server";

import type { PixProvider } from "./pix-gateway-error";

export type UpperConfig = { apiKey: string; webhookSecret: string | null; apiBase: string | null };
export type SpacePayConfig = {
  gatewayToken: string;
  casinoToken: string | null;
  /**
   * X-Platform-Id header value (from SpacePay's /create_gateway_token; an
   * identifier, not a secret). Optional: null sends the gateway token itself.
   */
  platformId: string | null;
  callbackSecret: string;
  apiBase: string | null;
  payer: { name: string; document: string; email: string; phone: string };
};
export type GatewayConfigSource = "database" | "env" | "none";
export type Loaded<T> = { source: GatewayConfigSource; config: T | null };

type GatewayConfig = UpperConfig | SpacePayConfig;

const PROVIDERS: PixProvider[] = ["upper", "spacepay"];
const CACHE_TTL_MS = 30_000;
const LOG_PREFIX = "[payment-gateway-config]";

function isPixProvider(value: unknown): value is PixProvider {
  return value === "upper" || value === "spacepay";
}

function clean(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || null;
}

function env(name: string): string | null {
  return clean(process.env[name]);
}

// ---------------------------------------------------------------------------
// Env fallback (exactly the vars read before this table existed)

function envUpperConfig(): UpperConfig | null {
  const apiKey = env("UPPER_API_KEY");
  if (!apiKey) return null;
  return { apiKey, webhookSecret: env("UPPER_WEBHOOK_SECRET"), apiBase: env("UPPER_API_BASE") };
}

function envSpacePayConfig(): SpacePayConfig | null {
  const gatewayToken = env("SPACEPAY_GATEWAY_TOKEN");
  const callbackSecret = env("SPACEPAY_CALLBACK_SECRET");
  const name = env("SPACEPAY_PAYER_NAME");
  const document = env("SPACEPAY_PAYER_DOCUMENT");
  const email = env("SPACEPAY_PAYER_EMAIL");
  const phone = env("SPACEPAY_PAYER_PHONE");
  if (!gatewayToken || !callbackSecret || !name || !document || !email || !phone) return null;
  return {
    gatewayToken,
    casinoToken: env("SPACEPAY_CASINO_TOKEN"),
    platformId: env("SPACEPAY_PLATFORM_ID"),
    callbackSecret,
    apiBase: env("SPACEPAY_API_BASE"),
    payer: { name, document, email, phone },
  };
}

function envConfig(provider: PixProvider): GatewayConfig | null {
  return provider === "upper" ? envUpperConfig() : envSpacePayConfig();
}

// ---------------------------------------------------------------------------
// Stored (flat) form <-> public shapes

function toStored(provider: PixProvider, creds: GatewayConfig): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (key: string, value: string | null | undefined) => {
    const v = clean(value);
    if (v) out[key] = v;
  };
  if (provider === "upper") {
    const c = creds as UpperConfig;
    put("apiKey", c.apiKey);
    put("webhookSecret", c.webhookSecret);
    put("apiBase", c.apiBase);
  } else {
    const c = creds as SpacePayConfig;
    put("gatewayToken", c.gatewayToken);
    put("casinoToken", c.casinoToken);
    put("platformId", c.platformId);
    put("callbackSecret", c.callbackSecret);
    put("apiBase", c.apiBase);
    put("payerName", c.payer?.name);
    put("payerDocument", c.payer?.document);
    put("payerEmail", c.payer?.email);
    put("payerPhone", c.payer?.phone);
  }
  return out;
}

/** null when a required field is missing (treated like an unreadable row). */
function fromStored(provider: PixProvider, stored: Record<string, string>): GatewayConfig | null {
  const get = (key: string) => clean(stored[key]);
  if (provider === "upper") {
    const apiKey = get("apiKey");
    if (!apiKey) return null;
    return { apiKey, webhookSecret: get("webhookSecret"), apiBase: get("apiBase") };
  }
  const gatewayToken = get("gatewayToken");
  const callbackSecret = get("callbackSecret");
  const name = get("payerName");
  const document = get("payerDocument");
  const email = get("payerEmail");
  const phone = get("payerPhone");
  if (!gatewayToken || !callbackSecret || !name || !document || !email || !phone) return null;
  return {
    gatewayToken,
    casinoToken: get("casinoToken"),
    // Rows saved before platformId existed simply lack it (null).
    platformId: get("platformId"),
    callbackSecret,
    apiBase: get("apiBase"),
    payer: { name, document, email, phone },
  };
}

// ---------------------------------------------------------------------------
// Masked hints (the only thing about credentials that leaves the server)

/** Secret/token: first 4 and last 4 only; short values are fully masked. */
export function maskSecret(value: string): string {
  return value.length < 12 ? "••••" : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** CPF → ***.548.349-**, CNPJ → **.345.678/0001-**; anything else fully masked. */
export function maskDocument(value: string): string {
  const d = value.replace(/\D/g, "");
  if (d.length === 11) return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
  if (d.length === 14) return `**.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-**`;
  return "••••";
}

function maskEmail(value: string): string {
  const at = value.lastIndexOf("@");
  if (at < 1) return "••••";
  return `${value.slice(0, Math.min(2, at))}•••${value.slice(at)}`;
}

function maskPhone(value: string): string {
  const d = value.replace(/\D/g, "");
  return d.length <= 4 ? "••••" : `••••${d.slice(-4)}`;
}

function buildHints(provider: PixProvider, creds: GatewayConfig): Record<string, string> {
  const hints: Record<string, string> = {};
  if (provider === "upper") {
    const c = creds as UpperConfig;
    hints.apiKey = maskSecret(c.apiKey);
    if (c.webhookSecret) hints.webhookSecret = maskSecret(c.webhookSecret);
    if (c.apiBase) hints.apiBase = c.apiBase;
    return hints;
  }
  const c = creds as SpacePayConfig;
  hints.gatewayToken = maskSecret(c.gatewayToken);
  if (c.casinoToken) hints.casinoToken = maskSecret(c.casinoToken);
  // An identifier, not a secret: shown in clear (nothing when unset).
  if (c.platformId) hints.platformId = c.platformId;
  hints.callbackSecret = maskSecret(c.callbackSecret);
  if (c.apiBase) hints.apiBase = c.apiBase;
  hints.payerName = c.payer.name;
  hints.payerDocument = maskDocument(c.payer.document);
  hints.payerEmail = maskEmail(c.payer.email);
  hints.payerPhone = maskPhone(c.payer.phone);
  return hints;
}

// ---------------------------------------------------------------------------
// Database snapshot + cache

type DbAccount = {
  /** null = the row exists but couldn't be decrypted/parsed (env is used). */
  config: GatewayConfig | null;
  updatedAt: string | null;
  /**
   * The callback/webhook secret replaced by the last save, still accepted for
   * PREVIOUS_SECRET_GRACE_MS: SpacePay rolls back a "paid" whose callback we
   * reject, so a callback URL signed before a rotation must keep working.
   */
  previousSecret: string | null;
  previousSecretUntil: string | null;
};

const PREVIOUS_SECRET_GRACE_MS = 24 * 60 * 60_000;
const PREVIOUS_SECRET_KEY = "previousSecret";
const PREVIOUS_SECRET_UNTIL_KEY = "previousSecretUntil";

function currentSecretOf(provider: PixProvider, config: GatewayConfig | null): string | null {
  if (!config) return null;
  return provider === "upper"
    ? clean((config as UpperConfig).webhookSecret)
    : clean((config as SpacePayConfig).callbackSecret);
}

function previousSecretFrom(
  stored: Record<string, string>,
  nowMs: number,
): { secret: string; until: string } | null {
  const until = stored[PREVIOUS_SECRET_UNTIL_KEY] ?? "";
  const untilMs = Date.parse(until);
  const secret = clean(stored[PREVIOUS_SECRET_KEY]);
  if (!secret || !Number.isFinite(untilMs) || untilMs <= nowMs) return null;
  return { secret, until };
}

type Snapshot = {
  accounts: Partial<Record<PixProvider, DbAccount>>;
  activeProvider: PixProvider | null;
};

let cache: { at: number; promise: Promise<Snapshot> } | null = null;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

async function loadSnapshot(): Promise<{ snapshot: Snapshot; complete: boolean }> {
  const snapshot: Snapshot = { accounts: {}, activeProvider: null };
  let complete = true;

  try {
    const { data, error } = await supabaseAdmin
      .from("payment_gateway_accounts")
      .select("provider, credentials_encrypted, updated_at");
    if (error) throw new Error(error.message);
    for (const row of data ?? []) {
      if (!isPixProvider(row.provider)) continue;
      let config: GatewayConfig | null = null;
      let previous: { secret: string; until: string } | null = null;
      try {
        const stored = await decryptProviderCredentials(row.credentials_encrypted);
        config = fromStored(row.provider, stored);
        previous = previousSecretFrom(stored, Date.now());
        if (!config) {
          console.error(`${LOG_PREFIX} stored credentials incomplete; using env`, {
            provider: row.provider,
          });
        }
      } catch (decryptError) {
        // Error name only: a JSON/crypto message could echo decrypted bytes.
        console.error(`${LOG_PREFIX} could not decrypt stored credentials; using env`, {
          provider: row.provider,
          error: errorName(decryptError),
        });
      }
      snapshot.accounts[row.provider] = {
        config,
        updatedAt: row.updated_at ?? null,
        previousSecret: previous?.secret ?? null,
        previousSecretUntil: previous?.until ?? null,
      };
    }
  } catch (error) {
    complete = false;
    console.error(`${LOG_PREFIX} could not read payment_gateway_accounts; using env`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from("payment_gateway_settings")
      .select("active_provider")
      .eq("id", true)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data && isPixProvider(data.active_provider)) snapshot.activeProvider = data.active_provider;
  } catch (error) {
    complete = false;
    console.error(`${LOG_PREFIX} could not read payment_gateway_settings; using env`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return { snapshot, complete };
}

/** Never rejects: a failed read yields an empty (env-only) snapshot. */
function snapshot(): Promise<Snapshot> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.promise;
  const entry: { at: number; promise: Promise<Snapshot> } = {
    at: now,
    promise: loadSnapshot().then(
      ({ snapshot: snap, complete }) => {
        // A failed read is not cached, so the next call retries the database.
        if (!complete && cache === entry) cache = null;
        return snap;
      },
      () => {
        if (cache === entry) cache = null;
        return { accounts: {}, activeProvider: null };
      },
    ),
  };
  cache = entry;
  return entry.promise;
}

export function invalidatePaymentGatewayConfigCache(): void {
  cache = null;
}

// ---------------------------------------------------------------------------
// Getters

async function loadConfig(provider: PixProvider): Promise<Loaded<GatewayConfig>> {
  const dbAccount = (await snapshot()).accounts[provider];
  if (dbAccount?.config) return { source: "database", config: dbAccount.config };
  const fromEnv = envConfig(provider);
  return fromEnv ? { source: "env", config: fromEnv } : { source: "none", config: null };
}

export async function getUpperConfig(): Promise<Loaded<UpperConfig>> {
  return (await loadConfig("upper")) as Loaded<UpperConfig>;
}

export async function getSpacePayConfig(): Promise<Loaded<SpacePayConfig>> {
  return (await loadConfig("spacepay")) as Loaded<SpacePayConfig>;
}

function envActiveProvider(): PixProvider | null {
  const raw = env("BILLING_PIX_PROVIDER")?.toLowerCase();
  return isPixProvider(raw) ? raw : null;
}

async function activeProviderWithSource(): Promise<{
  provider: PixProvider;
  source: "database" | "env" | "default";
}> {
  const fromDb = (await snapshot()).activeProvider;
  if (fromDb) return { provider: fromDb, source: "database" };
  const fromEnv = envActiveProvider();
  if (fromEnv) return { provider: fromEnv, source: "env" };
  return { provider: "upper", source: "default" };
}

/** DB settings row wins; else env BILLING_PIX_PROVIDER; else "upper". */
export async function getActivePixProvider(): Promise<PixProvider> {
  return (await activeProviderWithSource()).provider;
}

function dedupe(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const value of values) {
    const v = clean(value);
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

async function dbConfig(provider: PixProvider): Promise<GatewayConfig | null> {
  return (await snapshot()).accounts[provider]?.config ?? null;
}

async function dbPreviousSecret(provider: PixProvider): Promise<string | null> {
  return (await snapshot()).accounts[provider]?.previousSecret ?? null;
}

/**
 * Every secret that may have signed an in-flight SpacePay callback URL: DB
 * callbackSecret, the one it replaced (for 24 h after a rotation) and env
 * SPACEPAY_CALLBACK_SECRET (deduped, non-empty).
 */
export async function spacePayCallbackSecrets(): Promise<string[]> {
  const fromDb = (await dbConfig("spacepay")) as SpacePayConfig | null;
  return dedupe([
    fromDb?.callbackSecret,
    await dbPreviousSecret("spacepay"),
    env("SPACEPAY_CALLBACK_SECRET"),
  ]);
}

/** Same idea for Upper webhook secrets: DB webhookSecret, the replaced one (24 h) and env UPPER_WEBHOOK_SECRET. */
export async function upperWebhookSecrets(): Promise<string[]> {
  const fromDb = (await dbConfig("upper")) as UpperConfig | null;
  return dedupe([fromDb?.webhookSecret, await dbPreviousSecret("upper"), env("UPPER_WEBHOOK_SECRET")]);
}

// ---------------------------------------------------------------------------
// Admin write helpers (validation is the caller's job)

/** Encrypts, stores masked hints, upserts the provider row and drops the cache. */
export async function savePaymentGatewayCredentials(
  provider: PixProvider,
  creds: UpperConfig | SpacePayConfig,
  actorUserId: string,
): Promise<void> {
  if (!isPixProvider(provider)) throw new Error(`unknown_pix_provider: ${String(provider)}`);
  const stored = toStored(provider, creds);
  const normalized = fromStored(provider, stored);
  if (!normalized) throw new Error("Credenciais do gateway incompletas.");

  // Secret rotation: keep the secret being replaced (DB row, else the env one
  // in effect) accepted for 24 h; an unchanged secret carries over any
  // still-valid previous one.
  const snap = await snapshot();
  const before = snap.accounts[provider];
  const replaced =
    currentSecretOf(provider, before?.config ?? null) ??
    (provider === "upper" ? env("UPPER_WEBHOOK_SECRET") : env("SPACEPAY_CALLBACK_SECRET"));
  const next = currentSecretOf(provider, normalized);
  if (replaced && replaced !== next) {
    stored[PREVIOUS_SECRET_KEY] = replaced;
    stored[PREVIOUS_SECRET_UNTIL_KEY] = new Date(Date.now() + PREVIOUS_SECRET_GRACE_MS).toISOString();
  } else if (before?.previousSecret && before.previousSecretUntil && before.previousSecret !== next) {
    stored[PREVIOUS_SECRET_KEY] = before.previousSecret;
    stored[PREVIOUS_SECRET_UNTIL_KEY] = before.previousSecretUntil;
  }

  const credentials_encrypted = await encryptProviderCredentials(stored);
  const { error } = await supabaseAdmin.from("payment_gateway_accounts").upsert(
    {
      provider,
      credentials_encrypted,
      hints: buildHints(provider, normalized),
      updated_by: actorUserId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "provider" },
  );
  invalidatePaymentGatewayConfigCache();
  if (error) throw new Error(error.message);
}

/** Removes the provider row (it goes back to env) and drops the cache. */
export async function deletePaymentGatewayCredentials(provider: PixProvider): Promise<void> {
  if (!isPixProvider(provider)) throw new Error(`unknown_pix_provider: ${String(provider)}`);
  const { error } = await supabaseAdmin
    .from("payment_gateway_accounts")
    .delete()
    .eq("provider", provider);
  invalidatePaymentGatewayConfigCache();
  if (error) throw new Error(error.message);
}

/** Upserts the single settings row and drops the cache. */
export async function setActivePixProvider(
  provider: PixProvider,
  actorUserId: string,
): Promise<void> {
  if (!isPixProvider(provider)) throw new Error(`unknown_pix_provider: ${String(provider)}`);
  const { error } = await supabaseAdmin.from("payment_gateway_settings").upsert(
    {
      id: true,
      active_provider: provider,
      updated_by: actorUserId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  invalidatePaymentGatewayConfigCache();
  if (error) throw new Error(error.message);
}

/** For the admin listing: never returns secrets, only source + hints + updated_at. */
export async function describePaymentGateways(): Promise<{
  activeProvider: PixProvider;
  activeSource: "database" | "env" | "default";
  gateways: Record<
    PixProvider,
    { source: GatewayConfigSource; hints: Record<string, string>; updatedAt: string | null }
  >;
}> {
  const active = await activeProviderWithSource();
  const snap = await snapshot();
  const gateways = {} as Record<
    PixProvider,
    { source: GatewayConfigSource; hints: Record<string, string>; updatedAt: string | null }
  >;
  for (const provider of PROVIDERS) {
    const dbAccount = snap.accounts[provider];
    if (dbAccount?.config) {
      gateways[provider] = {
        source: "database",
        // Recomputed from the decrypted config (same as the stored hints
        // column), so nothing in the row can surface a secret here.
        hints: buildHints(provider, dbAccount.config),
        updatedAt: dbAccount.updatedAt,
      };
      continue;
    }
    const fromEnv = envConfig(provider);
    gateways[provider] = fromEnv
      ? { source: "env", hints: buildHints(provider, fromEnv), updatedAt: null }
      : { source: "none", hints: {}, updatedAt: null };
  }
  return { activeProvider: active.provider, activeSource: active.source, gateways };
}
