// MCP financeiro, Task 8: tool registration, call log and rate limits.
// The read tools and the preview/confirm cores are mocked (their behavior is
// covered by read-tools.server.test.ts / preview.server.test.ts); this file
// checks what createMcpServer adds around them: the 10 tool names, the
// mcp_call_log row per call, the DB-counted limits and error mapping.
// MCP do grupo: OPS_TOOLS is mocked with one fake operação tool, to check the
// area gating (registration and handler), the args/scope log and the
// personal-data guard around every operação result.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("../sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

vi.mock("./read-tools.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./read-tools.server")>();
  return {
    ...actual,
    listarEscopos: vi.fn(),
    resumoFinanceiro: vi.fn(),
    mesDaCasa: vi.fn(),
    metasDaCasa: vi.fn(),
  };
});

const ops = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("./ops/registry.server", async () => {
  const { z } = await import("zod");
  return {
    OPS_TOOLS: [
      {
        name: "visao_teste",
        title: "Visão de teste",
        description: "Ferramenta de operação de teste.",
        inputSchema: z.object({
          escopo: z.object({ tipo: z.string(), id: z.string().optional() }),
        }),
        run: ops.run,
      },
    ],
  };
});

vi.mock("./access.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./access.server")>();
  return { ...actual, resolveBearer: vi.fn() };
});

vi.mock("./preview.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./preview.server")>();
  return { ...actual, createPreview: vi.fn(), confirmPreview: vi.fn() };
});

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { resolveBearer, type McpIdentity } from "./access.server";
import { CALLS_PER_MINUTE, CONFIRMS_PER_HOUR } from "./config.server";
import { sha256Hex } from "./crypto.server";
import { confirmPreview, createPreview } from "./preview.server";
import { listarEscopos, mesDaCasa, metasDaCasa } from "./read-tools.server";
import { createMcpServer, handleMcpRequest } from "./server.server";
import { createFakeDb } from "../sms-bulk.test-support";

const ADMIN_A = "00000000-0000-4000-8000-0000000000cc";
const HOUSE_A = "00000000-0000-4000-8000-000000000101";
const CONN = "00000000-0000-4000-8000-00000000f001";
const OTHER_CONN = "00000000-0000-4000-8000-00000000f002";
const COST_1 = "00000000-0000-4000-8000-00000000c001";

const identity = (
  userId = ADMIN_A,
  level: "read" | "write" = "write",
  areas: McpIdentity["areas"] = ["financeiro"],
): McpIdentity => ({
  userId,
  connectionId: CONN,
  clientId: "client-1",
  level,
  areas,
});

const callLog = () => fake.admin.rows("mcp_call_log");

