// LIKE patterns built from outside values (provider callbacks): the value can
// never act as a wildcard.

/** Escapes `\`, `%` and `_` for a SQL LIKE pattern (default escape `\`). */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * `<value>:%` for a PostgREST `.like()`, or null when the value cannot be
 * made literal: PostgREST also reads `*` as `%`, with no escape for it.
 */
export function likeKeyPrefixPattern(value: string): string | null {
  if (!value || value.includes("*")) return null;
  return `${escapeLikePattern(value)}:%`;
}
