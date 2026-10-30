// Links no conteúdo de campanhas de expert (Área do Expert §8): texto/HTML
// livre, mas todo link precisa apontar para um destino da casa. A regra é a
// de `assertDestinationAllowed` (shortio.server.ts) em modo estrito: só os
// hosts liberados em shortio_settings.allowed_destination_hosts ou o site da
// casa (tenants.site_url e subdomínios — as URLs rápidas ficam nele); uma
// casa sem nenhum dos dois não libera nada. Domínios de encurtador da casa
// não entram de propósito: um link curto colado esconderia o destino.

import { assertDestinationAllowed, DestinationNotAllowedError } from "./shortio.server";

export { DestinationNotAllowedError };

export const EXPERT_LINK_NOT_ALLOWED = (host: string) =>
  `Link não permitido: ${host}. Use apenas links do site da casa (inclusive as URLs rápidas) ou dos domínios liberados pelo admin.`;

function hostOf(raw: string): string | null {
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return null;
  }
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
    for (const raw of extractContentUrls(content)) {
      if (isOwnStorageAsset(raw)) continue;
      const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
      try {
        await assertDestinationAllowed({ tenantId, url, strict: true });
      } catch (error) {
        if (error instanceof DestinationNotAllowedError)
          throw new DestinationNotAllowedError(EXPERT_LINK_NOT_ALLOWED(hostOf(raw) ?? raw.slice(0, 80)));
        throw error;
      }
    }
  }
}