async function connect(id: McpIdentity = identity()) {
  const server = createMcpServer(id);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  (result.content as Array<{ type: string; text: string }>)[0].text;

function seedCalls(count: number, row: Record<string, unknown>) {
  for (let i = 0; i < count; i++) {
    callLog().push({
      user_id: ADMIN_A,
      connection_id: CONN,
      tool: "listar_escopos",
      ok: true,
      duration_ms: 1,
      created_at: new Date().toISOString(),
      ...row,
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-24T15:00:00Z"));
  fake.admin.reset();
  vi.mocked(listarEscopos).mockReset();
  vi.mocked(mesDaCasa).mockReset();
  vi.mocked(metasDaCasa).mockReset();
  vi.mocked(createPreview).mockReset();
  vi.mocked(confirmPreview).mockReset();
  ops.run.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createMcpServer", () => {
  it("registers exactly the 11 finance tools with their annotations", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        "listar_escopos",
        "resumo_financeiro",
        "resumo_por_dia",
        "mes_da_casa",
        "metas_da_casa",
        "preparar_lancamento_dias",
        "preparar_ggr_mensal",
        "preparar_custo",
        "preparar_exclusao_custo",
        "preparar_meta",
        "confirmar_alteracao",
      ].sort(),
    );
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of [
      "listar_escopos",
      "resumo_financeiro",
      "resumo_por_dia",
      "mes_da_casa",
      "metas_da_casa",
    ]) {
      expect(byName.get(name)?.annotations?.readOnlyHint).toBe(true);
    }
    expect(byName.get("confirmar_alteracao")?.annotations?.destructiveHint).toBe(true);
    for (const name of [
      "preparar_lancamento_dias",
      "preparar_ggr_mensal",
      "preparar_custo",
      "preparar_exclusao_custo",
      "preparar_meta",
    ]) {
      expect(byName.get(name)?.description).toContain(
        "Mostre a prévia ao usuário e só chame confirmar_alteracao depois que ele aprovar.",
      );
    }
  });

  it("listar_escopos returns the caller's houses and logs an ok call", async () => {
    vi.mocked(listarEscopos).mockResolvedValue({
      superAdmin: false,
      houses: [{ id: HOUSE_A, nome: "Casa A", isDemo: false, status: "active" }],
      groups: [],
      nivel: "leitura e escrita",
      areas: ["financeiro"],
    });
    const client = await connect();
    const result = await client.callTool({ name: "listar_escopos", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result)).houses).toEqual([
      { id: HOUSE_A, nome: "Casa A", isDemo: false, status: "active" },
    ]);
    expect((result.structuredContent as { houses: unknown[] }).houses).toHaveLength(1);
    expect(vi.mocked(listarEscopos).mock.calls[0][0]).toEqual(identity());

    expect(callLog()).toHaveLength(1);
    expect(callLog()[0]).toMatchObject({
      user_id: ADMIN_A,
      connection_id: CONN,
      tool: "listar_escopos",
      tenant_id: null,
      ok: true,
    });
    expect(typeof callLog()[0].duration_ms).toBe("number");
  });

  it("stamps an object result with calculado_em in Brasília time", async () => {
    vi.mocked(listarEscopos).mockResolvedValue({ nivel: "read", areas: ["financeiro"] } as never);
    const client = await connect();
    const result = await client.callTool({ name: "listar_escopos", arguments: {} });

    // System time 2026-10-24T15:00:00Z is 12:00 in Brasília.
    expect(result.structuredContent).toMatchObject({ calculado_em: "2026-10-24 12:00:00" });
    expect(JSON.parse(textOf(result)).calculado_em).toBe("2026-10-24 12:00:00");
  });

  it("wraps an array result in structuredContent and logs the house id", async () => {
    vi.mocked(metasDaCasa).mockResolvedValue([
      { metric: "ftds", direction: "gte", dailyValue: 10, validFrom: "2026-10-01" },
    ] as never);
    const client = await connect();
    const result = await client.callTool({ name: "metas_da_casa", arguments: { casa: HOUSE_A } });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ resultado: JSON.parse(textOf(result)) });
    expect(callLog()[0]).toMatchObject({ tool: "metas_da_casa", tenant_id: HOUSE_A, ok: true });
  });

  it(`refuses call ${CALLS_PER_MINUTE + 1} in a minute and still logs it`, async () => {
    seedCalls(CALLS_PER_MINUTE, {});
    // Older than 60 s and other connections do not count.
    seedCalls(5, { created_at: new Date(Date.now() - 61_000).toISOString() });
    vi.mocked(listarEscopos).mockResolvedValue({
      superAdmin: false,
      houses: [],
      groups: [],
      nivel: "leitura",
      areas: ["financeiro"],
    });
    const client = await connect();
    const result = await client.callTool({ name: "listar_escopos", arguments: {} });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Muitas chamadas. Aguarde um minuto.");
    expect(listarEscopos).not.toHaveBeenCalled();
    const last = callLog().at(-1)!;
    expect(last).toMatchObject({ tool: "listar_escopos", ok: false });
    expect(last.error).toBe("Muitas chamadas. Aguarde um minuto.");
  });

  it(`call ${CALLS_PER_MINUTE} in a minute still runs`, async () => {
    seedCalls(CALLS_PER_MINUTE - 1, {});
    seedCalls(10, { connection_id: OTHER_CONN });
    vi.mocked(listarEscopos).mockResolvedValue({
      superAdmin: false,
      houses: [],
      groups: [],
      nivel: "leitura",
      areas: ["financeiro"],
    });
    const client = await connect();
    const result = await client.callTool({ name: "listar_escopos", arguments: {} });
    expect(result.isError).toBeFalsy();
  });

  it(`refuses confirmation ${CONFIRMS_PER_HOUR + 1} in an hour`, async () => {
    // 30 confirmations in the last hour (spread over other connections and
    // older minutes, so the per-minute limit is not what refuses).
    seedCalls(CONFIRMS_PER_HOUR, {
      tool: "confirmar_alteracao",
      connection_id: OTHER_CONN,
      created_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    });
    // Failed confirmations and ones older than an hour do not count.
    seedCalls(3, { tool: "confirmar_alteracao", ok: false, connection_id: OTHER_CONN });
    const client = await connect();
    const result = await client.callTool({
      name: "confirmar_alteracao",
      arguments: { codigo: "abc" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Limite de confirmações por hora atingido.");
    expect(confirmPreview).not.toHaveBeenCalled();
    expect(callLog().at(-1)).toMatchObject({
      tool: "confirmar_alteracao",
      ok: false,
      preview_code_hash: await sha256Hex("abc"),
    });
  });

  it("confirmation 30 in an hour still applies and logs the code hash", async () => {
    seedCalls(CONFIRMS_PER_HOUR - 1, {
      tool: "confirmar_alteracao",
      connection_id: OTHER_CONN,
      created_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    });
    seedCalls(1, {
      tool: "confirmar_alteracao",
      connection_id: OTHER_CONN,
      created_at: new Date(Date.now() - 61 * 60_000).toISOString(),
    });
    fake.admin.rows("mcp_previews").push({
      code_hash: await sha256Hex("abc"),
      user_id: ADMIN_A,
      tenant_id: HOUSE_A,
    });
    vi.mocked(confirmPreview).mockResolvedValue({ ok: true, resultado: { saved: 1 } });
    const client = await connect();
    const result = await client.callTool({
      name: "confirmar_alteracao",
      arguments: { codigo: "abc" },
    });

    expect(result.isError).toBeFalsy();
    expect(vi.mocked(confirmPreview).mock.calls[0]).toEqual([identity(), "abc"]);
    expect(callLog().at(-1)).toMatchObject({
      tool: "confirmar_alteracao",
      ok: true,
      tenant_id: HOUSE_A,
      preview_code_hash: await sha256Hex("abc"),
    });
  });

  it('turns a thrown "Sem permissão" into isError and logs ok: false', async () => {
    vi.mocked(mesDaCasa).mockRejectedValue(new Error("Sem permissão"));
    const client = await connect();
    const result = await client.callTool({
      name: "mes_da_casa",
      arguments: { casa: HOUSE_A, mes: "2026-10" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Sem permissão");
    expect(callLog()).toHaveLength(1);
    expect(callLog()[0]).toMatchObject({
      tool: "mes_da_casa",
      tenant_id: HOUSE_A,
      ok: false,
      error: "Sem permissão",
    });
  });

  it("still answers when the call log insert fails", async () => {
    vi.mocked(listarEscopos).mockResolvedValue({
      superAdmin: false,
      houses: [],
      groups: [],
      nivel: "leitura",
      areas: ["financeiro"],
    });
    fake.admin.failNext("mcp_call_log", "insert");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await connect();
    const result = await client.callTool({ name: "listar_escopos", arguments: {} });
    expect(result.isError).toBeFalsy();
    errorSpy.mockRestore();
  });
});

describe("preparar_* tools", () => {
  const preview = {
    codigo_confirmacao: "code-1",
    expira_em: "2026-10-24T15:10:00.000Z",
    linhas: ["linha"],
    avisos: [],
  };

  it("preparar_lancamento_dias maps pt-BR fields to the action input, keeping absent fields absent", async () => {
    vi.mocked(createPreview).mockResolvedValue(preview);
    const client = await connect();
    const result = await client.callTool({
      name: "preparar_lancamento_dias",
      arguments: {
        casa: HOUSE_A,
        entradas: [
          { data: "2026-10-20", anuncios: 100.5, ggr: null },
          { data: "2026-10-21", ggr: 200 },
        ],
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ ...preview, calculado_em: expect.any(String) });
    const [id, action, input] = vi.mocked(createPreview).mock.calls[0];
    expect(id).toEqual(identity());
    expect(action).toBe("lancamento_dias");
    expect(input).toEqual({
      tenantId: HOUSE_A,
      entries: [
        { date: "2026-10-20", adSpend: 100.5, ggr: null },
        { date: "2026-10-21", ggr: 200 },
      ],
    });
    expect(Object.keys((input as { entries: object[] }).entries[1])).toEqual(["date", "ggr"]);
    expect(callLog().at(-1)).toMatchObject({
      tool: "preparar_lancamento_dias",
      tenant_id: HOUSE_A,
      ok: true,
    });
  });

  it("maps the other four preparar_* tools to their actions", async () => {
    vi.mocked(createPreview).mockResolvedValue(preview);
    const client = await connect();
    await client.callTool({
      name: "preparar_ggr_mensal",
      arguments: { casa: HOUSE_A, mes: "2026-10", ggr: 1234.5, atualizado_ate: "2026-10-23" },
    });
    await client.callTool({
      name: "preparar_custo",
      arguments: {
        casa: HOUSE_A,
        data: "2026-10-20",
        descricao: "Servidor",
        valor: 99.9,
        categoria: "Infra",
        repetir_todo_mes: true,
      },
    });
    await client.callTool({
      name: "preparar_exclusao_custo",
      arguments: { casa: HOUSE_A, id: COST_1, modo: "pular_mes" },
    });
    await client.callTool({
      name: "preparar_meta",
      arguments: {
        casa: HOUSE_A,
        metrica: "ftds",
        direcao: "no_maximo",
        valor_diario: null,
        a_partir_de: "2026-10-25",
      },
    });

    const calls = vi.mocked(createPreview).mock.calls.map(([, action, input]) => [action, input]);
    expect(calls).toEqual([
      [
        "ggr_mensal",
        { tenantId: HOUSE_A, month: "2026-10", ggr: 1234.5, validThrough: "2026-10-23" },
      ],
      [
        "custo",
        {
          tenantId: HOUSE_A,
          costDate: "2026-10-20",
          descricao: "Servidor",
          valor: 99.9,
          categoria: "Infra",
          repeatMonthly: true,
        },
      ],
      ["exclusao_custo", { tenantId: HOUSE_A, id: COST_1, mode: "skip_month" }],
      [
        "meta",
        {
          tenantId: HOUSE_A,
          metric: "ftds",
          direction: "lte",
          dailyValue: null,
          validFrom: "2026-10-25",
        },
      ],
    ]);
  });

  it("a preview refused by the core comes back as isError with its pt-BR message", async () => {
    vi.mocked(createPreview).mockRejectedValue(new Error("Seu acesso ao MCP é só leitura."));
    const client = await connect(identity(ADMIN_A, "read"));
    const result = await client.callTool({
      name: "preparar_ggr_mensal",
      arguments: { casa: HOUSE_A, mes: "2026-10", ggr: null },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Seu acesso ao MCP é só leitura.");
    expect(callLog().at(-1)).toMatchObject({ ok: false, tenant_id: HOUSE_A });
  });
});

describe("handleMcpRequest (/api/mcp)", () => {
  const post = (body: unknown, token?: string) =>
    new Request("http://localhost:3000/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "curl", version: "1" },
    },
  };

  beforeEach(() => {
    vi.stubEnv("MCP_ENABLED", "true");
    vi.stubEnv("VITE_PUBLIC_APP_URL", "https://crm.example.com/");
    vi.mocked(resolveBearer).mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("404 when MCP_ENABLED is off, before looking at the token", async () => {
    vi.stubEnv("MCP_ENABLED", "false");
    const response = await handleMcpRequest(post(initialize, "tok"));
    expect(response.status).toBe(404);
    expect(resolveBearer).not.toHaveBeenCalled();
  });

  it("401 with WWW-Authenticate resource_metadata without a bearer or with an invalid one", async () => {
    const header =
      'Bearer resource_metadata="https://crm.example.com/.well-known/oauth-protected-resource/api/mcp"';
    const missing = await handleMcpRequest(post(initialize));
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe(header);

    vi.mocked(resolveBearer).mockResolvedValue(null);
    const invalid = await handleMcpRequest(post(initialize, "bad"));
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("www-authenticate")).toBe(header);
    expect(resolveBearer).toHaveBeenCalledWith("bad");
  });

  it("production without VITE_PUBLIC_APP_URL: 500 instead of a Host-derived 401 header", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VITE_PUBLIC_APP_URL", "");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await handleMcpRequest(post(initialize));
    expect(response.status).toBe(500);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("answers initialize and tools/call as JSON, statelessly, for a valid bearer", async () => {
    vi.mocked(resolveBearer).mockResolvedValue(identity());
    vi.mocked(listarEscopos).mockResolvedValue({
      superAdmin: false,
      houses: [],
      groups: [],
      nivel: "leitura",
      areas: ["financeiro"],
    });

    const init = await handleMcpRequest(post(initialize, "good"));
    expect(init.status).toBe(200);
    expect(init.headers.get("content-type")).toContain("application/json");
    expect(init.headers.get("mcp-session-id")).toBeNull();
    expect((await init.json()).result.serverInfo.name).toBe("betleads");

    const call = await handleMcpRequest(
      post(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "listar_escopos", arguments: {} },
        },
        "good",
      ),
    );
    expect(call.status).toBe(200);
    const body = await call.json();
    expect(body.result.structuredContent.nivel).toBe("leitura");
    expect(callLog()).toHaveLength(1);
  });

  it("405 for GET and DELETE once authenticated (no sessions, no SSE stream)", async () => {
    vi.mocked(resolveBearer).mockResolvedValue(identity());
    for (const method of ["GET", "DELETE"]) {
      const response = await handleMcpRequest(
        new Request("http://localhost:3000/api/mcp", {
          method,
          headers: { authorization: "Bearer good", accept: "text/event-stream" },
        }),
      );
      expect(response.status).toBe(405);
    }
  });
});

describe("call log tenant id", () => {
  it("logs a null tenant when preparar_* gets a malformed house id", async () => {
    vi.mocked(createPreview).mockRejectedValue(new Error("Entrada inválida: tenantId: inválido"));
    const client = await connect();
    const result = await client.callTool({
      name: "preparar_meta",
      arguments: { casa: "nao-e-uuid", metrica: "ftds", direcao: "pelo_menos", valor_diario: 1 },
    });
    expect(result.isError).toBe(true);
    expect(callLog().at(-1)).toMatchObject({ tool: "preparar_meta", tenant_id: null, ok: false });
  });
});

describe("areas (MCP do grupo)", () => {
  const FINANCE_TOOLS = [
    "resumo_financeiro",
    "resumo_por_dia",
    "mes_da_casa",
    "metas_da_casa",
    "preparar_lancamento_dias",
    "preparar_ggr_mensal",
    "preparar_custo",
    "preparar_exclusao_custo",
    "preparar_meta",
    "confirmar_alteracao",
  ];
  const GROUP = "00000000-0000-4000-8000-00000000a001";

  it("financeiro only: no operação tool is registered", async () => {
    const client = await connect(identity(ADMIN_A, "write", ["financeiro"]));
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain("visao_teste");
    expect(names.sort()).toEqual(["listar_escopos", ...FINANCE_TOOLS].sort());
  });

  it("operacao only: listar_escopos plus the operação tools, read-only, no finance tool", async () => {
    const client = await connect(identity(ADMIN_A, "read", ["operacao"]));
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["listar_escopos", "visao_teste"]);
    expect(tools.find((tool) => tool.name === "visao_teste")?.annotations?.readOnlyHint).toBe(true);
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("Operação (só leitura)");
    expect(instructions).not.toContain("confirmar_alteracao");
  });

  it("both areas: every tool, and the instructions cover both", async () => {
    const client = await connect(identity(ADMIN_A, "write", ["financeiro", "operacao"]));
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names.sort()).toEqual(["listar_escopos", "visao_teste", ...FINANCE_TOOLS].sort());
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("listar_escopos");
    expect(instructions).toContain("confirmar_alteracao");
    expect(instructions).toContain("Operação (só leitura)");
    expect(instructions).toContain("calculado_em");
    expect(instructions).toContain("resumo_por_dia ou visao_geral_por_dia");
  });

  it("an operação tool still refuses in its handler when the area is gone", async () => {
    const id = identity(ADMIN_A, "read", ["financeiro", "operacao"]);
    const client = await connect(id);
    id.areas = ["financeiro"];
    const result = await client.callTool({
      name: "visao_teste",
      arguments: { escopo: { tipo: "todas" } },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Seu acesso ao MCP não inclui operação.");
    expect(ops.run).not.toHaveBeenCalled();
    expect(callLog().at(-1)).toMatchObject({ tool: "visao_teste", ok: false });
  });

  it("a finance tool still refuses in its handler when the area is gone", async () => {
    const id = identity(ADMIN_A, "read", ["financeiro", "operacao"]);
    const client = await connect(id);
    id.areas = ["operacao"];
    const result = await client.callTool({ name: "metas_da_casa", arguments: { casa: HOUSE_A } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Seu acesso ao MCP não inclui financeiro.");
    expect(metasDaCasa).not.toHaveBeenCalled();
  });

  it("logs the operação call's args and scope, counting the houses of the result", async () => {
    ops.run.mockResolvedValue({
      rotulo: "Grupo",
      casas: [{ id: "a" }, { id: "b" }],
      casas_com_erro: [{ id: "c", nome: "C", erro: "x" }],
    });
    const client = await connect(identity(ADMIN_A, "read", ["operacao"]));
    const args = { escopo: { tipo: "grupo", id: GROUP } };
    const result = await client.callTool({ name: "visao_teste", arguments: args });
    expect(result.isError).toBeFalsy();
    expect(ops.run.mock.calls[0][1]).toEqual(args);
    expect(callLog().at(-1)).toMatchObject({
      tool: "visao_teste",
      ok: true,
      tenant_id: null,
      args,
      scope: { tipo: "grupo", id: GROUP, casas: 3 },
    });
  });

  it("logs the house id for a casa scope", async () => {
    ops.run.mockResolvedValue({ casas: [{ id: HOUSE_A }], casas_com_erro: [] });
    const client = await connect(identity(ADMIN_A, "read", ["operacao"]));
    await client.callTool({
      name: "visao_teste",
      arguments: { escopo: { tipo: "casa", id: HOUSE_A } },
    });
    expect(callLog().at(-1)).toMatchObject({
      tenant_id: HOUSE_A,
      scope: { tipo: "casa", id: HOUSE_A, casas: 1 },
    });
  });

  it("blocks an operação result carrying player data", async () => {
    ops.run.mockResolvedValue({ casas: [{ id: HOUSE_A, jogadores: [{ telefone: "5511" }] }] });
    const client = await connect(identity(ADMIN_A, "read", ["operacao"]));
    const result = await client.callTool({
      name: "visao_teste",
      arguments: { escopo: { tipo: "todas" } },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain("5511");
    expect(callLog().at(-1)).toMatchObject({ ok: false });
  });

  it("never logs the confirmation code itself", async () => {
    vi.mocked(confirmPreview).mockResolvedValue({ ok: true, resultado: {} });
    const client = await connect();
    await client.callTool({ name: "confirmar_alteracao", arguments: { codigo: "segredo" } });
    expect(JSON.stringify(callLog().at(-1)?.args)).not.toContain("segredo");
  });

  it("listar_escopos is there with either area", async () => {
    vi.mocked(listarEscopos).mockResolvedValue({ nivel: "leitura", areas: ["operacao"] });
    const client = await connect(identity(ADMIN_A, "read", ["operacao"]));
    const result = await client.callTool({ name: "listar_escopos", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ areas: ["operacao"] });
  });
});
