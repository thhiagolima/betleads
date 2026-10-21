// Loads a tenant's house URL and quick links for message-template rendering
// (`template-vars.server.ts`). Cached per tenant for 60s so a batch dispatch
// (campaign/journey run) doesn't hit the DB once per recipient.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { buildQuickLinkUrl } from "@/lib/house-config";

export type HouseLinks = {
  siteUrl: string | null;
  quickLinks: Record<string, string>;
};

const HOUSE_LINKS_CACHE_TTL_MS = 60_000;
const houseLinksCache = new Map<string, { value: HouseLinks; expiresAt: number }>();

export function __resetHouseLinksCacheForTests() {
  houseLinksCache.clear();
}

/** `{siteUrl: null, quickLinks: {}}` for a tenant with no house URL — quick
 * links are meaningless without a base to resolve relative paths against. */
export async function loadHouseLinks(tenantId: string): Promise<HouseLinks> {
  const cached = houseLinksCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const { data: tenant, error: tenantError } = await supabaseAdmin
    .from("tenants")
    .select("site_url")
    .eq("id", tenantId)
    .maybeSingle();
  if (tenantError) throw new Error(`Falha ao carregar a URL da casa: ${tenantError.message}`);

  const siteUrl = tenant?.site_url ?? null;

  let quickLinks: Record<string, string> = {};
  if (siteUrl) {
    const { data: links, error: linksError } = await supabaseAdmin
      .from("tenant_quick_links")
      .select("key,path")
      .eq("tenant_id", tenantId);
    if (linksError) throw new Error(`Falha ao carregar as URLs rápidas: ${linksError.message}`);
    quickLinks = Object.fromEntries(
      (links ?? []).map((l) => [l.key, buildQuickLinkUrl(siteUrl, l.path)]),
    );
  }

  const value: HouseLinks = { siteUrl, quickLinks };
  houseLinksCache.set(tenantId, { value, expiresAt: Date.now() + HOUSE_LINKS_CACHE_TTL_MS });
  return value;
}
