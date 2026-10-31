// Consent screen render (final review items 1 and 5a–c). Static render with
// the router/query hooks mocked, as in this repo's other component tests.
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentType } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

const search = {
  client_id: "client-1",
  redirect_uri: "https://claude.ai/api/mcp/auth_callback",
  code_challenge: "abc",
  code_challenge_method: "S256",
  state: "st",
};
const queryState: Record<string, unknown> = {};

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useSearch: () => search,
  }),
  notFound: () => new Error("not found"),
  // The router plugin code-splits `component` into a lazy import: expose the loader.
  lazyRouteComponent: (importer: () => Promise<Record<string, unknown>>, name = "default") => ({
    load: async () => (await importer())[name],
  }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => queryState,
  useMutation: () => ({ mutate: vi.fn(), isPending: false, isSuccess: false, isError: false }),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/mcp/oauth.functions", () => ({
  approveMcpAuthorization: vi.fn(),
  getMcpAuthorizationInfo: vi.fn(),
  mcpConsentEnabled: vi.fn(async () => true),
}));

import { Route } from "@/routes/mcp_.autorizar";

const options = (Route as unknown as { options: Record<string, unknown> }).options;
let Page: ComponentType;
beforeAll(async () => {
  const component = options.component as ComponentType | { load: () => Promise<ComponentType> };
  Page = "load" in component ? await component.load() : component;
});

function render(state: Record<string, unknown>) {
  for (const key of Object.keys(queryState)) delete queryState[key];
  Object.assign(queryState, state);
  return renderToStaticMarkup(<Page />);
}

describe("consent page", () => {
  it("shows no buttons while the request info loads", () => {
    const html = render({ isPending: true, isError: false });
    expect(html).toContain("Carregando");
    expect(html).not.toContain("Permitir");
  });

  it("once info loads: recipient from the redirect URI, warning line, Permitir button", () => {
    const html = render({
      isPending: false,
      isError: false,
      data: {
        recipient: "Claude (claude.ai)",
        clientName: "Banco Oficial — confirme aqui",
        level: "read",
        scopes: { houses: ["Casa Um"], groups: [] },
      },
    });
    expect(html).toContain("<strong>Claude (claude.ai)</strong> quer acessar o financeiro de:");
    expect(html).toContain(
      "Só clique em Permitir se você acabou de pedir esta conexão no seu Claude.",
    );
    // The free-text client_name is only secondary text, never the headline.
    expect(html).not.toContain("<strong>Banco Oficial");
    expect(html).toContain("Nome informado pelo aplicativo: Banco Oficial — confirme aqui");
    expect(html).toMatch(/<button[^>]*>Permitir<\/button>/);
    expect(html).toMatch(/<button[^>]*>Cancelar<\/button>/);
  });

  it("sends anti-framing headers", async () => {
    const headers = await (options.headers as () => Promise<Record<string, string>>)();
    expect(headers).toEqual({
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
    });
  });
});
