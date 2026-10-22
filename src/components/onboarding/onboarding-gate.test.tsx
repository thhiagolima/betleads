import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type QueryState = { data: unknown; isLoading: boolean; isError: boolean };
const accessState: QueryState = { data: undefined, isLoading: false, isError: false };
const setupState: QueryState = { data: undefined, isLoading: false, isError: false };
const setupQueryOptions: Array<{ enabled?: boolean }> = [];

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[]; enabled?: boolean }) => {
    setupQueryOptions.push({ enabled: options.enabled });
    return setupState;
  },
}));

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/components/tenant-status-gate", () => ({
  useTenantAccessStatus: () => ({ ...accessState, pathname: "/inicio", isTenantPage: false }),
}));

vi.mock("@/lib/house-config.functions", () => ({
  getHouseSetupStatus: () => Promise.resolve(null),
}));

vi.mock("@/components/onboarding/house-setup-wizard", () => ({
  HouseSetupWizard: () => <div>assistente-de-configuracao</div>,
}));

import { OnboardingGate } from "./onboarding-gate";

function billing(over: Record<string, unknown> = {}) {
  return {
    state: "locked_unpaid" as const,
    effectiveLock: true,
    role: "payer" as const,
    invoice: { amountCents: 400_000, dueDate: "2026-11-05" },
    enforcement: true,
    today: "2026-11-10",
    ...over,
  };
}

function render() {
  return renderToStaticMarkup(
    <OnboardingGate>
      <div>conteudo-da-casa</div>
    </OnboardingGate>,
  );
}

describe("OnboardingGate", () => {
  beforeEach(() => {
    accessState.data = { blocked: false, tenant: null, billing: null };
    setupState.data = { showWizard: true };
    setupState.isLoading = false;
    setupState.isError = false;
    setupQueryOptions.length = 0;
  });

  it("shows the wizard for a house that has not finished setup", () => {
    const html = render();
    expect(html).toContain("assistente-de-configuracao");
    expect(setupQueryOptions.at(-1)?.enabled).toBe(true);
  });

  it("skips the wizard (and the setup query) for a house locked for the monthly fee", () => {
    accessState.data = { blocked: false, tenant: null, billing: billing() };
    const html = render();
    expect(html).not.toContain("assistente-de-configuracao");
    expect(html).toContain("conteudo-da-casa");
    expect(setupQueryOptions.at(-1)?.enabled).toBe(false);
  });

  it("skips the wizard for a frozen house too", () => {
    accessState.data = {
      blocked: false,
      tenant: null,
      billing: billing({ state: "frozen", invoice: null }),
    };
    expect(render()).not.toContain("assistente-de-configuracao");
  });

  it("keeps the wizard when the invoice is late but enforcement is off (no effective lock)", () => {
    accessState.data = {
      blocked: false,
      tenant: null,
      billing: billing({ effectiveLock: false, enforcement: false }),
    };
    expect(render()).toContain("assistente-de-configuracao");
  });
});
