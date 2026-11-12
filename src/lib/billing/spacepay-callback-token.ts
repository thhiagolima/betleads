// Per-charge token embedded in the SpacePay callback URL. The proxy doesn't
// sign its callback, so authenticity comes from this token (unguessable, no
// personal data) plus a fresh GET /transactions/{id} before crediting.
//
// Format: `${base64url(externalId)}.${hex HMAC-SHA256(secret, externalId)}`.
// Web Crypto only (no node:crypto / Buffer): this module is reachable from
// *.functions.ts files that the client bundle imports (via pix-gateway.server
// → spacepay-pix.server), and a Node built-in there breaks the browser build.

const HEX_SHA256 = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64UrlEncode(text: string): string {
  let binary = "";
  for (const byte of encoder.encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** null when `encoded` is not valid base64url of valid UTF-8. */
function base64UrlDecode(encoded: string): string | null {
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function sign(externalId: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(externalId)));
}

/** Constant-time comparison of two equal-format hex strings. */
function hexEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function spacePayCallbackToken(externalId: string, secret: string): Promise<string> {
  return `${base64UrlEncode(externalId)}.${await sign(externalId, secret)}`;
}

export async function verifySpacePayCallbackToken(
  token: string,
  secret: string,
): Promise<{ ok: true; externalId: string } | { ok: false; reason: "malformed" | "bad_signature" }> {
  if (typeof token !== "string" || !secret) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [encoded, signature] = parts;
  if (!encoded || !BASE64URL.test(encoded) || !HEX_SHA256.test(signature)) {
    return { ok: false, reason: "malformed" };
  }

  const externalId = base64UrlDecode(encoded);
  // Reject non-canonical encodings (and invalid UTF-8) so one externalId has
  // exactly one valid token.
  if (!externalId || base64UrlEncode(externalId) !== encoded) {
    return { ok: false, reason: "malformed" };
  }

  if (!hexEquals(await sign(externalId, secret), signature)) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true, externalId };
}
