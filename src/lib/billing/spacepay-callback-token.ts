// Per-charge token embedded in the SpacePay callback URL. The proxy doesn't
// sign its callback, so authenticity comes from this token (unguessable, no
// personal data) plus a fresh GET /transactions/{id} before crediting.
//
// Format: `${base64url(externalId)}.${hex HMAC-SHA256(secret, externalId)}`.
// Pure (node:crypto only) so the webhook route and the client share it.

import { createHmac, timingSafeEqual } from "node:crypto";

const HEX_SHA256 = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function sign(externalId: string, secret: string): string {
  return createHmac("sha256", secret).update(externalId, "utf8").digest("hex");
}

export function spacePayCallbackToken(externalId: string, secret: string): string {
  const encoded = Buffer.from(externalId, "utf8").toString("base64url");
  return `${encoded}.${sign(externalId, secret)}`;
}

export function verifySpacePayCallbackToken(
  token: string,
  secret: string,
): { ok: true; externalId: string } | { ok: false; reason: "malformed" | "bad_signature" } {
  if (typeof token !== "string" || !secret) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [encoded, signature] = parts;
  if (!encoded || !BASE64URL.test(encoded) || !HEX_SHA256.test(signature)) {
    return { ok: false, reason: "malformed" };
  }

  const externalId = Buffer.from(encoded, "base64url").toString("utf8");
  // Reject non-canonical encodings (and invalid UTF-8) so one externalId has
  // exactly one valid token.
  if (!externalId || Buffer.from(externalId, "utf8").toString("base64url") !== encoded) {
    return { ok: false, reason: "malformed" };
  }

  const expected = Buffer.from(sign(externalId, secret), "hex");
  const given = Buffer.from(signature, "hex");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true, externalId };
}
