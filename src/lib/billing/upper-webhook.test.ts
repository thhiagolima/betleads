import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifyUpperSignature } from "./upper-webhook";

const SECRET = "whsec-upper-test-0123456789";

function signatureHeaderFor(body: string, t: number, secret = SECRET): string {
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

describe("verifyUpperSignature", () => {
  const body = JSON.stringify({ id: "evt-1", event: "charge.paid" });

  it("accepts a valid signature generated the documented way", () => {
    const now = Math.floor(Date.now() / 1000);
    const header = signatureHeaderFor(body, now);
    const result = verifyUpperSignature(body, header, SECRET, now);
    expect(result).toEqual({ ok: true, t: now });
  });

  it("rejects when v1 is swapped for a wrong hash", () => {
    const now = Math.floor(Date.now() / 1000);
    const header = `t=${now},v1=${"0".repeat(64)}`;
    const result = verifyUpperSignature(body, header, SECRET, now);
    expect(result).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a signature whose t is 301s in the past as stale", () => {
    const now = Math.floor(Date.now() / 1000);
    const t = now - 301;
    const header = signatureHeaderFor(body, t);
    const result = verifyUpperSignature(body, header, SECRET, now);
    expect(result).toEqual({ ok: false, reason: "stale" });
  });

  it("accepts a signature exactly at the 300s boundary", () => {
    const now = Math.floor(Date.now() / 1000);
    const t = now - 300;
    const header = signatureHeaderFor(body, t);
    const result = verifyUpperSignature(body, header, SECRET, now);
    expect(result).toEqual({ ok: true, t });
  });

  it("rejects a missing header", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(verifyUpperSignature(body, null, SECRET, now)).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("rejects a malformed header", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(verifyUpperSignature(body, "garbage", SECRET, now)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(verifyUpperSignature(body, "t=abc,v1=def", SECRET, now)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("rejects a v1 of a different length than expected without throwing", () => {
    const now = Math.floor(Date.now() / 1000);
    const header = `t=${now},v1=ab`;
    expect(verifyUpperSignature(body, header, SECRET, now)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });
});
