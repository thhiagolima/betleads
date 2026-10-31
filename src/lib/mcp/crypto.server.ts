// MCP financeiro: token crypto. Web Crypto only (globalThis.crypto) — no
// node:crypto — so this runs unmodified on Node and on Workers/Edge.

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Random token (base64url, no padding) from `bytes` bytes of CSPRNG output. */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return toBase64Url(buf);
}

/** SHA-256 of `value`, lower-case hex. Used to hash tokens before storage/lookup. */
export async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** PKCE S256: true when BASE64URL(SHA256(verifier)) === challenge (RFC 7636). */
export async function verifyPkceS256(verifier: string, challenge: string): Promise<boolean> {
  const data = new TextEncoder().encode(verifier);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return toBase64Url(new Uint8Array(digest)) === challenge;
}
