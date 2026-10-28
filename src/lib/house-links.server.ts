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

/** Drops a tenant's cached house links so the next read picks up a change
 * made outside `loadHouseLinks` (e.g. `saveHouseSite`, the link-domain
 * change) instead of serving a stale value for up to
 * `HOUSE_LINKS_CACHE_TTL_MS`. */
export function invalidateHouseLinks(tenantId: string): void {
  houseLinksCache.delete(tenantId);
}

const LEGACY_HOUSE: HouseLinks = { siteUrl: null, quickLinks: {} };

/** `{siteUrl: null, quickLinks: {}}` for a tenant with no house URL — quick
 * links are meaningless without a base to resolve relative paths against.
 * Never throws: a DB error here must never break a send (e.g. a batch of
 * leads across several tenants in `runSmsFlowBatch`'s `Promise.all`), so any
 * failure is logged and treated the same as "no house configured" — the
 * caller gets the legacy rendering instead of a failed dispatch. The
 * fallback value is not cached, so the next call retries the query. */
export async function loadHouseLinks(tenantId: string): Promise<HouseLinks> {
  const cached = houseLinksCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const { data: tenant, error: tenantError } = await supabaseAdmin
      .from("tenants")
      .select("site_url")
      .eq("id", tenantId)
      .maybeSingle();
    if (tenantError) throw new Error(`Falha ao carregar a URL da casa: ${tenantError.message}`);

    // An empty string is not a configured house URL.
    const siteUrl = tenant?.site_url || null;

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
  } catch (error) {
    console.error("[house-links] falha ao carregar links da casa, usando legado", {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return LEGACY_HOUSE;
  }
}
