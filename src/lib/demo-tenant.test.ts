import { describe, expect, it } from "vitest";

import {
  DEMO_ACTION_BLOCKED_TEXT,
  DEMO_SEND_BLOCKED_TEXT,
  DemoTenantBlockedError,
  demoBlockedErrorText,
  isDemoBlockedError,
} from "./demo-tenant";

describe("demoBlockedErrorText", () => {
  it("maps a send-blocked error to the blocked-send copy", () => {
    expect(demoBlockedErrorText(new DemoTenantBlockedError("DEMO_SEND_BLOCKED"))).toBe(
      DEMO_SEND_BLOCKED_TEXT,
    );
  });

  it("maps an action-blocked error to the blocked-action copy", () => {
    expect(demoBlockedErrorText(new DemoTenantBlockedError("DEMO_ACTION_BLOCKED"))).toBe(
      DEMO_ACTION_BLOCKED_TEXT,
    );
  });

  it("maps a serialized server-fn error (plain string) by the embedded code", () => {
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

describe("isDemoBlockedError + demoBlockedErrorText together (global handler mapping)", () => {
  it("only routes recognized demo errors to the demo copy", () => {
    const demoError = new DemoTenantBlockedError("DEMO_SEND_BLOCKED");
    expect(isDemoBlockedError(demoError)).toBe(true);
    expect(demoBlockedErrorText(demoError)).toBe(DEMO_SEND_BLOCKED_TEXT);

    const regularError = new Error("Falha de rede");
    expect(isDemoBlockedError(regularError)).toBe(false);
  });
});
