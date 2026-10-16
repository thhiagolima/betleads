// Server-only HTTP wrapper for the Evolution API.
// Never import from client code.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { DemoTenantBlockedError, isDemoBlockedError } from "@/lib/demo-tenant";
import { assertTenantNotDemoForSend } from "@/lib/tenant-access.server";

// Paths that carry no instance and are allowed without a tenant: only the
// super-admin diagnosis listing. Keep this list minimal and explicit.
const EVOLUTION_TENANT_GUARD_EXEMPT_PATHS = new Set(["/instance/fetchInstances"]);

/**
 * Instance an Evolution path acts on: the segment after the action
 * (`/message/sendText/{instance}`, `/instance/connect/{instance}`, ...), or the
 * `instanceName` query param of `/instance/fetchInstances?instanceName=`.
 * URL-decoded. Null when the path carries no (decodable) instance.
 */
function evolutionInstanceFromPath(path: string): string | null {
  const [pathname, query = ""] = path.split("?", 2);
  try {
    const fromQuery = new URLSearchParams(query).get("instanceName");
    if (fromQuery) return fromQuery;
    const segment = pathname.split("/").filter(Boolean)[2];
    return segment ? decodeURIComponent(segment) : null;
  } catch {
    return null;
  }
}

/**
 * Fail-closed demo guard for any Evolution call on `instance`. With an
 * explicit `tenantId` (the caller knows it, e.g. `/instance/create` before the
 * `whatsapp_sessions` row exists) that tenant is checked; otherwise the tenant
 * is the owner of the `whatsapp_sessions` row with this `instance_name`. No
 * instance, no row, an unknown tenant or a demo tenant → `DEMO_SEND_BLOCKED`.
 * A lookup error propagates (the call never happens).
 */
export async function assertEvolutionInstanceCanCall(
  instance: string | null | undefined,
  tenantId?: string | null,
): Promise<void> {
  if (tenantId) return assertTenantNotDemoForSend(tenantId);
  if (!instance) throw new DemoTenantBlockedError("DEMO_SEND_BLOCKED");
  const { data, error } = await supabaseAdmin
    .from("whatsapp_sessions")
    .select("tenant_id")
    .eq("instance_name", instance)
    .maybeSingle();
  if (error) throw new Error(error.message);
  await assertTenantNotDemoForSend((data as { tenant_id?: string | null } | null)?.tenant_id);
}

async function assertEvolutionPathCanCall(path: string, tenantId?: string | null) {
  const instance = evolutionInstanceFromPath(path);
  if (!instance && !tenantId && EVOLUTION_TENANT_GUARD_EXEMPT_PATHS.has(path.split("?", 1)[0])) {
    return;
  }
  await assertEvolutionInstanceCanCall(instance, tenantId);
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
  await assertEvolutionPathCanCall(path, init.tenantId);
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
  // A demo block is never a dropped session: it must propagate as-is.
  if (isDemoBlockedError(error)) return false;
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