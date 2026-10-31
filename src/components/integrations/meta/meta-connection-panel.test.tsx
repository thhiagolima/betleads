import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  summary: { data: undefined as unknown, isLoading: false },
  role: "admin" as string | null,
}));

vi.mock("@tanstack/react-router", () => ({
  useBlocker: () => ({ status: "idle" }),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));
vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/meta.functions", () => ({
  connectMetaSystemUserToken: vi.fn(),
  disconnectMetaConnection: vi.fn(),
  enqueueMetaSync: vi.fn(),
  getMetaConnectionSummary: vi.fn(),
  renameMetaConnection: vi.fn(),
  updateMetaAccountSelection: vi.fn(),
  validateMetaConnection: vi.fn(),
}));
vi.mock("@/components/integrations/meta-summary", () => ({
  useMetaConnectionSummary: () => state.summary,
}));
vi.mock("@/hooks/use-is-demo-tenant", () => ({ useIsDemoTenant: () => false }));
vi.mock("@/hooks/use-active-tenant", () => ({
  useActiveTenant: () => ({ active: state.role ? { id: "t1", role: state.role } : null }),
}));

import { META_TEXTS } from "@/components/integrations/meta-connection-model";
import { MetaConnectionPanel } from "../meta-connection";
import { account, connection, summary } from "./meta-test-fixtures";

describe("MetaConnectionPanel", () => {
  beforeEach(() => {
    state.summary = { data: undefined, isLoading: false };
    state.role = "admin";
  });

  it("waits for the summary before drawing the connection, keeping the UTM builder", () => {
    state.summary = { data: undefined, isLoading: true };
    const html = renderToStaticMarkup(<MetaConnectionPanel />);
    expect(html).not.toContain("Meta Ads");
    expect(html).toContain("Montar marcação");
    expect(html).toContain("utm_id={{ad.id}}");
  });

  it("is read-only for a member of the house", () => {
    state.role = "member";
    state.summary = {
      data: summary({ connections: [connection()], accounts: [account()] }),
      isLoading: false,
    };
    const html = renderToStaticMarkup(<MetaConnectionPanel />);
    expect(html).toContain(META_TEXTS.readOnly);
    expect(html).not.toContain("Testar acesso");
  });

  it("does not lock anything while the role is loading", () => {
    state.role = null;
    state.summary = {
      data: summary({ connections: [connection()], accounts: [account()] }),
      isLoading: false,
    };
    const html = renderToStaticMarkup(<MetaConnectionPanel />);
    expect(html).not.toContain(META_TEXTS.readOnly);
    expect(html).toContain("Testar acesso");
  });
});
