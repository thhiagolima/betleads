import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DEMO_ENVIRONMENT_BANNER_TEXT } from "@/lib/demo-tenant";

const useIsDemoTenant = vi.fn();
vi.mock("@/hooks/use-is-demo-tenant", () => ({ useIsDemoTenant: () => useIsDemoTenant() }));

describe("DemoBanner", () => {
  it("renders the exact demo copy when the active tenant is demo", async () => {
    useIsDemoTenant.mockReturnValue(true);
    const { DemoBanner } = await import("./demo-banner");

    const html = renderToStaticMarkup(<DemoBanner />);

    expect(html).toContain(DEMO_ENVIRONMENT_BANNER_TEXT);
  });

  it("renders nothing when the active tenant is not demo", async () => {
    useIsDemoTenant.mockReturnValue(false);
    const { DemoBanner } = await import("./demo-banner");

    const html = renderToStaticMarkup(<DemoBanner />);

    expect(html).toBe("");
  });
});
