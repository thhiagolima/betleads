// Links no conteúdo de campanhas de expert (Área do Expert §8): texto/HTML
// livre, mas todo link precisa apontar para um destino da casa.
//
// STUB — `assertDestinationAllowed` abaixo é provisória. O branch
// fix/expert-hardening adiciona a versão oficial, com esta mesma assinatura,
// em shortio.server.ts. Depois do merge, troque o corpo desta função por
//   export { assertDestinationAllowed } from "./shortio.server";
// (ou importe de lá em `assertExpertContentLinksAllowed`) e apague o stub.
//
// Regra do stub (fecha por padrão): o host precisa ser o do site da casa
// (tenants.site_url, ou um subdomínio dele), um domínio cadastrado da casa
// (tenant_domains não removido) ou um host liberado em
// shortio_settings.allowed_destination_hosts. Sem nenhum desses, nada passa.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const EXPERT_LINK_NOT_ALLOWED = (host: string) =>
  `Link não permitido: ${host}. Use apenas links da casa (site, URLs rápidas ou domínios cadastrados).`;

export class DestinationNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DestinationNotAllowedError";
  }
}

function hostOf(raw: string): string | null {
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

function hostMatches(host: string, allowed: string): boolean {
  const a = allowed.toLowerCase().replace(/^www\./, "");
  const h = host.replace(/^www\./, "");
  return h === a || h.endsWith(`.${a}`);
}

/* eslint-disable @typescript-eslint/no-explicit-any -- shortio_settings/tenant_domains columns are read loosely. */
async function houseAllowedHosts(tenantId: string): Promise<string[]> {
  const db = supabaseAdmin as any;
  const [tenant, domains, settings] = await Promise.all([
    db.from("tenants").select("site_url").eq("id", tenantId).maybeSingle(),
    db.from("tenant_domains").select("hostname").eq("tenant_id", tenantId).is("removed_at", null),
    db
      .from("shortio_settings")
      .select("allowed_destination_hosts")
      .eq("tenant_id", tenantId)
      .maybeSingle(),
  ]);
  for (const r of [tenant, domains, settings]) if (r.error) throw new Error(r.error.message);
  const hosts: string[] = [];
  const site = tenant.data?.site_url ? hostOf(String(tenant.data.site_url)) : null;
  if (site) hosts.push(site);
  for (const d of (domains.data ?? []) as Array<{ hostname?: string | null }>) {
    const h = d.hostname ? hostOf(String(d.hostname)) : null;
    if (h) hosts.push(h);
  }
  const extra = settings.data?.allowed_destination_hosts;
  if (Array.isArray(extra))
    for (const e of extra) {
      const h = hostOf(String(e ?? ""));
      if (h) hosts.push(h);
    }
  return Array.from(new Set(hosts));
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * STUB (ver cabeçalho). Lança `DestinationNotAllowedError` quando `url` não é
 * um destino da casa. `strict` = fecha por padrão (sem allowlist, recusa).
 */
export async function assertDestinationAllowed(args: {
  tenantId: string;
  url: string;
  strict: boolean;
}): Promise<void> {
  const host = hostOf(args.url);
  if (!host) throw new DestinationNotAllowedError(EXPERT_LINK_NOT_ALLOWED(args.url.slice(0, 80)));
  const allowed = await houseAllowedHosts(args.tenantId);
  if (allowed.length === 0 && !args.strict) return;
  if (!allowed.some((a) => hostMatches(host, a)))
    throw new DestinationNotAllowedError(EXPERT_LINK_NOT_ALLOWED(host));
}

const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"'()]+/gi;
const TRAILING = /[.,;:!?]+$/;

/** URLs de um texto ou HTML (mesmo padrão do rastreador de links). */
export function extractContentUrls(content: string): string[] {
  const out = new Set<string>();
  for (const match of content.matchAll(URL_PATTERN)) {
    const raw = match[0].replace(TRAILING, "");
    if (raw) out.add(raw);
  }
  return Array.from(out);
}

/** Imagens enviadas pelo editor ficam no Storage público do próprio projeto. */
function isOwnStorageAsset(raw: string): boolean {
  const base = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
  const own = base ? hostOf(base) : null;
  if (!own) return false;
  try {
    const url = new URL(raw);
    return url.hostname.toLowerCase() === own && url.pathname.startsWith("/storage/v1/object/public/");
  } catch {
    return false;
  }
}

/**
 * Todo link do conteúdo de uma campanha de expert passa por
 * `assertDestinationAllowed(strict)`. Variáveis `{link_*}` não são URLs aqui:
 * viram as URLs rápidas da casa na renderização.
 */
export async function assertExpertContentLinksAllowed(
  tenantId: string,
  ...contents: Array<string | null | undefined>
): Promise<void> {
  for (const content of contents) {
    if (!content) continue;
    for (const url of extractContentUrls(content)) {
      if (isOwnStorageAsset(url)) continue;
      await assertDestinationAllowed({ tenantId, url, strict: true });
    }
  }
}
