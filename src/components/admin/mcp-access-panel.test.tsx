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
  adminSetMcpAreas: vi.fn(),
  adminRevokeConnection: vi.fn(),
}));

import {
  McpAccessPanel,
  areaCheckboxDisabled,
  createAreaToggleHandler,
  createLevelChangeHandler,
} from "./mcp-access-panel";

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
        areas: ["financeiro"],
        operacaoElegivel: false,
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
    expect(html).toContain("Financeiro");
    expect(html).toContain("Operação");
    expect(html).toContain("Operação: só super admin, admin de casa ou gestor de grupo.");
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

describe("area checkboxes", () => {
  const row = {
    userId: "user-1",
    level: "read" as const,
    areas: ["financeiro" as const],
    operacaoElegivel: true,
  };

  it("checking Operação sends both areas, in canonical order", () => {
    const calls: unknown[] = [];
    createAreaToggleHandler(row, "operacao", (vars) => calls.push(vars))(true);
    expect(calls).toEqual([{ userId: "user-1", areas: ["financeiro", "operacao"] }]);
  });

  it("unchecking Financeiro with Operação on sends only operação", () => {
    const calls: unknown[] = [];
    createAreaToggleHandler({ ...row, areas: ["financeiro", "operacao"] }, "financeiro", (vars) =>
      calls.push(vars),
    )(false);
    expect(calls).toEqual([{ userId: "user-1", areas: ["operacao"] }]);
  });

  it("never sends an empty list (unchecking the last area does nothing)", () => {
    const calls: unknown[] = [];
    createAreaToggleHandler(row, "financeiro", (vars) => calls.push(vars))(false);
    expect(calls).toEqual([]);
  });

  it("disables both boxes without a level, and Operação for a non-eligible user", () => {
    expect(areaCheckboxDisabled({ ...row, level: "none" }, "financeiro")).toBe(true);
    expect(areaCheckboxDisabled(row, "operacao")).toBe(false);
    expect(areaCheckboxDisabled({ ...row, operacaoElegivel: false }, "operacao")).toBe(true);
    // Already on: stays clickable so it can be turned off.
    expect(
      areaCheckboxDisabled(
        { ...row, operacaoElegivel: false, areas: ["financeiro", "operacao"] },
        "operacao",
      ),
    ).toBe(false);
  });
});
