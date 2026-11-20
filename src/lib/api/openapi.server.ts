// API de leitura: OpenAPI 3.1 built from each tool's own zod input schema, so
// the documentation never drifts from what the API validates.
import { z } from "zod";

import { API_TOOLS } from "./tools.server";

function inputSchemaOf(schema: z.ZodObject): Record<string, unknown> {
  try {
    const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
      io: "input",
      unrepresentable: "any",
    }) as Record<string, unknown>;
    return rest;
  } catch {
    return { type: "object" };
  }
}

const ERRO = {
  description: "Erro, com a mensagem em português.",
  content: {
    "application/json": {
      schema: { type: "object", properties: { erro: { type: "string" } }, required: ["erro"] },
    },
  },
};

export function buildOpenApi(serverUrl: string) {
  const paths: Record<string, unknown> = {
    "/": {
      get: {
        operationId: "listar_ferramentas",
        summary: "Ferramentas que a chave pode usar",
        responses: { "200": { description: "Lista de ferramentas." }, "401": ERRO },
      },
    },
  };
  for (const tool of API_TOOLS) {
    paths[`/${tool.name}`] = {
      post: {
        operationId: tool.name,
        summary: tool.title,
        description: tool.description,
        tags: [tool.area ?? "geral"],
        requestBody: {
          required: true,
          content: { "application/json": { schema: inputSchemaOf(tool.inputSchema) } },
        },
        responses: {
          "200": {
            description:
              "Resultado em JSON, com calculado_em (AAAA-MM-DD HH:MM:SS, horário de Brasília).",
          },
          "400": ERRO,
          "401": ERRO,
          "403": ERRO,
          "429": ERRO,
          "500": ERRO,
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Betleads — API de leitura",
      version: "1.0.0",
      description:
        "Uso interno. Os mesmos números do MCP e do painel, só leitura. Autenticação: Authorization: Bearer <chave>, criada na tela Conectar ao Claude. A chave vê as mesmas casas e áreas que o dono vê no MCP. Limite: 60 chamadas por minuto por chave.",
    },
    servers: [{ url: serverUrl }],
    components: { securitySchemes: { chave: { type: "http", scheme: "bearer" } } },
    security: [{ chave: [] }],
    paths,
  };
}
