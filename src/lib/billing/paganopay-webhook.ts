// PaganoPay webhook signature verification (server-only).
//
// Headers: `X-Webhook-Signature: v1=<hex HMAC-SHA256>` and
// `X-Webhook-Timestamp: <unix seconds>`, where
// `v1 = HMAC-SHA256(webhookSecret, "<timestamp>.<rawBody>")`. Same algorithm
// as Upper (upper-webhook.ts); only the header layout differs. The raw body
// must be the exact bytes received (read with `request.text()` before any
// JSON parsing). Deliveries more than 5 min off our clock are refused.

import { createHmac, timingSafeEqual } from "node:crypto";

export type VerifyPaganoPaySignatureResult =
  | { ok: true; t: number }
  | { ok: false; reason: "missing" | "malformed" | "stale" | "mismatch" };

const MAX_SKEW_SECONDS = 300;
const SIGNATURE_PATTERN = /^(?:v1=)?([0-9a-f]+)$/i;
const TIMESTAMP_PATTERN = /^\d+$/;

export function verifyPaganoPaySignature(
  rawBody: string,
  signatureHeader: string | null,
  timestampHeader: string | null,
  secret: string,
  nowSec: number,
): VerifyPaganoPaySignatureResult {
  if (!signatureHeader || !timestampHeader) return { ok: false, reason: "missing" };

  const match = SIGNATURE_PATTERN.exec(signatureHeader.trim());
  const tRaw = timestampHeader.trim();
  if (!match || !TIMESTAMP_PATTERN.test(tRaw)) return { ok: false, reason: "malformed" };

  const receivedV1 = match[1].toLowerCase();
  // HMAC over the timestamp exactly as received (never a re-stringified number).
  const expectedV1 = createHmac("sha256", secret).update(`${tRaw}.${rawBody}`).digest("hex");

  const expectedBuf = Buffer.from(expectedV1, "utf8");
  const receivedBuf = Buffer.from(receivedV1, "utf8");
  const matches =
    expectedBuf.length === receivedBuf.length && timingSafeEqual(expectedBuf, receivedBuf);
  if (!matches) return { ok: false, reason: "mismatch" };

  const t = Number(tRaw);
  if (Math.abs(nowSec - t) > MAX_SKEW_SECONDS) return { ok: false, reason: "stale" };

  return { ok: true, t };
}

/** Tries every secret (current, replaced within 24 h, env); "missing"/"malformed" don't depend on it. */
export function verifyPaganoPaySignatureAny(
  rawBody: string,
  signatureHeader: string | null,
  timestampHeader: string | null,
  secrets: readonly string[],
  nowSec: number,
): VerifyPaganoPaySignatureResult {
  let result: VerifyPaganoPaySignatureResult = { ok: false, reason: "mismatch" };
  for (const secret of secrets) {
    result = verifyPaganoPaySignature(rawBody, signatureHeader, timestampHeader, secret, nowSec);
    if (result.ok || result.reason !== "mismatch") return result;
  }
  return result;
}
