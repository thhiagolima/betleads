/* eslint-disable @typescript-eslint/no-explicit-any -- tables are introduced by this migration and are absent from the checked-in generated Supabase types. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { buildFirstPartyClickUrl } from "./click-tracking.server";
import { channelBudget } from "./rate-limit/channel-budget.server";
import {
  assertTenantNotDemoForSend,
  demoSendBlockedReason,
  listDemoTenantIds,
} from "./tenant-access.server";

const SHORTIO_API_URL = "https://api.short.io/links";
const SHORTIO_BULK_API_URL = "https://api.short.io/links/bulk";
const SHORTIO_LINK_TITLE = "BetLeads";
/** Short.io accepts at most 1000 links per bulk call. */
export const SHORTIO_BULK_MAX_LINKS = 1000;
// SMS copy commonly contains a compact `www.example.com` address. Treat it as
// HTTPS so enabling tracking cannot silently produce a campaign with no
// measurable dispatches.
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

// WhatsApp is retained only so legacy callers type-check; it is never enabled
// by defaults or tenant configuration in this rollout.
export type LinkTrackingChannel = "sms" | "email" | "whatsapp";
export type LinkTrackingSource =
  "manual" | "test" | "campaign" | "sms_flow" | "email_flow" | "journey" | "call_flow_sms";

export type LinkTrackingContext = {
  tenantId: string;
  channel: LinkTrackingChannel;
  sourceType: LinkTrackingSource;
  sourceId?: string | null;
  recipientPlayerId?: string | null;
  recipientHash?: string | null;
  messageLogType?: string | null;
  messageLogId?: string | null;
  /** Stable identity of one intended delivery. Reusing it makes retries safe. */
  deliveryKey?: string | null;
  /** Explicit choice made in the composer. Undefined preserves legacy behaviour. */
  enabled?: boolean;
  experimentId?: string | null;
  experimentVariant?: "A" | "B" | null;
  journeyStepId?: string | null;
  journeyStepPosition?: number | null;
};

type TenantShortioSettings = {
  enabled: boolean;
  domain: string | null;
  fallback_mode: "block" | "passthrough";
  default_ttl_days: number | null;
  allowed_destination_hosts: string[];
  enabled_channels: LinkTrackingChannel[];
};

type CreatedLink = { id: string; shortURL: string; path?: string | null };

export type PreparedTrackedLink = {
  trackedLinkId: string;
  dispatchId: string;
  shortUrl: string;
  originalUrl: string;
  trackingToken: string;
};

export type PreparedText = {
  content: string;
  links: PreparedTrackedLink[];
  trackingEnabled: boolean;
};

function envEnabled() {
  return ["1", "true", "yes", "on"].includes((process.env.SHORTIO_ENABLED ?? "").toLowerCase());
}

function normalizeHost(value: string) {
  return value.trim().toLowerCase().replace(/^\.+/, "");
}

function defaultSettings(): TenantShortioSettings {
  return {
    enabled: envEnabled(),
    domain: process.env.SHORTIO_DOMAIN?.trim().toLowerCase() || null,
    fallback_mode: "block",
    default_ttl_days: null,
    allowed_destination_hosts: [],
    enabled_channels: ["sms", "email"],
  };
}

async function settingsForTenant(tenantId: string): Promise<TenantShortioSettings> {
  const fallback = defaultSettings();
  const db = supabaseAdmin as any;
  const { data, error } = await db
    .from("shortio_settings")
    .select(
      "enabled,domain,fallback_mode,default_ttl_days,allowed_destination_hosts,enabled_channels",
    )
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw new Error(`Falha ao carregar a configuração Short.io: ${error.message}`);
  if (!data) return fallback;
  return {
    enabled: Boolean(data.enabled),
    domain:
      typeof data.domain === "string" && data.domain ? data.domain.toLowerCase() : fallback.domain,
    fallback_mode: data.fallback_mode === "passthrough" ? "passthrough" : "block",
    default_ttl_days:
      typeof data.default_ttl_days === "number" ? data.default_ttl_days : fallback.default_ttl_days,
    allowed_destination_hosts: Array.isArray(data.allowed_destination_hosts)
      ? data.allowed_destination_hosts.map(normalizeHost).filter(Boolean)
      : [],
    enabled_channels: Array.isArray(data.enabled_channels)
      ? data.enabled_channels.filter(
          (channel: unknown): channel is LinkTrackingChannel =>
            channel === "sms" || channel === "email",
        )
      : ["sms", "email"],
  };
}

export function stripTrackingUrlTrailingPunctuation(raw: string) {
  let value = raw.replace(TRAILING_PUNCTUATION, "");
  // Parentheses are common in prose. Keep a closing parenthesis only when it
  // has a matching opening parenthesis inside the URL.
  while (value.endsWith(")")) {
    const opens = (value.match(/\(/g) ?? []).length;
    const closes = (value.match(/\)/g) ?? []).length;
    if (closes <= opens) break;
    value = value.slice(0, -1);
  }
  return value;
}

export function normalizeTrackingUrl(raw: string) {
  const stripped = stripTrackingUrlTrailingPunctuation(raw);
  return /^www\./i.test(stripped) ? `https://${stripped}` : stripped;
}

function isPrivateIpv4(hostname: string) {
  const parts = hostname.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    parts[0] === 0
  );
}

function isPrivateIpv6(hostname: string) {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    value === "::1" ||
    value === "::" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("fe80:")
  );
}

export function isProtectedDestination(raw: string) {
  try {
    const url = new URL(raw);
    if (/\/(?:u|login|auth|reset|magic)(?:\/|$)/i.test(url.pathname)) return true;
    return ["token", "sig", "signature", "expires", "expiry", "exp", "auth", "login"].some((key) =>
      url.searchParams.has(key),
    );
  } catch {
    return true;
  }
}

async function assertResolvedPublicDestination(raw: string) {
  const host = new URL(raw).hostname;
  // This module is also referenced by server functions discovered during the
  // client build; keep Node DNS out of the browser bundle.
  const { lookup } = await import(/* @vite-ignore */ "node:dns/promises");
  const resolved = await lookup(host, { all: true, verbatim: true });
  if (
    resolved.length === 0 ||
    resolved.some(({ address }) => isPrivateIpv4(address) || isPrivateIpv6(address))
  ) {
    throw new Error("URL de destino resolve para um endereço interno ou reservado");
  }
}

