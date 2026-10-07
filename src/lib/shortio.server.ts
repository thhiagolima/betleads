/* eslint-disable @typescript-eslint/no-explicit-any -- tables are introduced by this migration and are absent from the checked-in generated Supabase types. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const SHORTIO_API_URL = "https://api.short.io/links";
const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
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
  if (!url.searchParams.has("utm_source")) url.searchParams.set("utm_source", "betleads");
  if (!url.searchParams.has("utm_medium")) url.searchParams.set("utm_medium", context.channel);
  if (!url.searchParams.has("utm_campaign"))
    url.searchParams.set("utm_campaign", context.sourceId ?? context.sourceType);
  if (!url.searchParams.has("utm_content")) url.searchParams.set("utm_content", token);
  return url.toString();
}

async function createShortioLink(input: {
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
    tags: ["betleads", input.sourceType.slice(0, 64)],
  };
  if (input.ttlDays) payload.ttl = new Date(Date.now() + input.ttlDays * 86400000).toISOString();

  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
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

  const matches = Array.from(content.matchAll(URL_PATTERN));
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  const links: PreparedTrackedLink[] = [];
  for (let position = 0; position < matches.length; position++) {
    const match = matches[position];
    const raw = stripTrackingUrlTrailingPunctuation(match[0]);
    if (
      !raw ||
      isProtectedDestination(raw) ||
      !isShortioEligibleUrl(raw, {
        domain: settings.domain,
        allowedHosts: settings.allowed_destination_hosts,
      })
    ) {
      continue;
    }
    try {
      await assertResolvedPublicDestination(raw);
      const trackingToken = await deterministicToken(context, position);
      const trackedOriginal = withTrackingToken(raw, trackingToken, context);
      const tracked = await getOrCreateTrackedLink({
        tenantId: context.tenantId,
        originalUrl: trackedOriginal,
        settings,
        sourceType: context.sourceType,
      });
      const dispatchId = await persistDispatch({
        trackedLinkId: tracked.id,
        trackingToken,
        originalUrl: raw,
        sentUrl: tracked.short_url,
        position,
        context,
      });
      const start = match.index ?? 0;
      replacements.push({ start, end: start + raw.length, value: tracked.short_url });
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
  const hrefPattern = /(\bhref\s*=\s*)(["'])([^"']*)\2/gi;
  const matches = Array.from(html.matchAll(hrefPattern));
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  const links: PreparedTrackedLink[] = [];
  for (let position = 0; position < matches.length; position++) {
    const match = matches[position];
    const raw = match[3].trim();
    let protectedLink = false;
    try {
      const parsed = new URL(raw);
      protectedLink = isProtectedDestination(parsed.toString());
    } catch {
      protectedLink = true;
    }
    if (
      protectedLink ||
      /(?:unsubscribe|descadastr|opt[ -]?out)/i.test(raw) ||
      !isShortioEligibleUrl(raw, {
        domain: settings.domain,
        allowedHosts: settings.allowed_destination_hosts,
      })
    ) {
      continue;
    }
    try {
      await assertResolvedPublicDestination(raw);
      const trackingToken = await deterministicToken({ ...context, channel: "email" }, position);
      const trackedOriginal = withTrackingToken(raw, trackingToken, {
        ...context,
        channel: "email",
      });
      const tracked = await getOrCreateTrackedLink({
        tenantId: context.tenantId,
        originalUrl: trackedOriginal,
        settings,
        sourceType: context.sourceType,
      });
      const dispatchId = await persistDispatch({
        trackedLinkId: tracked.id,
        trackingToken,
        originalUrl: raw,
        sentUrl: tracked.short_url,
        position,
        context: { ...context, channel: "email" },
      });
      const valueStart = (match.index ?? 0) + match[1].length + 1;
      replacements.push({
        start: valueStart,
        end: valueStart + raw.length,
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
    const { data: tenants, error: tenantsError } = await db
      .from("tracked_links")
      .select("tenant_id")
      .eq("status", "active")
      .limit(10_000);
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
  const staleBefore = new Date(Date.now() - 20 * 60_000).toISOString();
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

  const { data: previousRun } = await db
    .from("link_tracking_sync_runs")
    .select("cursor")
    .eq("tenant_id", tenantId)
    .eq("status", "completed")
    .not("cursor", "is", null)
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const cursor = typeof previousRun?.cursor === "string" ? previousRun.cursor : null;

  let query = db
    .from("tracked_links")
    .select("id,tenant_id,shortio_link_id")
    .eq("status", "active")
    .order("id", { ascending: true })
    .limit(limit);
  if (tenantId) query = query.eq("tenant_id", tenantId);
  if (cursor) query = query.gt("id", cursor);
  let { data: links, error } = await query;
  // Reached the end of the cursor window: begin the next reconciliation pass.
  if (!error && cursor && (!links || links.length === 0)) {
    const retry = await db
      .from("tracked_links")
      .select("id,tenant_id,shortio_link_id")
      .eq("status", "active")
      .eq("tenant_id", tenantId)
      .order("id", { ascending: true })
      .limit(limit);
    links = retry.data;
    error = retry.error;
  }
  if (error) throw new Error(`Falha ao listar links para sincronização: ${error.message}`);

  let processed = 0;
  let failures = 0;
  const snapshotAt = new Date();
  snapshotAt.setUTCMinutes(0, 0, 0);
  for (const link of links ?? []) {
    try {
      const response = await fetch(
        `https://statistics.short.io/statistics/link/${encodeURIComponent(link.shortio_link_id)}/by_interval`,
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
      if (!response.ok) throw new Error(`Short.io retornou HTTP ${response.status}`);
      const payload = (await response.json()) as {
        clicksStatistics?: Array<{ y?: number }>;
        // Kept for compatibility with older API responses.
        clickStatistics?: Array<{ y?: number }>;
      };
      const clicks = (payload.clicksStatistics ?? payload.clickStatistics ?? []).reduce(
        (total, item) => total + Number(item.y ?? 0),
        0,
      );
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
