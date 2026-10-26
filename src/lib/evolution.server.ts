// Server-only HTTP wrapper for the Evolution API.
// Never import from client code.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { DemoTenantBlockedError } from "@/lib/demo-tenant";
import { isSendBlockedError } from "@/lib/billing/billing-locked-error";
import { assertTenantNotDemoForSend } from "@/lib/tenant-access.server";

// The one call allowed without any tenant check: the bare instance listing,
// used by the super-admin diagnosis (`diagnoseEvolutionFor`). It is exempt
// only when the caller passes no `init.tenantId`; a caller acting for a
// tenant (e.g. `syncWhatsappSessions`) must pass it so that tenant is checked.
// Keep this minimal and explicit.
const EVOLUTION_TENANT_GUARD_EXEMPT_PATH = "/instance/fetchInstances";

// Two-segment actions that take no instance in the path.
const EVOLUTION_ACTIONS_WITHOUT_INSTANCE = new Set(["/instance/create", "/instance/fetchInstances"]);

type ParsedEvolutionPath = { pathname: string; instance: string | null };

/**
 * Parses an Evolution path into its pathname and the instance it acts on:
 * the segment after the action (`/message/sendText/{instance}`,
 * `/instance/connect/{instance}`, ...), URL-decoded, or, only for
 * `/instance/fetchInstances`, its `instanceName` query param.
 *
 * Returns null (= blocked) for anything that could make the request target a
 * different instance than the one checked: `.`/`..` segments (raw or
 * percent-encoded), empty segments, encoded `/` or a backslash, a fragment, a
 * pathname the URL parser would rewrite, extra segments after the instance,
 * or a missing instance where the action takes one.
 */
function parseEvolutionPath(path: string): ParsedEvolutionPath | null {
  if (!path.startsWith("/") || path.includes("\\") || path.includes("#")) return null;
  const queryAt = path.indexOf("?");
  const pathname = queryAt === -1 ? path : path.slice(0, queryAt);
  const query = queryAt === -1 ? "" : path.slice(queryAt + 1);

  let segments: string[];
  try {
    segments = pathname.split("/").slice(1).map((segment) => decodeURIComponent(segment));
    if (new URL(pathname, "https://evolution.invalid").pathname !== pathname) return null;
  } catch {
    return null;
  }
  const unsafe = (segment: string) =>
    segment === "" ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\");
  if (segments.some(unsafe)) return null;

  const action = `/${segments[0]}/${segments[1]}`;
  if (segments.length === 2 && EVOLUTION_ACTIONS_WITHOUT_INSTANCE.has(pathname)) {
    if (pathname !== "/instance/fetchInstances") return { pathname, instance: null };
    const names = new URLSearchParams(query).getAll("instanceName");
    if (names.length > 1) return null;
    return { pathname, instance: names[0] || null };
  }
  if (segments.length === 3 && !EVOLUTION_ACTIONS_WITHOUT_INSTANCE.has(action)) {
    return { pathname, instance: segments[2] };
  }
  return null;
}

/** `whatsapp_sessions` owner of `instance`; `found: false` when there is no row. */
export async function instanceOwner(instance: string) {
  const { data, error } = await supabaseAdmin
    .from("whatsapp_sessions")
    .select("tenant_id")
    .eq("instance_name", instance)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as { tenant_id?: string | null } | null;
  return { found: row !== null, tenantId: row?.tenant_id ?? null };
}

/**
 * Fail-closed demo guard for any Evolution call on `instance`.
 * - Without `tenantId`: the tenant is the owner of the `whatsapp_sessions`
 *   row with this `instance_name`. No instance, no row, an unknown tenant or
 *   a demo tenant → `DEMO_SEND_BLOCKED`.
 * - With `tenantId` (the caller knows it, e.g. `/instance/create` before the
 *   row exists): that tenant is checked, and if the instance already has a
 *   row it must belong to that same tenant.
 * A lookup error propagates (the call never happens).
 */
export async function assertEvolutionInstanceCanCall(
  instance: string | null | undefined,
  tenantId?: string | null,
): Promise<void> {
  if (tenantId) {
    if (instance) {
      const owner = await instanceOwner(instance);
      if (owner.found && owner.tenantId !== tenantId) {
        throw new DemoTenantBlockedError("DEMO_SEND_BLOCKED");
      }
    }
    return assertTenantNotDemoForSend(tenantId);
  }
  if (!instance) throw new DemoTenantBlockedError("DEMO_SEND_BLOCKED");
  const owner = await instanceOwner(instance);
  await assertTenantNotDemoForSend(owner.tenantId);
}

function bodyInstanceName(body: unknown): string | null {
  const name = (body as { instanceName?: unknown } | null | undefined)?.instanceName;
  return typeof name === "string" && name ? name : null;
}

async function assertEvolutionPathCanCall(
  path: string,
  init: { body?: unknown; tenantId?: string },
) {
  const parsed = parseEvolutionPath(path);
  if (!parsed) throw new DemoTenantBlockedError("DEMO_SEND_BLOCKED");
  if (!parsed.instance && !init.tenantId && parsed.pathname === EVOLUTION_TENANT_GUARD_EXEMPT_PATH) {
    return;
  }
  const target = parsed.instance ?? (init.tenantId ? bodyInstanceName(init.body) : null);
  await assertEvolutionInstanceCanCall(target, init.tenantId);
}

