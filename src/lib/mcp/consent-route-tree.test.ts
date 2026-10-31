// /mcp/autorizar must be a root-level route: nested under /mcp (which has no
// <Outlet/>) the consent screen never rendered (final review item 1).
import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import { routeTree } from "@/routeTree.gen";
import { isMcpConsentPath } from "@/lib/navigation";

const router = createRouter({ routeTree, context: { queryClient: new QueryClient() } });
const matchIds = (path: string) => router.matchRoutes(path, {}).map((m) => m.routeId);

describe("MCP consent route", () => {
  it("resolves /mcp/autorizar to the consent route, child of root (not of /mcp)", () => {
    expect(matchIds("/mcp/autorizar")).toEqual(["__root__", "/mcp_/autorizar"]);
    expect(matchIds("/mcp/autorizar/")).toEqual(["__root__", "/mcp_/autorizar"]);
    const route = router.routesById["/mcp_/autorizar"];
    expect(route.parentRoute.id).toBe("__root__");
    expect(route.fullPath).toBe("/mcp/autorizar");
  });

  it("keeps /mcp resolving to the Conectar ao Claude page", () => {
    expect(matchIds("/mcp")).toEqual(["__root__", "/mcp"]);
  });

  it("isMcpConsentPath takes the consent branch with or without a trailing slash", () => {
    expect(isMcpConsentPath("/mcp/autorizar")).toBe(true);
    expect(isMcpConsentPath("/mcp/autorizar/")).toBe(true);
    expect(isMcpConsentPath("/mcp")).toBe(false);
    expect(isMcpConsentPath("/mcp/autorizarx")).toBe(false);
  });
});
