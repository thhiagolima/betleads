import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { spacePayCallbackToken, verifySpacePayCallbackToken } from "./spacepay-callback-token";

const SECRET = "callback-secret-0123456789abcdef";

describe("spacepay-callback-token", () => {
  it("builds base64url(externalId).hexHmac", () => {
    const token = spacePayCallbackToken("bl-inv-123", SECRET);
    const [encoded, sig] = token.split(".");
    expect(Buffer.from(encoded, "base64url").toString("utf8")).toBe("bl-inv-123");
    expect(sig).toBe(createHmac("sha256", SECRET).update("bl-inv-123").digest("hex"));
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
  });

  it("round-trips, including ids that need URL-safe base64", () => {
    for (const id of ["bl-top-abc", "a?b/c+d=é", "x".repeat(255)]) {
      const token = spacePayCallbackToken(id, SECRET);
      expect(verifySpacePayCallbackToken(token, SECRET)).toEqual({ ok: true, externalId: id });
      expect(token).not.toMatch(/[+/=]/);
    }
  });

  it("rejects a token signed with another secret", () => {
    const token = spacePayCallbackToken("bl-inv-123", "other-secret");
    expect(verifySpacePayCallbackToken(token, SECRET)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a swapped externalId with a valid signature for another id", () => {
    const sig = spacePayCallbackToken("bl-inv-1", SECRET).split(".")[1];
    const forged = `${Buffer.from("bl-inv-2").toString("base64url")}.${sig}`;
    expect(verifySpacePayCallbackToken(forged, SECRET)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("flags malformed tokens", () => {
    const valid = spacePayCallbackToken("bl-inv-123", SECRET);
    const [encoded, sig] = valid.split(".");
    for (const bad of [
      "",
      "no-dot",
      `${valid}.extra`,
      `.${sig}`,
      `${encoded}.`,
      `${encoded}.${sig.slice(1)}`,
      `${encoded}.${sig.toUpperCase()}`,
      `${encoded}=.${sig}`,
      `a+b.${sig}`,
    ]) {
      expect(verifySpacePayCallbackToken(bad, SECRET)).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("treats an empty secret as unverifiable", () => {
    const token = spacePayCallbackToken("bl-inv-123", SECRET);
    expect(verifySpacePayCallbackToken(token, "")).toEqual({ ok: false, reason: "malformed" });
  });
});
