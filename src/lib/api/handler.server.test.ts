// API de leitura: /api/v1 handler (spec 2026-11-20 §5, §7). Real keys and
// call log over createFakeDb; the tools are stand-ins so these tests pin the
// HTTP pipeline (flag, key, area, rate limit, errors, log, calculado_em).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));
const tools = vi.hoisted(() => ({ fin: vi.fn(), ops: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("../sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

vi.mock("./tools.server", () => {
  const list = [
    {
      name: "listar_escopos",
      title: "Listar escopos",
      description: "d",
      area: null,
      inputSchema: z.object({}),
      run: async () => ({ ok: true }),
    },
    {
      name: "fin_teste",
      title: "Fin",
      description: "d",
      area: "financeiro",
      inputSchema: z.object({ casa: z.string() }),
      run: (identity: unknown, args: unknown) => tools.fin(identity, args),
    },
    {
      name: "ops_teste",
      title: "Ops",
      description: "d",
      area: "operacao",
      inputSchema: z.object({}),
      run: (identity: unknown, args: unknown) => tools.ops(identity, args),
    },
  ];
  return {
    API_TOOLS: list,
    toolsFor: (areas: string[]) => list.filter((t) => t.area === null || areas.includes(t.area)),
  };
});

import { CALLS_PER_MINUTE } from "@/lib/mcp/config.server";

import { API_INVALID_KEY, handleApiRequest } from "./handler.server";
import { createApiKey } from "./keys.server";
import { createFakeDb } from "../sms-bulk.test-support";

const USER = "00000000-0000-4000-8000-0000000000bb";
const HOUSE = "00000000-0000-4000-8000-000000000101";

let key: string;
let keyId: string;

async function setup(areas = ["financeiro"]) {
  fake.admin.rows("mcp_access").push({ user_id: USER, level: "write", areas });
  const created = await createApiKey(USER, "BI");
  key = created.key;
  keyId = created.view.id;
}

function call(path: string | null, init: { method?: string; body?: unknown; auth?: string } = {}) {
  const url = `https://betleads.test/api/v1${path ? `/${path}` : ""}`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  const auth = init.auth ?? `Bearer ${key}`;
  if (auth) headers.authorization = auth;
  const request = new Request(url, {
    method: init.method ?? (path && path !== "openapi.json" ? "POST" : "GET"),
    headers,
    body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
  });
  return handleApiRequest(request, path);
}

const callLog = () => fake.admin.rows("mcp_call_log").filter((row) => !String(row.tool).startsWith("api."));

beforeEach(() => {
  fake.admin.reset();
  tools.fin.mockReset();
  tools.ops.mockReset();
  process.env.API_ENABLED = "true";
  process.env.VITE_PUBLIC_APP_URL = "https://betleads.test";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-20T13:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.API_ENABLED;
});

describe("handleApiRequest", () => {
  it("is 404 everywhere while API_ENABLED is off", async () => {
    await setup();
    process.env.API_ENABLED = "false";
    expect((await call(null)).status).toBe(404);
    expect((await call("fin_teste", { body: { casa: HOUSE } })).status).toBe(404);
    expect((await call("openapi.json")).status).toBe(404);
  });

  it("401 without a key or with an invalid one", async () => {
    await setup();
    const none = await call(null, { auth: "" });
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toContain("Bearer");
    expect(await none.json()).toEqual({ erro: API_INVALID_KEY });
    expect((await call(null, { auth: "Bearer blk_nada_disso_aqui_xxxxxxxxxxxxxxx" })).status).toBe(401);
  });

  it("GET /api/v1 lists only the tools of the key's areas", async () => {
    await setup(["financeiro"]);
    const response = await call(null);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ferramentas.map((t: { nome: string }) => t.nome)).toEqual([
      "listar_escopos",
      "fin_teste",
    ]);
    expect(body.ferramentas[1].rota).toBe("/api/v1/fin_teste");
  });

  it("runs the tool with the owner's read-only identity, adds calculado_em and logs the key", async () => {
    await setup();
    tools.fin.mockResolvedValue({ total: 10 });
    const response = await call("fin_teste", { body: { casa: HOUSE } });

    expect(response.status).toBe(200);
    // 13:00Z is 10:00 in Brasília.
    expect(await response.json()).toEqual({ total: 10, calculado_em: "2026-11-20 10:00:00" });
    const [identity, args] = tools.fin.mock.calls[0];
    expect(identity).toMatchObject({ userId: USER, level: "read", apiKeyId: keyId });
    expect(args).toEqual({ casa: HOUSE });
    expect(callLog()).toEqual([
      expect.objectContaining({
        user_id: USER,
        connection_id: null,
        api_key_id: keyId,
        tool: "fin_teste",
        tenant_id: HOUSE,
        ok: true,
      }),
    ]);
  });

  it("403 for a tool outside the key's areas, without running it", async () => {
    await setup(["financeiro"]);
    const response = await call("ops_teste", { body: {} });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ erro: "Seu acesso não inclui operação." });
    expect(tools.ops).not.toHaveBeenCalled();
    expect(callLog()[0]).toMatchObject({ ok: false, tool: "ops_teste" });
  });

  it("maps the tool's errors: permission 403, zod 400, other message 400, non-Error 500", async () => {
    await setup();
    tools.fin.mockRejectedValueOnce(new Error("Sem permissão"));
    expect((await call("fin_teste", { body: { casa: HOUSE } })).status).toBe(403);

    tools.fin.mockImplementationOnce(async (_identity: unknown, args: unknown) =>
      z.object({ casa: z.number() }).parse(args),
    );
    const invalid = await call("fin_teste", { body: { casa: HOUSE } });
    expect(invalid.status).toBe(400);
    const body = await invalid.json();
    expect(body.erro).toBe("Argumentos inválidos.");
    expect(Array.isArray(body.detalhes)).toBe(true);

    tools.fin.mockRejectedValueOnce(new Error("Informe o período: preset, ou início e fim."));
    expect((await call("fin_teste", { body: { casa: HOUSE } })).status).toBe(400);

    tools.fin.mockRejectedValueOnce("boom");
    const internal = await call("fin_teste", { body: { casa: HOUSE } });
    expect(internal.status).toBe(500);
    expect(await internal.json()).toEqual({ erro: "Erro interno." });
  });

  it("400 for a body that is not a JSON object; 404 unknown tool; 405 wrong method", async () => {
    await setup();
    expect((await call("fin_teste", { body: "{nope" })).status).toBe(400);
    expect((await call("fin_teste", { body: "[1]" })).status).toBe(400);
    expect((await call("nao_existe", { body: {} })).status).toBe(404);
    expect((await call("fin_teste", { method: "GET" })).status).toBe(405);
  });

  it(`429 past ${CALLS_PER_MINUTE} calls a minute for one key`, async () => {
    await setup();
    tools.fin.mockResolvedValue({ ok: true });
    for (let i = 0; i < CALLS_PER_MINUTE; i++) {
      fake.admin.rows("mcp_call_log").push({
        api_key_id: keyId,
        user_id: USER,
        tool: "fin_teste",
        ok: true,
        created_at: new Date().toISOString(),
      });
    }
    const response = await call("fin_teste", { body: { casa: HOUSE } });
    expect(response.status).toBe(429);
    expect(tools.fin).not.toHaveBeenCalled();
  });

  it("operação results with player data are refused", async () => {
    await setup(["operacao"]);
    tools.ops.mockResolvedValue({ casas: [{ telefone: "5511999999999" }] });
    const response = await call("ops_teste", { body: {} });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ erro: "Erro interno." });
  });

  it("openapi.json needs no key and documents every tool", async () => {
    const response = await call("openapi.json", { auth: "" });
    expect(response.status).toBe(200);
    const doc = await response.json();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers[0].url).toBe("https://betleads.test/api/v1");
    expect(Object.keys(doc.paths).sort()).toEqual(
      ["/", "/fin_teste", "/listar_escopos", "/ops_teste"].sort(),
    );
    expect(doc.paths["/fin_teste"].post.requestBody.content["application/json"].schema).toMatchObject({
      type: "object",
      properties: { casa: { type: "string" } },
    });
  });
});
