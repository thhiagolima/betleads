import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifyPaganoPaySignature, verifyPaganoPaySignatureAny } from "./paganopay-webhook";

const SECRET = "pagano-whsec";
const BODY = '{"event":"pix.confirmed","id":26150,"status":"PAID"}';
const NOW = 1792591500;

function sign(body: string, ts: string, secret = SECRET) {
  return `v1=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;
}

describe("verifyPaganoPaySignature", () => {
  it("accepts their documented scheme (v1= HMAC of '<ts>.<body>')", () => {
    expect(verifyPaganoPaySignature(BODY, sign(BODY, String(NOW)), String(NOW), SECRET, NOW)).toEqual({
      ok: true,
      t: NOW,
    });
  });

  it("matches the openssl example from their docs", () => {
    // printf '%s.%s' "$TS" "$CORPO" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -hex
    const expected = createHmac("sha256", SECRET).update(`1792591500.${BODY}`).digest("hex");
    expect(verifyPaganoPaySignature(BODY, expected, "1792591500", SECRET, NOW).ok).toBe(true);
  });

  it("rejects a changed body, a wrong secret, missing or malformed headers", () => {
    const sig = sign(BODY, String(NOW));
    expect(verifyPaganoPaySignature(BODY + " ", sig, String(NOW), SECRET, NOW)).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(verifyPaganoPaySignature(BODY, sig, String(NOW), "other", NOW)).toMatchObject({
      reason: "mismatch",
    });
    expect(verifyPaganoPaySignature(BODY, null, String(NOW), SECRET, NOW)).toMatchObject({
      reason: "missing",
    });
    expect(verifyPaganoPaySignature(BODY, sig, null, SECRET, NOW)).toMatchObject({
      reason: "missing",
    });
    expect(verifyPaganoPaySignature(BODY, "v1=zz", String(NOW), SECRET, NOW)).toMatchObject({
      reason: "malformed",
    });
    expect(verifyPaganoPaySignature(BODY, sig, "abc", SECRET, NOW)).toMatchObject({
      reason: "malformed",
    });
  });

  it("refuses deliveries more than 5 minutes off", () => {
    const old = String(NOW - 301);
    expect(verifyPaganoPaySignature(BODY, sign(BODY, old), old, SECRET, NOW)).toMatchObject({
      reason: "stale",
    });
  });
});

describe("verifyPaganoPaySignatureAny", () => {
  it("accepts any of the configured secrets (rotation)", () => {
    const sig = sign(BODY, String(NOW), "old-secret");
    expect(
      verifyPaganoPaySignatureAny(BODY, sig, String(NOW), ["new-secret", "old-secret"], NOW).ok,
    ).toBe(true);
    expect(verifyPaganoPaySignatureAny(BODY, sig, String(NOW), ["new-secret"], NOW).ok).toBe(false);
  });
});
