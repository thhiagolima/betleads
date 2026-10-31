import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// This repo's component tests render plain-HTML components with
// `renderToStaticMarkup` (no @testing-library/react, no jsdom — see
// link-domain-dialog.test.tsx). Interaction (the Select's onValueChange) is
// not something a static render can simulate, so that behavior is tested
// directly against `createLevelChangeHandler`, the exact function the
// component wires to the Select — not a DOM event.
const queryState = { data: undefined as unknown, isLoading: false };

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => queryState,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/mcp/mcp.functions", () => ({
  adminListMcpAccess: vi.fn(),
  adminSetMcpAccess: vi.fn(),
  adminRevokeConnection: vi.fn(),
}));

import { McpAccessPanel, createLevelChangeHandler } from "./mcp-access-panel";

describe("McpAccessPanel", () => {
  it("shows the disabled note instead of the controls when MCP is off", () => {
    const html = renderToStaticMarkup(<McpAccessPanel mcpEnabled={false} />);
    expect(html).toContain("MCP desligado neste ambiente.");
  });

  it("renders a user row with name, e-mail, current level and its connection", () => {
    queryState.data = [
      {
        userId: "00000000-0000-4000-8000-0000000000bb",
        nome: "Dona da Casa",
        email: "dona@casa.com",
        level: "read",
        connections: [
          {
            id: "conn-1",
            clientName: "Claude.ai",
            createdAt: "2026-10-01T00:00:00.000Z",
            lastUsedAt: null,
          },
        ],
      },
    ];

    const html = renderToStaticMarkup(<McpAccessPanel mcpEnabled={true} />);

    expect(html).toContain("Dona da Casa");
    expect(html).toContain("dona@casa.com");
    expect(html).toContain("Leitura");
    expect(html).toContain("Claude.ai");
    expect(html).toContain("Desconectar");
  });

  it("shows an empty message when there are no candidate users", () => {
    queryState.data = [];
    const html = renderToStaticMarkup(<McpAccessPanel mcpEnabled={true} />);
    expect(html).toContain("Nenhum candidato a acesso MCP encontrado.");
  });
});

describe("createLevelChangeHandler", () => {
  it("changing the select calls adminSetMcpAccess (via the passed setter) with the new level", () => {
    const calls: Array<{ userId: string; level: string }> = [];
    const handler = createLevelChangeHandler("user-1", (vars) => calls.push(vars));

    handler("write");

    expect(calls).toEqual([{ userId: "user-1", level: "write" }]);
  });
});
