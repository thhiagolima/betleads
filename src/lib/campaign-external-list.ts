// SMS campaign to an external phone list (e.g. leads of another house).
// The numbers are NOT saved as players: they live only in the campaign row
// (`sms_campaigns.recipients`), in the send logs and, hashed, in the tracked
// link dispatches. Pure and client-safe: used by the composer, the server
// functions and the campaign worker.
import { normalizeBrazilianPhone } from "./phone-normalization";

/** Same cap as the other SMS campaign inputs. */
export const EXTERNAL_LIST_MAX_PHONES = 20_000;

export type ParsedPhoneList = {
  /** Valid numbers, canonical `+55…`, first occurrence order, no duplicates. */
  phones: string[];
  /** Cells that carry digits but are not a valid Brazilian phone (sample kept short). */
  invalid: string[];
  invalidCount: number;
  duplicates: number;
};

const INVALID_SAMPLE = 20;

/**
 * Extracts phones from pasted text or a CSV/TXT/spreadsheet export. Cells are
 * split on line breaks and column separators (never on spaces, so
 * "(11) 98765-4321" stays one number). Cells without digits (headers, names)
 * are ignored; cells with digits that do not form a phone are counted invalid.
 */
export function parsePhoneList(text: string): ParsedPhoneList {
  const seen = new Set<string>();
  const phones: string[] = [];
  const invalid: string[] = [];
  let invalidCount = 0;
  let duplicates = 0;
  for (const rawCell of text.split(/[\r\n,;\t|]+/)) {
    const cell = rawCell
      .trim()
      .replace(/^"+|"+$/g, "")
      .trim();
    if (!/\d/.test(cell)) continue;
    const phone = normalizeBrazilianPhone(cell);
    if (!phone) {
      invalidCount++;
      if (invalid.length < INVALID_SAMPLE) invalid.push(cell.slice(0, 40));
      continue;
    }
    if (seen.has(phone)) {
      duplicates++;
      continue;
    }
    seen.add(phone);
    phones.push(phone);
  }
  return { phones, invalid, invalidCount, duplicates };
}

/** `{link}` and every `{link_*}` come from the house config, not from a player. */
function isHouseLinkVariable(key: string) {
  return key === "link" || key.startsWith("link_");
}

/**
 * Variables an external-list message cannot use: anything but the house links.
 * There is no player behind the number, so `{nome}`, `{saldo}`… would go out
 * empty or literal.
 */
export function externalListBlockedVariables(content: string): string[] {
  const keys = [...content.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1]);
  return [...new Set(keys)].filter((key) => !isHouseLinkVariable(key));
}

export function externalListVariablesError(blocked: readonly string[]): string {
  return `Campanhas para lista de números não aceitam variáveis de jogador (${blocked
    .map((key) => `{${key}}`)
    .join(", ")}). Use apenas texto e links.`;
}

/**
 * Stable recipient key for a tracked link sent to an external number
 * (`link_dispatches.recipient_hash`). When that number later registers in the
 * house, the registration webhook recomputes it from the new player's phone and
 * binds the dispatch to the player, so the usual click attribution applies.
 */
export async function externalRecipientHash(tenantId: string, e164: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`sms-external|${tenantId}|${e164}`),
  );
  return `ext:${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}
