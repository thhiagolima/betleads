// Upper Pix webhook signature verification (server-only).
//
// Header: `X-Upper-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>`, where
// `v1 = HMAC-SHA256(UPPER_WEBHOOK_SECRET, "<t>.<rawBody>")`. The raw body
// must be the exact bytes received (read with `request.text()` before any
// JSON parsing) — re-serializing a parsed object would change the signature.

import { createHmac, timingSafeEqual } from "node:crypto";

export type VerifyUpperSignatureResult =
  | { ok: true; t: number }
  | { ok: false; reason: "missing" | "malformed" | "stale" | "mismatch" };

const MAX_SKEW_SECONDS = 300;
const HEADER_PATTERN = /^t=(\d+),v1=([0-9a-f]+)$/i;

export function verifyUpperSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  nowSec: number,
): VerifyUpperSignatureResult {
  if (!header) return { ok: false, reason: "missing" };

  const match = HEADER_PATTERN.exec(header.trim());
  if (!match) return { ok: false, reason: "malformed" };

  const t = Number(match[1]);
  const receivedV1 = match[2].toLowerCase();

  const expectedV1 = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");

  const expectedBuf = Buffer.from(expectedV1, "utf8");
  const receivedBuf = Buffer.from(receivedV1, "utf8");
  const matches =
    expectedBuf.length === receivedBuf.length && timingSafeEqual(expectedBuf, receivedBuf);
  if (!matches) return { ok: false, reason: "mismatch" };

  if (Math.abs(nowSec - t) > MAX_SKEW_SECONDS) return { ok: false, reason: "stale" };

  return { ok: true, t };
}
