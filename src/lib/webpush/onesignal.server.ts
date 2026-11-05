// OneSignal REST client (web push channel, Task 4). No DB access here.
import { createHash } from "node:crypto";

const ONESIGNAL_BASE_URL = "https://api.onesignal.com";
const ONESIGNAL_USAGE_HEADER = "Betleads | Partner Integration";
const TIMEOUT_MS = 20_000;

function assertConfigured(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error("OneSignal não configurado");
  return trimmed;
}

function orgApiKey(): string {
  return assertConfigured(process.env.ONESIGNAL_ORG_API_KEY);
}

function orgId(): string | undefined {
  return process.env.ONESIGNAL_ORG_ID?.trim() || undefined;
}

function commonHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Key ${apiKey}`,
    "Content-Type": "application/json",
    "OneSignal-Usage": ONESIGNAL_USAGE_HEADER,
  };
}

async function readApiKeyField(body: Record<string, unknown>): Promise<string> {
  const value = body.token_value ?? body.formatted_token ?? body.api_key;
  return typeof value === "string" ? value : "";
}

export async function createOneSignalApp(input: {
  siteName: string;
  origin: string;
  iconUrl?: string | null;
}): Promise<{ appId: string }> {
  const apiKey = orgApiKey();

  const body: Record<string, unknown> = {
    site_name: input.siteName,
    chrome_web_origin: input.origin,
  };
  if (input.iconUrl) body.chrome_web_default_notification_icon = input.iconUrl;
  const org = orgId();
  if (org) body.organization_id = org;

  const response = await fetch(`${ONESIGNAL_BASE_URL}/apps`, {
    method: "POST",
    headers: commonHeaders(apiKey),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const json = (await response.json()) as { id?: string };
  return { appId: String(json.id ?? "") };
}

export async function createOneSignalAppKey(appId: string): Promise<{ apiKey: string }> {
  const orgKey = orgApiKey();

  const response = await fetch(`${ONESIGNAL_BASE_URL}/apps/${appId}/auth/tokens`, {
    method: "POST",
    headers: commonHeaders(orgKey),
    body: JSON.stringify({ name: "betleads" }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const json = (await response.json()) as Record<string, unknown>;
  const apiKey = await readApiKeyField(json);
  return { apiKey };
}

export async function updateOneSignalAppIcon(appId: string, iconUrl: string): Promise<void> {
  const apiKey = process.env.ONESIGNAL_ORG_API_KEY?.trim();
  // Manual path (no org key configured): nothing to do.
  if (!apiKey) return;

  await fetch(`${ONESIGNAL_BASE_URL}/apps/${appId}`, {
    method: "PUT",
    headers: commonHeaders(apiKey),
    body: JSON.stringify({ chrome_web_default_notification_icon: iconUrl }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

export type OneSignalSendResult =
  | { ok: true; notificationId: string; invalidSubscriptionIds: string[] }
  | { ok: false; temporary: boolean; status: number; error: string };

export async function sendOneSignalPush(input: {
  appId: string;
  apiKey: string;
  subscriptionIds: string[];
  title: string;
  body: string;
  url: string;
  imageUrl?: string | null;
  iconUrl?: string | null;
  idempotencyKey: string;
}): Promise<OneSignalSendResult> {
  const body: Record<string, unknown> = {
    app_id: input.appId,
    include_subscription_ids: input.subscriptionIds,
    target_channel: "push",
    headings: { en: input.title, pt: input.title },
    contents: { en: input.body, pt: input.body },
    url: input.url,
    idempotency_key: input.idempotencyKey,
  };
  if (input.imageUrl) body.chrome_web_image = input.imageUrl;
  if (input.iconUrl) body.chrome_web_icon = input.iconUrl;

  let response: Response;
  try {
    response = await fetch(`${ONESIGNAL_BASE_URL}/notifications?c=push`, {
      method: "POST",
      headers: commonHeaders(input.apiKey),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      temporary: true,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  let json: Record<string, unknown> = {};
  try {
    json = (await response.json()) as Record<string, unknown>;
  } catch {
    json = {};
  }

  if (!response.ok) {
    const temporary = response.status === 429 || response.status >= 500;
    return {
      ok: false,
      temporary,
      status: response.status,
      error: JSON.stringify(json.errors ?? json),
    };
  }

  const notificationId = typeof json.id === "string" ? json.id : "";
  const errors = json.errors;
  let invalidSubscriptionIds: string[];
  if (Array.isArray(errors)) {
    // e.g. {errors: ["All included players are not subscribed"]}: every subscription was rejected.
    invalidSubscriptionIds = [...input.subscriptionIds];
  } else if (errors && typeof errors === "object" && Array.isArray((errors as Record<string, unknown>).invalid_player_ids)) {
    invalidSubscriptionIds = (errors as Record<string, unknown>).invalid_player_ids as string[];
  } else {
    invalidSubscriptionIds = [];
  }

  return { ok: true, notificationId, invalidSubscriptionIds };
}

export async function deleteOneSignalSubscription(input: {
  appId: string;
  apiKey: string;
  subscriptionId: string;
}): Promise<void> {
  const response = await fetch(
    `${ONESIGNAL_BASE_URL}/apps/${input.appId}/subscriptions/${input.subscriptionId}`,
    {
      method: "DELETE",
      headers: commonHeaders(input.apiKey),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );

  // 404 counts as success: the subscription is already gone (LGPD utility, no screen).
  if (!response.ok && response.status !== 404) {
    throw new Error(`OneSignal delete subscription failed: ${response.status}`);
  }
}

export async function deterministicUuid(input: string): Promise<string> {
  const hash = createHash("sha256").update(input).digest("hex");
  const hex = hash.slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}
