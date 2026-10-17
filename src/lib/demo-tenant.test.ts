import { describe, expect, it } from "vitest";

import {
  DEMO_ACTION_BLOCKED_TEXT,
  DEMO_SEND_BLOCKED_TEXT,
  DemoTenantBlockedError,
  demoBlockedErrorText,
  isDemoBlockedError,
} from "./demo-tenant";

describe("DemoTenantBlockedError.message", () => {
  it("is the clean send-blocked copy, with no code prefix (R13)", () => {
    expect(new DemoTenantBlockedError("DEMO_SEND_BLOCKED").message).toBe(DEMO_SEND_BLOCKED_TEXT);
  });

  it("is the clean action-blocked copy, with no code prefix (R13)", () => {
    expect(new DemoTenantBlockedError("DEMO_ACTION_BLOCKED").message).toBe(
      DEMO_ACTION_BLOCKED_TEXT,
    );
  });

  it("keeps the code on the `code` property, so a single toast.error(e.message) call shows exactly one clean message", () => {
    const err = new DemoTenantBlockedError("DEMO_SEND_BLOCKED");
    expect(err.code).toBe("DEMO_SEND_BLOCKED");
    expect(err.message).not.toContain("DEMO_SEND_BLOCKED");
    expect(err.message).toBe(DEMO_SEND_BLOCKED_TEXT);
  });
});

describe("isDemoBlockedError", () => {
  it("recognizes a DemoTenantBlockedError instance", () => {
    expect(isDemoBlockedError(new DemoTenantBlockedError("DEMO_SEND_BLOCKED"))).toBe(true);
  });

  it("recognizes a plain object carrying a matching code", () => {
    expect(isDemoBlockedError({ code: "DEMO_ACTION_BLOCKED" })).toBe(true);
  });

  it("recognizes a serialized error whose message is exactly the clean copy (the normal post-R13 shape)", () => {
    expect(isDemoBlockedError(new Error(DEMO_SEND_BLOCKED_TEXT))).toBe(true);
    expect(isDemoBlockedError(DEMO_ACTION_BLOCKED_TEXT)).toBe(true);
  });

  it("still recognizes the legacy 'CODE: ...' form (server-internal result objects, or errors serialized before R13)", () => {
    expect(isDemoBlockedError(new Error("DEMO_SEND_BLOCKED: old message shape"))).toBe(true);
    expect(isDemoBlockedError("DEMO_ACTION_BLOCKED: blocked")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isDemoBlockedError(new Error("Falha de rede"))).toBe(false);
    expect(isDemoBlockedError("unrelated")).toBe(false);
    expect(isDemoBlockedError(null)).toBe(false);
    expect(isDemoBlockedError(undefined)).toBe(false);
  });
});

describe("demoBlockedErrorText", () => {
  it("maps a send-blocked error (clean message, R13 shape) to the blocked-send copy", () => {
    expect(demoBlockedErrorText(new DemoTenantBlockedError("DEMO_SEND_BLOCKED"))).toBe(
      DEMO_SEND_BLOCKED_TEXT,
    );
  });

  it("maps an action-blocked error (clean message, R13 shape) to the blocked-action copy", () => {
    expect(demoBlockedErrorText(new DemoTenantBlockedError("DEMO_ACTION_BLOCKED"))).toBe(
      DEMO_ACTION_BLOCKED_TEXT,
    );
  });

  it("maps a plain object carrying only a `code` (server-internal result, no message) to the right copy", () => {
    expect(demoBlockedErrorText({ code: "DEMO_SEND_BLOCKED" })).toBe(DEMO_SEND_BLOCKED_TEXT);
    expect(demoBlockedErrorText({ code: "DEMO_ACTION_BLOCKED" })).toBe(DEMO_ACTION_BLOCKED_TEXT);
  });

  it("maps a serialized error whose message is exactly the clean send-blocked copy", () => {
    expect(demoBlockedErrorText(new Error(DEMO_SEND_BLOCKED_TEXT))).toBe(DEMO_SEND_BLOCKED_TEXT);
  });

  it("still maps the legacy 'CODE: ...' message shape by the embedded code", () => {
    expect(demoBlockedErrorText("Error: DEMO_SEND_BLOCKED: Ambiente de demonstração...")).toBe(
      DEMO_SEND_BLOCKED_TEXT,
    );
  });

  it("falls back to the action copy for an unrecognized shape", () => {
    expect(demoBlockedErrorText(new Error("DEMO_ACTION_BLOCKED: whatever"))).toBe(
      DEMO_ACTION_BLOCKED_TEXT,
    );
  });
});

describe("isDemoBlockedError + demoBlockedErrorText together (a toast call site's mapping)", () => {
  it("routes a recognized demo error to exactly one clean toast message, and leaves unrelated errors alone", () => {
    const demoError = new DemoTenantBlockedError("DEMO_SEND_BLOCKED");
    expect(isDemoBlockedError(demoError)).toBe(true);
    // A call site's existing `onError: (e) => toast.error(e.message)` would
    // show this single string, with no code prefix to clean up separately.
    expect(demoError.message).toBe(DEMO_SEND_BLOCKED_TEXT);
    expect(demoBlockedErrorText(demoError)).toBe(DEMO_SEND_BLOCKED_TEXT);

    const regularError = new Error("Falha de rede");
    expect(isDemoBlockedError(regularError)).toBe(false);
  });
});
