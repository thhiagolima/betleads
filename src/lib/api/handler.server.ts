// API de leitura: /api/v1 (docs/superpowers/specs/2026-11-20-api-leitura-design.md §5, §7).
// Same pipeline as an MCP read tool: key → rate limit (per key) → area →
// run → no player data (operação) → mcp_call_log row (api_key_id) → result
// with calculado_em. Errors are `{erro}` in pt-BR with an HTTP status.
import { ZodError } from "zod";

import { RATE_LIMITED, checkApiRateLimit, logCall } from "@/lib/mcp/call-log.server";
import { notFound, publicBaseUrl } from "@/lib/mcp/oauth.server";
import { assertSemDadosPessoais } from "@/lib/mcp/ops/runner.server";
import { agoraBrasilia } from "@/lib/mcp/server.server";

import { isApiEnabled } from "./config.server";
import { resolveApiKey, type ApiIdentity } from "./keys.server";
import { buildOpenApi } from "./openapi.server";
import { API_TOOLS, toolsFor, type ApiTool } from "./tools.server";

export const API_INVALID_KEY = "Chave de API inválida ou revogada.";
const INTERNAL_ERROR = "Erro interno.";
const AREA_LABEL = { financeiro: "financeiro", operacao: "operação" } as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

const erro = (status: number, message: string, extra: Record<string, unknown> = {}) =>
  json({ erro: message, ...extra }, status);

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** HTTP status of an error thrown by a tool (its pt-BR message goes back as is). */
function statusOf(error: unknown): number {
  if (error instanceof HttpError) return error.status;
  if (error instanceof ZodError) return 400;
  if (!(error instanceof Error) || !error.message) return 500;
  if (error.message === RATE_LIMITED) return 429;
  if (/sem permiss|não tem acesso|não inclui/i.test(error.message)) return 403;
  return 400;
}

/** House id of a call, for mcp_call_log.tenant_id (well-formed uuids only). */
function tenantOf(args: Record<string, unknown>): string | null {
  const escopo = args.escopo;
  const id =
    typeof args.casa === "string"
      ? args.casa
      : isPlainObject(escopo) && escopo.tipo === "casa" && typeof escopo.id === "string"
        ? escopo.id
        : null;
  return id && UUID.test(id) ? id : null;
}

function scopeOf(args: Record<string, unknown>) {
  const escopo = args.escopo;
  if (isPlainObject(escopo) && typeof escopo.tipo === "string") {
    return { tipo: escopo.tipo, id: typeof escopo.id === "string" ? escopo.id : null };
  }
  if (typeof args.casa === "string") return { tipo: "casa", id: args.casa };
  return null;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "O corpo precisa ser um JSON válido.");
  }
  if (!isPlainObject(body)) throw new HttpError(400, "O corpo precisa ser um objeto JSON.");
  return body;
}

async function runApiTool(identity: ApiIdentity, tool: ApiTool, request: Request) {
  const started = Date.now();
  let args: Record<string, unknown> = {};
  const log = (ok: boolean, error?: string) =>
    logCall({
      identity: { userId: identity.userId, connectionId: null },
      apiKeyId: identity.apiKeyId,
      tool: tool.name,
      tenantId: tenantOf(args),
      ok,
      error,
      durationMs: Date.now() - started,
      args,
      scope: scopeOf(args),
    });
  try {
    args = await readBody(request);
    await checkApiRateLimit(identity.apiKeyId);
    if (tool.area && !identity.areas.includes(tool.area)) {
      throw new HttpError(403, `Seu acesso não inclui ${AREA_LABEL[tool.area]}.`);
    }
    const result = await tool.run(identity, args);
    if (tool.area === "operacao") {
      try {
        assertSemDadosPessoais(result);
      } catch (error) {
        // A tool leaking player data is our bug, never the caller's: 500.
        console.error("[api]", tool.name, error);
        throw new HttpError(500, INTERNAL_ERROR);
      }
    }
    await log(true);
    const body = isPlainObject(result) ? result : { resultado: result };
    return json({ ...body, calculado_em: agoraBrasilia() });
  } catch (error) {
    const status = statusOf(error);
    if (status === 500) console.error("[api]", tool.name, error);
    const message =
      error instanceof ZodError
        ? "Argumentos inválidos."
        : status === 500
          ? INTERNAL_ERROR
          : (error as Error).message;
    await log(false, message);
    return error instanceof ZodError
      ? erro(400, message, { detalhes: error.issues })
      : erro(status, message);
  }
}

/**
 * /api/v1 (`path` null), /api/v1/openapi.json and /api/v1/{ferramenta}.
 * 404 everywhere while API_ENABLED is off.
 */
export async function handleApiRequest(request: Request, path: string | null): Promise<Response> {
  if (!isApiEnabled()) return notFound();

  if (path === "openapi.json") {
    if (request.method !== "GET") return erro(405, "Use GET.");
    return json(buildOpenApi(`${publicBaseUrl(request)}/api/v1`));
  }

  const auth = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(auth);
  const identity = match ? await resolveApiKey(match[1]) : null;
  if (!identity) {
    return json({ erro: API_INVALID_KEY }, 401, { "www-authenticate": 'Bearer realm="betleads"' });
  }

  if (path === null || path === "") {
    if (request.method !== "GET") return erro(405, "Use GET.");
    return json({
      areas: identity.areas,
      ferramentas: toolsFor(identity.areas).map((tool) => ({
        nome: tool.name,
        titulo: tool.title,
        descricao: tool.description,
        area: tool.area,
        rota: `/api/v1/${tool.name}`,
      })),
      calculado_em: agoraBrasilia(),
    });
  }

  const tool = API_TOOLS.find((candidate) => candidate.name === path);
  if (!tool) return erro(404, "Ferramenta desconhecida. Veja a lista em GET /api/v1.");
  if (request.method !== "POST") return erro(405, "Use POST com os argumentos em JSON.");
  return runApiTool(identity, tool, request);
}
