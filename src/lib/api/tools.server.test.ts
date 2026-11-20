// API de leitura: the API exposes every MCP read tool (and serie_diaria), never
// a write one; and the OpenAPI document describes each tool's real input.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

import { OPS_TOOLS } from "@/lib/mcp/ops/registry.server";

import { buildOpenApi } from "./openapi.server";
import { API_TOOLS, toolsFor } from "./tools.server";

describe("API_TOOLS", () => {
  it("has every MCP read tool plus serie_diaria, and no write tool", () => {
    const names = API_TOOLS.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "listar_escopos",
        "resumo_financeiro",
        "resumo_por_dia",
        "mes_da_casa",
        "metas_da_casa",
        "serie_diaria",
        ...OPS_TOOLS.map((tool) => tool.name),
      ]),
    );
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((name) => /^(preparar|confirmar)_/.test(name))).toEqual([]);
  });

  it("toolsFor keeps listar_escopos and only the tools of the given areas", () => {
    const fin = toolsFor(["financeiro"]).map((tool) => tool.area);
    expect(new Set(fin)).toEqual(new Set([null, "financeiro"]));
    const ops = toolsFor(["operacao"]).map((tool) => tool.area);
    expect(new Set(ops)).toEqual(new Set([null, "operacao"]));
  });

  it("OpenAPI documents each tool with its real object schema", () => {
    type Paths = Record<
      string,
      {
        post: {
          requestBody: {
            content: Record<string, { schema: { type: string; properties: object } }>;
          };
        };
      }
    >;
    const doc = buildOpenApi("https://betleads.test/api/v1") as { paths: Paths };
    for (const tool of API_TOOLS) {
      const schema = doc.paths[`/${tool.name}`].post.requestBody.content[
        "application/json"
      ].schema;
      expect(schema.type, tool.name).toBe("object");
    }
    const serie = doc.paths["/serie_diaria"].post.requestBody.content[
      "application/json"
    ].schema;
    expect(Object.keys(serie.properties)).toEqual(["escopo", "periodo"]);
  });
});