function getConfig() {
  // Single source of truth — only these two secrets. No legacy/accented
  // fallbacks so a stale secret can never override the canonical value.
  const url = process.env.EVOLUTION_API_URL;
  const key = process.env.EVOLUTION_API_KEY;
  if (!url || !key) {
    throw new Error("Evolution API URL or API key not configured");
  }
  const normalizedUrl = url.trim().replace(/\/$/, "");
  // Strip only accidental wrapping quotes / surrounding whitespace.
  const normalizedKey = key.trim().replace(/^['"]|['"]$/g, "");
  return { url: normalizedUrl, key: normalizedKey };
}

export async function evolutionFetch(
  path: string,
  init: { method?: string; body?: unknown; tenantId?: string } = {},
): Promise<any> {
  const { url, key } = getConfig();
  // Valida o secret antes de chamar fetch. Cloudflare Workers bloqueia IP cru/HTTP
  // (error code: 1003) e fetch lança "Invalid URL" para strings sem esquema.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `EVOLUTION_API_URL inválido (não é uma URL): "${url}". ` +
        `Configure o secret com https://host[/path] — ex.: https://evolution.seudominio.com`,
    );
  }
  const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(parsed.hostname);
  if (parsed.protocol !== "https:" || isIp) {
    throw new Error(
      `EVOLUTION_API_URL precisa ser HTTPS com hostname (não IP). Atual: ${url}. ` +
        `Cloudflare Workers bloqueia chamadas para IP cru/HTTP ("error code: 1003"). ` +
        `Coloque a Evolution atrás de um domínio HTTPS (ex.: https://evolution.seudominio.com) e atualize o secret.`,
    );
  }
  // Demo/unknown tenants never reach Evolution (no message, no QR, no real
  // number). Right before the network call; fail-closed.
  await assertEvolutionPathCanCall(path, init);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const fullUrl = `${url}${path}`;
    const method = init.method ?? "GET";
    const headers = {
      "Content-Type": "application/json",
      apikey: key,
    };
    const body = init.body !== undefined ? JSON.stringify(init.body) : undefined;
    const sanitizePayload = (value: unknown): unknown => {
      if (typeof value === "string") {
        return value.length > 220 ? `[string length=${value.length} preview=${value.slice(0, 80)}…]` : value;
      }
      if (Array.isArray(value)) return value.map(sanitizePayload);
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([key, val]) => {
            const lower = key.toLowerCase();
            if (["base64", "media", "audio"].includes(lower) && typeof val === "string") {
              return [key, `[${lower} length=${val.length} preview=${val.slice(0, 80)}…]`];
            }
            return [key, sanitizePayload(val)];
          }),
        );
      }
      return value;
    };
    console.info(
      "[evolution] REQUEST",
      JSON.stringify({
        url: fullUrl,
        method,
        hasBody: body !== undefined,
        apikeyLength: key.length,
        payload: init.body === undefined ? undefined : sanitizePayload(init.body),
      }),
    );
    const res = await fetch(fullUrl, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
    if (!res.ok) {
      // Log RAW body so we can see exactly what Evolution complains about.
      console.error(
        `[evolution] ${method} ${path} -> ${res.status}`,
        "raw=", text.slice(0, 500),
      );
      let host = "";
      try { host = new URL(fullUrl).host; } catch {}
      const rawSnippet = text ? text.slice(0, 300) : "(empty body)";
      const isMediaPath = path.includes("/sendMedia") || path.includes("/sendWhatsAppAudio");
      const friendlySnippet =
        res.status === 403 && rawSnippet.includes("1003") && isMediaPath
          ? "payload de mídia rejeitado pela Evolution (verifique mimetype, tamanho e suporte do servidor de mídia)"
          : rawSnippet;
      const msg = `Evolution API ${res.status} on ${method} ${path} [host=${host}] raw=${friendlySnippet}`;
      const err = new Error(msg) as Error & { status?: number; rawBody?: string };
      err.status = res.status;
      err.rawBody = text;
      throw err;
    }
    console.info(
      `[evolution] ${method} ${path} -> ${res.status}`,
      "raw=",
      text.slice(0, 2000),
    );
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

export function isEvolutionConnectionClosed(error: unknown): boolean {
  // A demo block or a billing lock is never a dropped session: it must
  // propagate as-is.
  if (isSendBlockedError(error)) return false;
  const raw = `${(error as any)?.rawBody ?? ""} ${(error as any)?.message ?? ""}`;
  return /Connection Closed|Precondition Required|statusCode"?:428/i.test(raw);
}

export function mapEvolutionState(state?: string): string {
  switch (state) {
    case "open":
      return "connected";
    case "connecting":
      return "connecting";
    case "close":
    case "closed":
      return "disconnected";
    default:
      return state ?? "disconnected";
  }
}

/**
 * Aplica configuração de proxy a uma instância da Evolution API.
 * - Passa `proxy` para habilitar, `null` para desabilitar.
 * Lança erro se a Evolution recusar.
 */
export async function setEvolutionProxy(
  instanceName: string,
  proxy:
    | {
        protocol: string;
        host: string;
        port: number;
        username?: string | null;
        password?: string | null;
      }
    | null,
): Promise<void> {
  const body = proxy
    ? {
        enabled: true,
        host: proxy.host,
        port: String(proxy.port),
        protocol: proxy.protocol,
        username: proxy.username || "",
        password: proxy.password || "",
      }
    : { enabled: false };
  await evolutionFetch(`/proxy/set/${encodeURIComponent(instanceName)}`, {
    method: "POST",
    body,
  });
}