export function isShortioEligibleUrl(
  raw: string,
  options?: { domain?: string | null; allowedHosts?: string[] },
) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    const host = normalizeHost(url.hostname);
    if (
      !host ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      isPrivateIpv4(host) ||
      isPrivateIpv6(host)
    )
      return false;
    if (options?.domain && host === normalizeHost(options.domain)) return false;
    const allowedHosts = options?.allowedHosts?.map(normalizeHost).filter(Boolean) ?? [];
    if (
      allowedHosts.length > 0 &&
      !allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function canonicalHash(url: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function deterministicToken(context: LinkTrackingContext, position: number) {
  const recipient = context.recipientPlayerId ?? context.recipientHash ?? "anonymous";
  const delivery = context.deliveryKey ?? context.messageLogId ?? context.sourceId ?? "one-off";
  const hash = await canonicalHash(
    [context.tenantId, context.channel, context.sourceType, delivery, recipient, position].join(
      "|",
    ),
  );
  // UUID shape keeps compatibility with the existing uuid column and UTM format.
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

export function withTrackingToken(raw: string, token: string, context: LinkTrackingContext) {
  const url = new URL(raw);
  // Machine attribution must not compete with marketing UTMs. Always own the
  // dedicated parameter, while retaining utm_content for legacy receivers.
  url.searchParams.set("bl_click_id", token);
  if (!url.searchParams.has("utm_source")) url.searchParams.set("utm_source", "betleads");
  if (!url.searchParams.has("utm_medium")) url.searchParams.set("utm_medium", context.channel);
  if (!url.searchParams.has("utm_campaign"))
    url.searchParams.set("utm_campaign", context.sourceId ?? context.sourceType);
  if (!url.searchParams.has("utm_content")) url.searchParams.set("utm_content", token);
  return url.toString();
}

/**
 * Keeps useful source UTMs without exposing the internal click capability to
 * the destination. Player attribution is resolved through the dispatch row.
 */
export function withDeliveryContext(raw: string, context: LinkTrackingContext) {
  const url = new URL(raw);
  if (!url.searchParams.has("utm_source")) url.searchParams.set("utm_source", "betleads");
  if (!url.searchParams.has("utm_medium")) url.searchParams.set("utm_medium", context.channel);
  if (!url.searchParams.has("utm_campaign"))
    url.searchParams.set("utm_campaign", context.sourceId ?? context.sourceType);
  url.searchParams.delete("bl_click_id");
  return url.toString();
}

/**
 * Creates one Short.io link. Throws DemoTenantBlockedError (DEMO_SEND_BLOCKED)
 * for a demo/unknown/missing tenant, checked right before each request.
 */
export async function createShortioLink(input: {
  tenantId: string;
  originalUrl: string;
  domain: string;
  ttlDays: number | null;
  sourceType: string;
}): Promise<CreatedLink> {
  const apiKey = process.env.SHORTIO_API_KEY?.trim();
  if (!apiKey) throw new Error("SHORTIO_API_KEY não configurada no servidor");
  const payload: Record<string, unknown> = {
    originalURL: input.originalUrl,
    domain: input.domain,
    allowDuplicates: false,
    // A title avoids Short.io fetching the destination (our click redirect)
    // to read it, which was being recorded as a player click (TRK-06).
    title: SHORTIO_LINK_TITLE,
    tags: ["betleads", input.sourceType.slice(0, 64)],
  };
  if (input.ttlDays) payload.ttl = new Date(Date.now() + input.ttlDays * 86400000).toISOString();

  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    // Outside the try: a demo block must not be retried as a network error.
    await assertTenantNotDemoForSend(input.tenantId);
    try {
      const response = await fetch(SHORTIO_API_URL, {
        method: "POST",
        headers: {
          Authorization: apiKey,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (response.ok && body && typeof body.id === "string" && typeof body.shortURL === "string") {
        return {
          id: body.id,
          shortURL: body.shortURL,
          path: typeof body.path === "string" ? body.path : null,
        };
      }
      lastError = `Short.io retornou HTTP ${response.status}`;
      if (response.status !== 429 && response.status < 500) break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) =>
      setTimeout(resolve, 250 * attempt + Math.floor(Math.random() * 150)),
    );
  }
  throw new Error(`Falha ao criar link Short.io: ${lastError || "sem resposta"}`);
}

async function getOrCreateTrackedLink(args: {
  tenantId: string;
  originalUrl: string;
  settings: TenantShortioSettings;
  sourceType: string;
}) {
  const db = supabaseAdmin as any;
  const hash = await canonicalHash(args.originalUrl);
  const existing = await db
    .from("tracked_links")
    .select("id,short_url")
    .eq("tenant_id", args.tenantId)
    .eq("canonical_url_hash", hash)
    .maybeSingle();
  if (existing.error)
    throw new Error(`Falha ao consultar link rastreado: ${existing.error.message}`);
  if (existing.data) return existing.data as { id: string; short_url: string };
  if (!args.settings.domain) throw new Error("SHORTIO_DOMAIN não configurado para este tenant");

  const created = await createShortioLink({
    tenantId: args.tenantId,
    originalUrl: args.originalUrl,
    domain: args.settings.domain,
    ttlDays: args.settings.default_ttl_days,
    sourceType: args.sourceType,
  });
  const inserted = await db
    .from("tracked_links")
    .insert({
      tenant_id: args.tenantId,
      shortio_link_id: created.id,
      short_url: created.shortURL,
      original_url: args.originalUrl,
      canonical_url_hash: hash,
      path: created.path ?? null,
      expires_at: args.settings.default_ttl_days
        ? new Date(Date.now() + args.settings.default_ttl_days * 86400000).toISOString()
        : null,
    })
    .select("id,short_url")
    .single();
  if (!inserted.error && inserted.data) return inserted.data as { id: string; short_url: string };

  // Another dispatcher may have inserted the same link between the select and
  // insert. Recover the winner rather than producing duplicate sends.
  const winner = await db
    .from("tracked_links")
    .select("id,short_url")
    .eq("tenant_id", args.tenantId)
    .eq("canonical_url_hash", hash)
    .maybeSingle();
  if (winner.data) return winner.data as { id: string; short_url: string };
  throw new Error(
    `Falha ao persistir link rastreado: ${inserted.error?.message ?? "sem detalhes"}`,
  );
}

async function persistDispatch(args: {
  trackedLinkId: string;
  trackingToken: string;
  originalUrl: string;
  sentUrl: string;
  position: number;
  context: LinkTrackingContext;
}) {
  const db = supabaseAdmin as any;
  const { data, error } = await db
    .from("link_dispatches")
    .upsert(
      {
        tenant_id: args.context.tenantId,
        idempotency_key: `${args.context.deliveryKey ?? args.context.messageLogId ?? args.context.sourceId ?? "one-off"}:${args.position}`,
        tracked_link_id: args.trackedLinkId,
        tracking_token: args.trackingToken,
        channel: args.context.channel,
        recipient_player_id: args.context.recipientPlayerId ?? null,
        recipient_hash: args.context.recipientHash ?? null,
        source_type: args.context.sourceType,
        source_id: args.context.sourceId ?? null,
        message_log_type: args.context.messageLogType ?? null,
        message_log_id: args.context.messageLogId ?? null,
        url_position: args.position,
        original_url: args.originalUrl,
        sent_url: args.sentUrl,
        experiment_id: args.context.experimentId ?? null,
        experiment_variant: args.context.experimentVariant ?? null,
        journey_step_id: args.context.journeyStepId ?? null,
        journey_step_position: args.context.journeyStepPosition ?? null,
      },
      { onConflict: "tenant_id,idempotency_key", ignoreDuplicates: true },
    )
    .select("id")
    .single();
  if (!error && data) return String(data.id);
  const existing = await db
    .from("link_dispatches")
    .select("id")
    .eq("tenant_id", args.context.tenantId)
    .eq(
      "idempotency_key",
      `${args.context.deliveryKey ?? args.context.messageLogId ?? args.context.sourceId ?? "one-off"}:${args.position}`,
    )
    .maybeSingle();
  if (existing.data) return String(existing.data.id);
  if (error || !data)
    throw new Error(`Falha ao registrar dispatch de link: ${error?.message ?? "sem detalhes"}`);
  return String(data.id);
}

async function experimentForContext(context: LinkTrackingContext) {
  if (
    (context.sourceType !== "campaign" && context.sourceType !== "journey") ||
    !context.sourceId ||
    !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(context.sourceId)
  )
    return null;
  const recipientKey = context.recipientPlayerId ?? context.recipientHash ?? context.deliveryKey;
  if (!recipientKey) return null;
  const { data, error } = await (supabaseAdmin as any).rpc("resolve_conversion_experiment", {
    p_tenant_id: context.tenantId,
    p_source_type: context.sourceType,
    p_source_id: context.sourceId,
    p_recipient_key: recipientKey,
    p_player_id: context.recipientPlayerId ?? null,
  });
  if (error) throw new Error(`Falha ao resolver experimento: ${error.message}`);
  return data as null | {
    experiment_id: string;
    variant: "A" | "B";
    dimension: string;
    payload: Record<string, unknown>;
  };
}

/**
 * Rewrites eligible URLs in final plain text. Call this only after template
 * variables are rendered, immediately before the provider request.
 */
export async function prepareTrackedText(
  content: string,
  context: LinkTrackingContext,
): Promise<PreparedText> {
  const settings = await settingsForTenant(context.tenantId);
  if (
    context.enabled === false ||
    !settings.enabled ||
    !settings.enabled_channels.includes(context.channel)
  )
    return { content, links: [], trackingEnabled: false };
  // No tracked link or link_dispatches row is ever prepared for a demo tenant.
  await assertTenantNotDemoForSend(context.tenantId);

  const experiment = await experimentForContext(context);
  const dispatchContext: LinkTrackingContext = experiment
    ? { ...context, experimentId: experiment.experiment_id, experimentVariant: experiment.variant }
    : context;
  const matches = Array.from(content.matchAll(URL_PATTERN));
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  const links: PreparedTrackedLink[] = [];
  for (let position = 0; position < matches.length; position++) {
    const match = matches[position];
    const matchedRaw = stripTrackingUrlTrailingPunctuation(match[0]);
    const originalRaw = normalizeTrackingUrl(matchedRaw);
    const variantUrl = experiment?.dimension === "cta" ? experiment.payload.destination_url : null;
    const raw = typeof variantUrl === "string" && variantUrl ? variantUrl : originalRaw;
    if (
      !raw ||
      isProtectedDestination(originalRaw) ||
      !isShortioEligibleUrl(raw, {
        domain: settings.domain,
        allowedHosts: settings.allowed_destination_hosts,
      })
    ) {
      continue;
    }
    try {
      await assertResolvedPublicDestination(raw);
      const trackingToken = await deterministicToken(dispatchContext, position);
      const finalDestination = withDeliveryContext(raw, dispatchContext);
      const firstPartyRedirect = await buildFirstPartyClickUrl(trackingToken);
      const tracked = await getOrCreateTrackedLink({
        tenantId: context.tenantId,
        originalUrl: firstPartyRedirect,
        settings,
        sourceType: context.sourceType,
      });
      const dispatchId = await persistDispatch({
        trackedLinkId: tracked.id,
        trackingToken,
        originalUrl: finalDestination,
        sentUrl: tracked.short_url,
        position,
        context: dispatchContext,
      });
      const start = match.index ?? 0;
      replacements.push({ start, end: start + matchedRaw.length, value: tracked.short_url });
      links.push({
        trackedLinkId: tracked.id,
        dispatchId,
        shortUrl: tracked.short_url,
        originalUrl: raw,
        trackingToken,
      });
    } catch (error) {
      if (settings.fallback_mode === "passthrough") continue;
      throw error;
    }
  }
  let rewritten = content;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    rewritten = `${rewritten.slice(0, replacement.start)}${replacement.value}${rewritten.slice(replacement.end)}`;
  }
  return { content: rewritten, links, trackingEnabled: true };
}

/** Rewrites only navigational anchors in email HTML. Images, CSS URLs and the
 * unsubscribe route are deliberately excluded. */
export async function prepareTrackedEmailHtml(
  html: string,
  context: Omit<LinkTrackingContext, "channel">,
): Promise<PreparedText> {
  const settings = await settingsForTenant(context.tenantId);
  if (
    context.enabled === false ||
    !settings.enabled ||
    !settings.enabled_channels.includes("email")
  )
    return { content: html, links: [], trackingEnabled: false };
  await assertTenantNotDemoForSend(context.tenantId);
  const baseContext: LinkTrackingContext = { ...context, channel: "email" };
  const experiment = await experimentForContext(baseContext);
  const dispatchContext: LinkTrackingContext = experiment
    ? {
        ...baseContext,
        experimentId: experiment.experiment_id,
        experimentVariant: experiment.variant,
      }
    : baseContext;
  const hrefPattern = /(\bhref\s*=\s*)(["'])([^"']*)\2/gi;
  const matches = Array.from(html.matchAll(hrefPattern));
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  const links: PreparedTrackedLink[] = [];
  for (let position = 0; position < matches.length; position++) {
    const match = matches[position];
    const originalRaw = match[3].trim();
    const variantUrl = experiment?.dimension === "cta" ? experiment.payload.destination_url : null;
    const raw = typeof variantUrl === "string" && variantUrl ? variantUrl : originalRaw;
    let protectedLink = false;
    try {
      const parsed = new URL(originalRaw);
      protectedLink = isProtectedDestination(parsed.toString());
    } catch {
      protectedLink = true;
    }
    if (
      protectedLink ||
      /(?:unsubscribe|descadastr|opt[ -]?out)/i.test(originalRaw) ||
      !isShortioEligibleUrl(raw, {
        domain: settings.domain,
        allowedHosts: settings.allowed_destination_hosts,
      })
    ) {
      continue;
    }
    try {
      await assertResolvedPublicDestination(raw);
      const trackingToken = await deterministicToken(dispatchContext, position);
      const finalDestination = withDeliveryContext(raw, dispatchContext);
      const firstPartyRedirect = await buildFirstPartyClickUrl(trackingToken);
      const tracked = await getOrCreateTrackedLink({
        tenantId: context.tenantId,
        originalUrl: firstPartyRedirect,
        settings,
        sourceType: context.sourceType,
      });
      const dispatchId = await persistDispatch({
        trackedLinkId: tracked.id,
        trackingToken,
        originalUrl: finalDestination,
        sentUrl: tracked.short_url,
        position,
        context: dispatchContext,
      });
      const valueStart = (match.index ?? 0) + match[1].length + 1;
      replacements.push({
        start: valueStart,
        end: valueStart + originalRaw.length,
        value: tracked.short_url,
      });
      links.push({
        trackedLinkId: tracked.id,
        dispatchId,
        shortUrl: tracked.short_url,
        originalUrl: raw,
        trackingToken,
      });
    } catch (error) {
      if (settings.fallback_mode === "passthrough") continue;
      throw error;
    }
  }
  let rewritten = html;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    rewritten = `${rewritten.slice(0, replacement.start)}${replacement.value}${rewritten.slice(replacement.end)}`;
  }
  return { content: rewritten, links, trackingEnabled: true };
}

export async function markTrackedDispatchesSent(dispatchIds: string[]) {
  if (dispatchIds.length === 0) return;
  const db = supabaseAdmin as any;
  const { error } = await db
    .from("link_dispatches")
    .update({ send_status: "sent", sent_at: new Date().toISOString() })
    .in("id", dispatchIds);
  if (error)
    console.error("Falha ao atualizar dispatches de links", {
      error: error.message,
      count: dispatchIds.length,
    });
}

export async function markTrackedDispatchesFailed(dispatchIds: string[]) {
  if (dispatchIds.length === 0) return;
  const db = supabaseAdmin as any;
  const { error } = await db
    .from("link_dispatches")
    .update({ send_status: "failed" })
    .in("id", dispatchIds);
  if (error)
    console.error("Falha ao marcar dispatches de links", {
      error: error.message,
      count: dispatchIds.length,
    });
}

/** Binds dispatches prepared before provider delivery to the durable send log. */
export async function bindTrackedDispatchesToMessageLog(args: {
  tenantId: string;
  messageLogType: string;
  messageLogId: string;
  deliveryKey: string;
}) {
  const db = supabaseAdmin as any;
  const { error } = await db
    .from("link_dispatches")
    .update({ message_log_type: args.messageLogType, message_log_id: args.messageLogId })
    .eq("tenant_id", args.tenantId)
    .like("idempotency_key", `${args.deliveryKey}:%`);
  if (error) console.error("Falha ao vincular dispatch Short.io ao log", { error: error.message });
}

/** Pulls aggregate click counts from Short.io. Raw click data is intentionally
 * not retained: snapshots are enough for CRM reporting and minimise PII. */
type ShortioSyncResult = {
  startedAt: string;
  processed: number;
  failures: number;
  total: number;
  tenants?: number;
  skipped?: boolean;
};

export async function syncShortioMetrics(
  limit = 100,
  tenantId?: string,
): Promise<ShortioSyncResult> {
  const apiKey = process.env.SHORTIO_API_KEY?.trim();
  if (!apiKey) throw new Error("SHORTIO_API_KEY não configurada no servidor");
  const db = supabaseAdmin as any;
  const startedAt = new Date().toISOString();
  // A execução global é registrada por tenant, preservando RLS e permitindo
  // identificar exatamente qual carteira de links falhou.
  if (!tenantId) {
    // Demo tenants are not even visited (their links are never synced).
    const demoTenantIds = await listDemoTenantIds();
    let tenantsQuery = db.from("tracked_links").select("tenant_id").eq("status", "active");
    if (demoTenantIds.length > 0) {
      tenantsQuery = tenantsQuery.not("tenant_id", "in", `(${demoTenantIds.join(",")})`);
    }
    const { data: tenants, error: tenantsError } = await tenantsQuery.limit(10_000);
    if (tenantsError) throw new Error(`Falha ao listar tenants Short.io: ${tenantsError.message}`);
    const ids: string[] = Array.from(
      new Set<string>((tenants ?? []).map((row: any) => String(row.tenant_id))),
    );
    const results = await Promise.all(ids.map((id) => syncShortioMetrics(limit, id)));
    return {
      startedAt,
      processed: results.reduce((sum, result) => sum + result.processed, 0),
      failures: results.reduce((sum, result) => sum + result.failures, 0),
      total: results.reduce((sum, result) => sum + result.total, 0),
      tenants: ids.length,
    };
  }
  // Demo tenants' links are never pulled from Short.io (no run row either).
  // A billing-locked house keeps receiving its click statistics (inbound
  // data, like its webhook): only demo/unknown tenants are skipped here.
  if (await demoSendBlockedReason(tenantId, { allowBillingLocked: true })) {
    return { startedAt, processed: 0, failures: 0, total: 0, skipped: true };
  }
  const staleBefore = new Date(Date.now() - 20 * 60_000).toISOString();
  // A killed HTTP request must not leave a tenant permanently represented as
  // "running". Preserve the audit row, but close it before the next attempt.
  await db
    .from("link_tracking_sync_runs")
    .update({
      status: "failed",
      finished_at: new Date().toISOString(),
      error: "Sincronizacao interrompida antes da conclusao; retomada automaticamente.",
    })
    .eq("tenant_id", tenantId)
    .eq("status", "running")
    .lt("started_at", staleBefore);
  const { data: activeRun } = await db
    .from("link_tracking_sync_runs")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("status", "running")
    .gte("started_at", staleBefore)
    .limit(1)
    .maybeSingle();
  if (activeRun) return { startedAt, processed: 0, failures: 0, total: 0, skipped: true };
  const run = tenantId
    ? await db
        .from("link_tracking_sync_runs")
        .insert({ tenant_id: tenantId })
        .select("id")
        .maybeSingle()
    : { data: null };
  // A sync global atravessa tenants; a tabela de runs é deliberadamente
  // tenant-scoped e por isso só registra execuções com tenant explícito.
  const runId = run.data ? String(run.data.id) : null;

  // Keep newly sent links near-real-time even when a tenant owns thousands of
  // historical links. A pure UUID cursor can leave a new link behind the
  // cursor for days, so every run reserves capacity for the last 24 hours and
  // uses the remaining slots for the stalest historical links.
  // New sends must become observable while the journey is still running.  A
  // fixed ten-link reserve leaves the tail of a large SMS batch unsynchronised
  // for hours; spend most of each tick on fresh links and reconcile history
  // with the remaining capacity.
  const recentLimit = Math.max(1, Math.min(limit, Math.ceil(limit * 0.8)));
  const recentSince = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const recentResult = await db
    .from("tracked_links")
    .select("id,tenant_id,shortio_link_id")
    .eq("status", "active")
    .eq("tenant_id", tenantId)
    .gte("created_at", recentSince)
    .order("last_synced_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: false })
    .limit(recentLimit);
  if (recentResult.error)
    throw new Error(`Falha ao listar links recentes: ${recentResult.error.message}`);

  const recentLinks = recentResult.data ?? [];
  const recentIds = new Set(recentLinks.map((link: any) => String(link.id)));
  const backgroundLimit = Math.max(0, limit - recentLinks.length);
  const backgroundResult = backgroundLimit
    ? await db
        .from("tracked_links")
        .select("id,tenant_id,shortio_link_id")
        .eq("status", "active")
        .eq("tenant_id", tenantId)
        .order("last_synced_at", { ascending: true, nullsFirst: true })
        .order("created_at", { ascending: true })
        .limit(backgroundLimit + recentLinks.length)
    : { data: [], error: null };
  if (backgroundResult.error)
    throw new Error(`Falha ao listar links históricos: ${backgroundResult.error.message}`);
  const backgroundLinks = (backgroundResult.data ?? [])
    .filter((link: any) => !recentIds.has(String(link.id)))
    .slice(0, backgroundLimit);
  const links = [...recentLinks, ...backgroundLinks];

  let processed = 0;
  let failures = 0;
  const snapshotAt = new Date();
  snapshotAt.setUTCMinutes(0, 0, 0);
  const syncLinks = links ?? [];
  const configuredConcurrency = Number(process.env.SHORTIO_SYNC_CONCURRENCY ?? 15);
  const concurrency = Math.max(
    1,
    Math.min(Number.isFinite(configuredConcurrency) ? configuredConcurrency : 15, 25),
  );
  const fetchStatistics = async (linkTenantId: string, shortioLinkId: string) => {
    let response: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      // Demo guard immediately before the request (counted as a link failure).
      // Reading statistics back is allowed for a billing-locked house.
      await assertTenantNotDemoForSend(linkTenantId, { allowBillingLocked: true });
      response = await fetch(
        `https://statistics.short.io/statistics/link/${encodeURIComponent(shortioLinkId)}/by_interval`,
        {
          method: "POST",
          headers: {
            Authorization: apiKey,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            period: "last30",
            clicksChartInterval: "day",
            tz: "America/Sao_Paulo",
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (response.ok) return response;
      if (response.status !== 429 && response.status < 500) break;
      const retryAfter = Number(response.headers.get("retry-after"));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1_000, 5_000)
          : 750 * (attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    throw new Error(`Short.io retornou HTTP ${response?.status ?? 0}`);
  };
  for (let offset = 0; offset < syncLinks.length; offset += concurrency) {
    await Promise.all(
      syncLinks.slice(offset, offset + concurrency).map(async (link: any) => {
        try {
          const response = await fetchStatistics(String(link.tenant_id), link.shortio_link_id);
          const payload = (await response.json()) as {
            clicksStatistics?: Array<{ x?: string; y?: number }>;
            // Kept for compatibility with older API responses.
            clickStatistics?: Array<{ x?: string; y?: number }>;
          };
          const intervals = payload.clicksStatistics ?? payload.clickStatistics ?? [];
          const clicks = intervals.reduce((total, item) => total + Number(item.y ?? 0), 0);
          const clickInstants = intervals
            .filter(
              (item) => Number(item.y ?? 0) > 0 && item.x && Number.isFinite(Date.parse(item.x)),
            )
            .map((item) => new Date(item.x!).toISOString())
            .sort();
          const { error: snapshotError } = await db.from("link_click_snapshots").upsert(
            {
              tenant_id: link.tenant_id,
              tracked_link_id: link.id,
              snapshot_at: snapshotAt.toISOString(),
              clicks,
              payload,
            },
            { onConflict: "tracked_link_id,snapshot_at" },
          );
          if (snapshotError) throw new Error(snapshotError.message);
          if (clickInstants.length > 0) {
            const { error: dispatchError } = await db
              .from("link_dispatches")
              .update({
                shortio_first_clicked_at: clickInstants[0],
                shortio_last_clicked_at: clickInstants[clickInstants.length - 1],
                shortio_click_count: clicks,
              })
              .eq("tenant_id", link.tenant_id)
              .eq("tracked_link_id", link.id);
            if (dispatchError) throw new Error(dispatchError.message);
          }
          await db
            .from("tracked_links")
            .update({ last_synced_at: new Date().toISOString() })
            .eq("id", link.id);
          processed++;
        } catch (syncError) {
          failures++;
          console.error("Falha ao sincronizar métricas Short.io", {
            linkId: link.id,
            error: syncError instanceof Error ? syncError.message : String(syncError),
          });
        }
      }),
    );
  }
  if (runId) {
    await db
      .from("link_tracking_sync_runs")
      .update({
        finished_at: new Date().toISOString(),
        status: failures ? "failed" : "completed",
        links_processed: processed,
        cursor: links?.length ? String(links[links.length - 1].id) : null,
        error: failures ? `${failures} links falharam` : null,
      })
      .eq("id", runId);
  }
  return { startedAt, processed, failures, total: (links ?? []).length };
}

// ============================================================
// ENV-10 — batch preparation for bulk SMS sends.
//
// Same rules as prepareTrackedText (one tracked link + one dispatch per
// recipient and URL position, deterministic tokens, fallback_mode), but the
// database work is done in set-based statements and the missing short links
// are created with Short.io's bulk endpoint (<= 1000 links per call), paced by
// the `shortio` global budget in channel_rate_limits (1 token per HTTP call).
//
// Fallback when Short.io cannot shorten a link:
//   fallback_mode = 'passthrough' -> the first-party redirect
//     (/api/public/click/<token>?s=...) is sent unshortened. Clicks are still
//     attributed: the redirect resolves the dispatch by token. A tracked_links
//     row with status 'failed' satisfies the dispatch FK and is skipped by the
//     Short.io metrics sync (which reads only 'active' rows).
//   fallback_mode = 'block' -> the item comes back with an error and the caller
//     must not send it (same as prepareTrackedText throwing).
// ============================================================

export type BatchTrackedTextInput = { content: string; context: LinkTrackingContext };

export type BatchTrackedTextResult =
  | (PreparedText & { ok: true; unshortened: number })
  | { ok: false; error: string; fallbackMode: "block" | "passthrough" };

type ShortioBulkLink = { originalUrl: string; created: CreatedLink | null; error: string | null };

const SHORTIO_BUDGET_MAX_WAIT_MS = 3_000;
const DB_IN_CHUNK = 200;

async function chunked<T>(items: T[], size: number, fn: (part: T[]) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) await fn(items.slice(i, i + size));
}

async function runLimited<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

/** One `shortio` budget token per Short.io HTTP call (global 40/s). */
async function acquireShortioCall(tenantId: string): Promise<boolean> {
  const deadline = Date.now() + SHORTIO_BUDGET_MAX_WAIT_MS;
  while (true) {
    const grant = await channelBudget.consume(tenantId, "shortio", 1);
    if (grant.granted >= 1) return true;
    // The limiter itself is unavailable: the single-link path never consumed
    // this budget, so a limiter outage must not become a tracking outage.
    if (grant.limitedBy === "error") return true;
    const waitMs = Math.min(1_000, Math.max(100, grant.retryAfterMs || 250));
    if (Date.now() + waitMs > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

function parseBulkLink(item: unknown): CreatedLink | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  if (o.error) return null;
  const id = o.idString ?? o.id;
  if ((typeof id !== "string" && typeof id !== "number") || typeof o.shortURL !== "string")
    return null;
  return { id: String(id), shortURL: o.shortURL, path: typeof o.path === "string" ? o.path : null };
}

/**
 * Creates short links in bulk (POST /links/bulk, <= 1000 per call). Never
 * throws: each URL comes back with the created link or the reason it failed.
 */
export async function createShortioLinksBulk(input: {
  tenantId: string;
  originalUrls: string[];
  domain: string;
  ttlDays: number | null;
  sourceType: string;
}): Promise<ShortioBulkLink[]> {
  const urls = Array.from(new Set(input.originalUrls));
  const out = new Map<string, ShortioBulkLink>();
  const apiKey = process.env.SHORTIO_API_KEY?.trim();
  if (!apiKey) {
    return urls.map((originalUrl) => ({
      originalUrl,
      created: null,
      error: "SHORTIO_API_KEY não configurada no servidor",
    }));
  }
  const ttl = input.ttlDays ? new Date(Date.now() + input.ttlDays * 86400000).toISOString() : null;
  // Never-throws contract: a demo/unknown tenant gets DEMO_SEND_BLOCKED on
  // every link and no request is made.
  const demoBlocked = await demoSendBlockedReason(input.tenantId);
  if (demoBlocked) {
    return urls.map((originalUrl) => ({ originalUrl, created: null, error: demoBlocked }));
  }
  for (let offset = 0; offset < urls.length; offset += SHORTIO_BULK_MAX_LINKS) {
    const part = urls.slice(offset, offset + SHORTIO_BULK_MAX_LINKS);
    const payload = {
      domain: input.domain,
      allowDuplicates: false,
      links: part.map((originalURL) => ({
        originalURL,
        title: SHORTIO_LINK_TITLE,
        tags: ["betleads", input.sourceType.slice(0, 64)],
        ...(ttl ? { ttl } : {}),
      })),
    };
    let lastError = "";
    let items: unknown[] | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (!(await acquireShortioCall(input.tenantId))) {
        lastError = "orçamento da API Short.io esgotado";
        break;
      }
      // Demo guard immediately before the request.
      const blockedNow = await demoSendBlockedReason(input.tenantId);
      if (blockedNow) {
        lastError = blockedNow;
        break;
      }
      try {
        const response = await fetch(SHORTIO_BULK_API_URL, {
          method: "POST",
          headers: {
            Authorization: apiKey,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(20_000),
        });
        const body = (await response.json().catch(() => null)) as unknown;
        const list = Array.isArray(body)
          ? body
          : body && typeof body === "object" && Array.isArray((body as { links?: unknown }).links)
            ? (body as { links: unknown[] }).links
            : null;
        if (response.ok && list) {
          items = list;
          break;
        }
        lastError = `Short.io retornou HTTP ${response.status}`;
        if (response.status !== 429 && response.status < 500) break;
      } catch (error) {
        // allowDuplicates=false: a resend returns the links created before.
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
    if (!items) {
      for (const originalUrl of part)
        out.set(originalUrl, {
          originalUrl,
          created: null,
          error: `Falha ao criar links Short.io em lote: ${lastError || "sem resposta"}`,
        });
      continue;
    }
    // QA I4: match ONLY by the echoed originalURL. A positional fallback could
    // bind one recipient's link to another's token; an unmatched URL is a
    // Short.io failure for that link (fallback_mode decides what happens).
    // Exact echo, compared after WHATWG URL serialisation on both sides.
    const canonical = (raw: string) => {
      try {
        return new URL(raw).toString();
      } catch {
        return raw;
      }
    };
    const byOriginal = new Map<string, unknown>();
    for (const it of items) {
      const original =
        it && typeof it === "object" ? (it as Record<string, unknown>).originalURL : null;
      if (typeof original === "string" && !byOriginal.has(canonical(original)))
        byOriginal.set(canonical(original), it);
    }
    for (const originalUrl of part) {
      const created = parseBulkLink(byOriginal.get(canonical(originalUrl)));
      out.set(originalUrl, {
        originalUrl,
        created,
        error: created ? null : "Short.io não confirmou o link criado (originalURL ausente na resposta)",
      });
    }
  }
  return urls.map((url) => out.get(url)!);
}

async function selectTrackedLinksByHash(tenantId: string, hashes: string[]) {
  const db = supabaseAdmin as any;
  const found = new Map<string, { id: string; short_url: string }>();
  await chunked(Array.from(new Set(hashes)), DB_IN_CHUNK, async (part) => {
    const { data, error } = await db
      .from("tracked_links")
      .select("id,short_url,canonical_url_hash")
      .eq("tenant_id", tenantId)
      .in("canonical_url_hash", part);
    if (error) throw new Error(`Falha ao consultar links rastreados: ${error.message}`);
    for (const row of (data ?? []) as Array<Record<string, unknown>>)
      found.set(String(row.canonical_url_hash), {
        id: String(row.id),
        short_url: String(row.short_url),
      });
  });
  return found;
}

async function insertTrackedLinks(rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) return;
  const db = supabaseAdmin as any;
  await chunked(rows, 500, async (part) => {
    const { error } = await db
      .from("tracked_links")
      .upsert(part, { onConflict: "tenant_id,canonical_url_hash", ignoreDuplicates: true });
    if (error) throw new Error(`Falha ao persistir links rastreados: ${error.message}`);
  });
}

/** Experiments are rare: one lookup per (tenant, source) before any per-recipient RPC. */
async function experimentsForBatch(contexts: LinkTrackingContext[]) {
  const result = new Map<number, Awaited<ReturnType<typeof experimentForContext>>>();
  const sources = new Map<string, number[]>();
  contexts.forEach((context, index) => {
    if (
      (context.sourceType !== "campaign" && context.sourceType !== "journey") ||
      !context.sourceId ||
      !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(context.sourceId)
    )
      return;
    const key = `${context.tenantId}|${context.sourceType}|${context.sourceId}`;
    sources.set(key, [...(sources.get(key) ?? []), index]);
  });
  for (const [key, indexes] of sources) {
    const [tenantId, sourceType, sourceId] = key.split("|");
    const { data, error } = await (supabaseAdmin as any)
      .from("conversion_experiments")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("source_type", sourceType)
      .eq("source_id", sourceId)
      .eq("status", "active")
      .limit(1);
    if (error) throw new Error(`Falha ao consultar experimentos: ${error.message}`);
    if (!Array.isArray(data) || data.length === 0) continue;
    await runLimited(indexes, 10, async (index) => {
      result.set(index, await experimentForContext(contexts[index]));
    });
  }
  return result;
}

type PlannedLink = {
  item: number;
  position: number;
  start: number;
  end: number;
  raw: string;
  token: string;
  finalDestination: string;
  firstParty: string;
  hash: string;
  context: LinkTrackingContext;
};

/**
 * Batch counterpart of prepareTrackedText. Items may belong to different
 * tenants; each result is independent (an error never leaks to other items).
 */
export async function prepareTrackedTextBatch(
  inputs: BatchTrackedTextInput[],
): Promise<BatchTrackedTextResult[]> {
  const results: Array<BatchTrackedTextResult | undefined> = new Array(inputs.length);
  const byTenant = new Map<string, number[]>();
  inputs.forEach((input, index) => {
    byTenant.set(input.context.tenantId, [...(byTenant.get(input.context.tenantId) ?? []), index]);
  });

  for (const [tenantId, indexes] of byTenant) {
    const settings = await settingsForTenant(tenantId);
    const active: number[] = [];
    for (const index of indexes) {
      const { context, content } = inputs[index];
      if (
        context.enabled === false ||
        !settings.enabled ||
        !settings.enabled_channels.includes(context.channel)
      ) {
        results[index] = { ok: true, content, links: [], trackingEnabled: false, unshortened: 0 };
      } else active.push(index);
    }
    if (active.length === 0) continue;

    // Demo tenant: no link, no dispatch; its items come back as 'block' so
    // the caller does not send them (other tenants are unaffected).
    const demoBlocked = await demoSendBlockedReason(tenantId);
    if (demoBlocked) {
      for (const index of active)
        results[index] = { ok: false, error: demoBlocked, fallbackMode: "block" };
      continue;
    }

    const fail = (index: number, error: unknown) => {
      if (results[index]) return;
      results[index] = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        fallbackMode: settings.fallback_mode,
      };
    };

    const experiments = await experimentsForBatch(active.map((i) => inputs[i].context));
    const dnsChecks = new Map<string, Promise<void>>();
    const planned: PlannedLink[] = [];
    for (let k = 0; k < active.length; k++) {
      const index = active[k];
      const experiment = experiments.get(k) ?? null;
      const base = inputs[index].context;
      const context: LinkTrackingContext = experiment
        ? { ...base, experimentId: experiment.experiment_id, experimentVariant: experiment.variant }
        : base;
      const matches = Array.from(inputs[index].content.matchAll(URL_PATTERN));
      for (let position = 0; position < matches.length; position++) {
        const match = matches[position];
        const matchedRaw = stripTrackingUrlTrailingPunctuation(match[0]);
        const originalRaw = normalizeTrackingUrl(matchedRaw);
        const variantUrl =
          experiment?.dimension === "cta" ? experiment.payload.destination_url : null;
        const raw = typeof variantUrl === "string" && variantUrl ? variantUrl : originalRaw;
        if (
          !raw ||
          isProtectedDestination(originalRaw) ||
          !isShortioEligibleUrl(raw, {
            domain: settings.domain,
            allowedHosts: settings.allowed_destination_hosts,
          })
        )
          continue;
        try {
          let check = dnsChecks.get(raw);
          if (!check) {
            check = assertResolvedPublicDestination(raw);
            check.catch(() => undefined);
            dnsChecks.set(raw, check);
          }
          await check;
          const token = await deterministicToken(context, position);
          const firstParty = await buildFirstPartyClickUrl(token);
          const start = match.index ?? 0;
          planned.push({
            item: index,
            position,
            start,
            end: start + matchedRaw.length,
            raw,
            token,
            finalDestination: withDeliveryContext(raw, context),
            firstParty,
            hash: await canonicalHash(firstParty),
            context,
          });
        } catch (error) {
          // Same as prepareTrackedText: passthrough leaves this URL untouched.
          if (settings.fallback_mode === "block") fail(index, error);
        }
      }
    }

    // Tracked links: reuse existing rows (retries), create the rest in bulk.
    const live = () => planned.filter((p) => !results[p.item]);
    let tracked = await selectTrackedLinksByHash(
      tenantId,
      live().map((p) => p.hash),
    );
    const missing = new Map<string, PlannedLink>();
    for (const p of live()) if (!tracked.has(p.hash)) missing.set(p.hash, p);
    if (missing.size > 0) {
      const missingList = Array.from(missing.values());
      const bulk: ShortioBulkLink[] = settings.domain
        ? await createShortioLinksBulk({
            tenantId,
            originalUrls: missingList.map((p) => p.firstParty),
            domain: settings.domain,
            ttlDays: settings.default_ttl_days,
            sourceType: missingList[0].context.sourceType,
          })
        : missingList.map((p) => ({
            originalUrl: p.firstParty,
            created: null,
            error: "SHORTIO_DOMAIN não configurado para este tenant",
          }));
      const byUrl = new Map(bulk.map((b) => [b.originalUrl, b]));
      const expiresAt = settings.default_ttl_days
        ? new Date(Date.now() + settings.default_ttl_days * 86400000).toISOString()
        : null;
      const rows: Array<Record<string, unknown>> = [];
      const shortenFailures: Array<{ p: PlannedLink; error: string }> = [];
      for (const p of missingList) {
        const b = byUrl.get(p.firstParty);
        if (b?.created) {
          rows.push({
            tenant_id: tenantId,
            shortio_link_id: b.created.id,
            short_url: b.created.shortURL,
            original_url: p.firstParty,
            canonical_url_hash: p.hash,
            path: b.created.path ?? null,
            expires_at: expiresAt,
          });
        } else {
          shortenFailures.push({ p, error: b?.error ?? "Short.io não criou o link" });
        }
      }
      for (const { p, error } of shortenFailures) {
        if (settings.fallback_mode === "block") {
          for (const q of planned) if (q.hash === p.hash) fail(q.item, new Error(error));
          continue;
        }
        rows.push({
          tenant_id: tenantId,
          shortio_link_id: `first-party:${p.hash.slice(0, 40)}`,
          short_url: p.firstParty,
          original_url: p.firstParty,
          canonical_url_hash: p.hash,
          path: null,
          status: "failed",
          expires_at: expiresAt,
        });
      }
      if (shortenFailures.length > 0)
        console.warn("[shortio] bulk shortening failed", {
          tenantId,
          links: shortenFailures.length,
          fallbackMode: settings.fallback_mode,
          error: shortenFailures[0].error,
        });
      try {
        await insertTrackedLinks(rows);
        tracked = await selectTrackedLinksByHash(
          tenantId,
          live().map((p) => p.hash),
        );
      } catch (error) {
        for (const p of live()) if (!tracked.has(p.hash)) fail(p.item, error);
      }
    }

    // Dispatch rows: one upsert per chunk, then read back the ids (a retry of
    // the same delivery returns the rows written by the first attempt).
    const dispatchRows = live()
      .filter((p) => tracked.has(p.hash))
      .map((p) => ({
        p,
        row: {
          tenant_id: tenantId,
          idempotency_key: `${p.context.deliveryKey ?? p.context.messageLogId ?? p.context.sourceId ?? "one-off"}:${p.position}`,
          tracked_link_id: tracked.get(p.hash)!.id,
          tracking_token: p.token,
          channel: p.context.channel,
          recipient_player_id: p.context.recipientPlayerId ?? null,
          recipient_hash: p.context.recipientHash ?? null,
          source_type: p.context.sourceType,
          source_id: p.context.sourceId ?? null,
          message_log_type: p.context.messageLogType ?? null,
          message_log_id: p.context.messageLogId ?? null,
          url_position: p.position,
          original_url: p.finalDestination,
          sent_url: tracked.get(p.hash)!.short_url,
          experiment_id: p.context.experimentId ?? null,
          experiment_variant: p.context.experimentVariant ?? null,
          journey_step_id: p.context.journeyStepId ?? null,
          journey_step_position: p.context.journeyStepPosition ?? null,
        },
      }));
    const dispatchIds = new Map<string, { id: string; messageLogId: string | null }>();
    try {
      const db = supabaseAdmin as any;
      await chunked(dispatchRows, 500, async (part) => {
        const { error } = await db.from("link_dispatches").upsert(
          part.map((d) => d.row),
          { onConflict: "tenant_id,idempotency_key", ignoreDuplicates: true },
        );
        if (error) throw new Error(`Falha ao registrar dispatches de link: ${error.message}`);
      });
      await chunked(
        dispatchRows.map((d) => d.row.idempotency_key),
        DB_IN_CHUNK,
        async (keys) => {
          const { data, error } = await db
            .from("link_dispatches")
            .select("id,idempotency_key,message_log_id")
            .eq("tenant_id", tenantId)
            .in("idempotency_key", keys);
          if (error) throw new Error(`Falha ao ler dispatches de link: ${error.message}`);
          for (const row of (data ?? []) as Array<Record<string, unknown>>)
            dispatchIds.set(String(row.idempotency_key), {
              id: String(row.id),
              messageLogId: (row.message_log_id as string | null) ?? null,
            });
        },
      );
      // A retried delivery (new send log) re-binds its pre-existing dispatches.
      for (const d of dispatchRows) {
        const existing = dispatchIds.get(d.row.idempotency_key);
        if (existing && d.row.message_log_id && existing.messageLogId !== d.row.message_log_id) {
          await db
            .from("link_dispatches")
            .update({
              message_log_id: d.row.message_log_id,
              message_log_type: d.row.message_log_type,
            })
            .eq("id", existing.id);
        }
      }
    } catch (error) {
      for (const d of dispatchRows) fail(d.p.item, error);
    }

    // Assemble the rewritten text per item.
    for (const index of active) {
      if (results[index]) continue;
      const mine = dispatchRows.filter((d) => d.p.item === index);
      const links: PreparedTrackedLink[] = [];
      const replacements: Array<{ start: number; end: number; value: string }> = [];
      let unshortened = 0;
      let missingDispatch = false;
      for (const { p, row } of mine) {
        const dispatch = dispatchIds.get(row.idempotency_key);
        if (!dispatch) {
          missingDispatch = true;
          break;
        }
        if (row.sent_url === p.firstParty) unshortened++;
        replacements.push({ start: p.start, end: p.end, value: row.sent_url });
        links.push({
          trackedLinkId: row.tracked_link_id,
          dispatchId: dispatch.id,
          shortUrl: row.sent_url,
          originalUrl: p.raw,
          trackingToken: p.token,
        });
      }
      if (missingDispatch) {
        fail(index, new Error("Dispatch de link não encontrado após registro"));
        continue;
      }
      let rewritten = inputs[index].content;
      for (const r of replacements.sort((a, b) => b.start - a.start))
        rewritten = `${rewritten.slice(0, r.start)}${r.value}${rewritten.slice(r.end)}`;
      results[index] = { ok: true, content: rewritten, links, trackingEnabled: true, unshortened };
    }
  }
  return results as BatchTrackedTextResult[];
}
