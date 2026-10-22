// Final fix (I): BILLING_ENFORCEMENT_ENABLED only counts together with
// BILLING_INVOICES_ENABLED. Enforcement without invoices would lock houses
// that were never billed, so it fails closed (no lock) and logs once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

import {
  __resetBillingEnforcementWarningForTests,
  isBillingEnforcementEnabled,
} from "@/lib/tenant-access.server";

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __resetBillingEnforcementWarningForTests();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("isBillingEnforcementEnabled", () => {
  it("is on only when both flags are \"true\"", () => {
    vi.stubEnv("BILLING_ENFORCEMENT_ENABLED", "true");
    vi.stubEnv("BILLING_INVOICES_ENABLED", "true");
    expect(isBillingEnforcementEnabled()).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("is off when enforcement is off, without logging", () => {
    vi.stubEnv("BILLING_ENFORCEMENT_ENABLED", "false");
    vi.stubEnv("BILLING_INVOICES_ENABLED", "true");
    expect(isBillingEnforcementEnabled()).toBe(false);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("fails closed when enforcement is on but invoices are off, logging once per process", () => {
    vi.stubEnv("BILLING_ENFORCEMENT_ENABLED", "true");
    vi.stubEnv("BILLING_INVOICES_ENABLED", "false");
    expect(isBillingEnforcementEnabled()).toBe(false);
    expect(isBillingEnforcementEnabled()).toBe(false);
    vi.stubEnv("BILLING_INVOICES_ENABLED", "");
    expect(isBillingEnforcementEnabled()).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain("BILLING_INVOICES_ENABLED");
  });
});
