// MCP financeiro, Task 8: the McpServer with the 10 finance tools (spec §6).
// A new server is built per request (stateless transport), bound to the
// identity resolved from the bearer token. Every handler runs:
//   rate limit (DB-counted) → tool core → mcp_call_log row → result
// and any thrown error comes back as `isError: true` with its pt-BR message
// (also logged, with ok: false). Permissions are never checked here: the read
// cores and createPreview/confirmPreview do it through the panel's `*For`
// functions.
//
// Write tools take pt-BR field names (spec §6: casa, entradas[{data,
// anuncios, ggr}], mes, …) and translate them to the panel's action input
// (tenantId, entries[{date, adSpend, ggr}], month, …). The tool schemas here
// only shape the fields for Claude; the real validation is the action's own
// schema inside createPreview, so its errors come back in pt-BR. An absent
// optional field stays absent in the action input ("keeps the value"), and
// `null` passes through ("clears it"), as in the panel.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { GOAL_METRICS } from "@/lib/finance/finance-data.server";

import { resolveBearer, type McpIdentity } from "./access.server";
import { CONFIRM_TOOL, checkRateLimit, logCall } from "./call-log.server";
import { MAX_DAY_ENTRIES, isMcpEnabled } from "./config.server";
import { sha256Hex } from "./crypto.server";
import { notFound, publicBaseUrl } from "./oauth.server";
import { confirmPreview, createPreview } from "./preview.server";
import {
  listarEscopos,
  mesDaCasa,
  mesDaCasaInput,
  metasDaCasa,
  metasDaCasaInput,
  resumoFinanceiro,
  resumoFinanceiroInput,
} from "./read-tools.server";
import type { WriteActionName } from "./write-actions.server";

const CONFIRM_HINT =
  "Mostre a prévia ao usuário e só chame confirmar_alteracao depois que ele aprovar.";
const MONEY_HINT = "Valores em dinheiro: número em reais com ponto decimal (ex.: 12345.00).";
const CASA_HINT = "casa: id da casa, vindo de listar_escopos.";
const INTERNAL_ERROR = "Erro interno.";

const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const PREPARE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const CONFIRM: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

/** Copies only the keys that are present (not undefined), so "absent" stays absent. */
function present<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// ─── Write tool schemas (pt-BR) and their translation ──────────────────────

const dataIso = z.string().describe("Data no formato AAAA-MM-DD.");
const casa = z.string().describe("Id da casa (de listar_escopos).");

const lancamentoDiasShape = z.object({
  casa,
  entradas: z
    .array(
      z.object({
        data: dataIso,
        anuncios: z
          .number()
          .nullable()
          .optional()
          .describe("Gasto com anúncios do dia. Ausente mantém o valor; null apaga."),
        ggr: z
          .number()
          .nullable()
          .optional()
          .describe("GGR do dia. Ausente mantém o valor; null apaga."),
      }),
    )
    .describe(`Até ${MAX_DAY_ENTRIES} dias por chamada, sem datas repetidas nem futuras.`),
});

const ggrMensalShape = z.object({
  casa,
  mes: z.string().describe("Mês no formato AAAA-MM."),
  ggr: z
    .number()
    .nullable()
    .describe("GGR acumulado do mês (Perdas na casa). null remove e volta ao GGR diário."),
  atualizado_ate: dataIso
    .optional()
    .describe("Até que dia o total vale (AAAA-MM-DD). Obrigatório quando ggr não é null."),
});

const custoShape = z.object({
  casa,
  id: z.string().optional().describe("Id do custo a editar. Ausente cria um custo novo."),
  data: dataIso.describe("Dia do custo (AAAA-MM-DD), hoje ou antes."),
  descricao: z.string(),
  valor: z.number().describe("Valor em reais, não negativo."),
  categoria: z.string().nullable().optional(),
  repetir_todo_mes: z
    .boolean()
    .optional()
    .describe("Repete o custo todo mês no mesmo dia. Na edição, se omitido, mantém o valor atual."),
});

const EXCLUSAO_MODOS = {
  excluir: "delete",
  pular_mes: "skip_month",
  encerrar_serie: "end_series",
} as const;
const exclusaoCustoShape = z.object({
  casa,
  id: z.string().describe("Id do custo (de mes_da_casa)."),
  modo: z
    .enum(["excluir", "pular_mes", "encerrar_serie"])
    .optional()
    .describe(
      "excluir (padrão) apaga o custo; pular_mes zera só este mês de um custo recorrente; encerrar_serie para a repetição daqui em diante.",
    ),
});

const DIRECOES = { pelo_menos: "gte", no_maximo: "lte" } as const;
const metaShape = z.object({
  casa,
  metrica: z.enum(GOAL_METRICS).describe("Métrica da meta (mesmos códigos de metas_da_casa)."),
  direcao: z
    .enum(["pelo_menos", "no_maximo"])
    .describe("pelo_menos: a meta é atingir o valor; no_maximo: ficar abaixo dele."),
  valor_diario: z.number().nullable().describe("Valor diário da meta. null remove a meta."),
  a_partir_de: dataIso.optional().describe("Início da vigência (AAAA-MM-DD). Ausente = hoje."),
});

type WriteToolDef<S extends z.ZodObject> = {
  name: string;
  action: WriteActionName;
  title: string;
  summary: string;
  shape: S;
  toInput(args: z.infer<S>): Record<string, unknown>;
};

const writeTools = [
  {
    name: "preparar_lancamento_dias",
    action: "lancamento_dias",
    title: "Preparar lançamento de dias",
    summary: `Prepara o lançamento de anúncios e GGR por dia de uma casa (até ${MAX_DAY_ENTRIES} dias). Campos: casa, entradas[{data, anuncios?, ggr?}].`,
    shape: lancamentoDiasShape,
    toInput: (args: z.infer<typeof lancamentoDiasShape>) => ({
      tenantId: args.casa,
      entries: args.entradas.map((e) => present({ date: e.data, adSpend: e.anuncios, ggr: e.ggr })),
    }),
  } satisfies WriteToolDef<typeof lancamentoDiasShape>,
  {
    name: "preparar_ggr_mensal",
    action: "ggr_mensal",
    title: "Preparar GGR mensal",
    summary:
      "Prepara o GGR acumulado do mês (Perdas na casa) de uma casa. Campos: casa, mes, ggr (null remove), atualizado_ate.",
    shape: ggrMensalShape,
    toInput: (args: z.infer<typeof ggrMensalShape>) =>
      present({
        tenantId: args.casa,
        month: args.mes,
        ggr: args.ggr,
        validThrough: args.atualizado_ate,
      }),
  } satisfies WriteToolDef<typeof ggrMensalShape>,
  {
    name: "preparar_custo",
    action: "custo",
    title: "Preparar custo",
    summary:
      "Prepara a criação (sem id) ou edição (com id) de um outro custo da casa. Campos: casa, id?, data, descricao, valor, categoria?, repetir_todo_mes?.",
    shape: custoShape,
    toInput: (args: z.infer<typeof custoShape>) =>
      present({
        tenantId: args.casa,
        id: args.id,
        costDate: args.data,
        descricao: args.descricao,
        valor: args.valor,
        categoria: args.categoria,
        repeatMonthly: args.repetir_todo_mes,
      }),
  } satisfies WriteToolDef<typeof custoShape>,
  {
    name: "preparar_exclusao_custo",
    action: "exclusao_custo",
    title: "Preparar exclusão de custo",
    summary:
      "Prepara a exclusão de um outro custo da casa. Campos: casa, id, modo (excluir | pular_mes | encerrar_serie).",
    shape: exclusaoCustoShape,
    toInput: (args: z.infer<typeof exclusaoCustoShape>) =>
      present({
        tenantId: args.casa,
        id: args.id,
        mode: args.modo ? EXCLUSAO_MODOS[args.modo] : undefined,
      }),
  } satisfies WriteToolDef<typeof exclusaoCustoShape>,
  {
    name: "preparar_meta",
    action: "meta",
    title: "Preparar meta",
    summary:
      "Prepara a definição (ou remoção, com valor_diario null) da meta diária de uma métrica da casa. Campos: casa, metrica, direcao, valor_diario, a_partir_de?.",
    shape: metaShape,
    toInput: (args: z.infer<typeof metaShape>) =>
      present({
        tenantId: args.casa,
        metric: args.metrica,
        direction: DIRECOES[args.direcao],
        dailyValue: args.valor_diario,
        validFrom: args.a_partir_de,
      }),
  } satisfies WriteToolDef<typeof metaShape>,
];

// ─── Handler wrapper ────────────────────────────────────────────────────────

type ToolContext = { tenantId: string | null; previewCodeHash?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Only a well-formed id goes to mcp_call_log.tenant_id (uuid column): a bad one would drop the row. */
const asUuid = (value: unknown): string | null =>
  typeof value === "string" && UUID.test(value) ? value : null;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorMessage = (error: unknown) =>
  error instanceof Error && error.message ? error.message : INTERNAL_ERROR;

/** Tenant of a confirmation code, for the log only (best effort). */
async function previewTenant(identity: McpIdentity, codeHash: string): Promise<string | null> {
  try {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose client typing */
    const { data } = await (supabaseAdmin as any)
      .from("mcp_previews")
      .select("tenant_id")
      .eq("code_hash", codeHash)
      .eq("user_id", identity.userId)
      .maybeSingle();
    return (data?.tenant_id as string | undefined) ?? null;
  } catch {
    return null;
  }
}

/** rate limit → run → log → result; errors become `isError` with the pt-BR message. */
async function runTool(
  identity: McpIdentity,
  tool: string,
  context: ToolContext,
  run: () => Promise<unknown>,
): Promise<CallToolResult> {
  const started = Date.now();
  const log = (ok: boolean, error?: string) =>
    logCall({
      identity,
      tool,
      tenantId: context.tenantId,
      ok,
      error,
      durationMs: Date.now() - started,
      previewCodeHash: context.previewCodeHash,
    });
  try {
    await checkRateLimit(identity, tool);
    const result = await run();
    await log(true);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: isPlainObject(result) ? result : { resultado: result },
    };
  } catch (error) {
    const message = errorMessage(error);
    if (message === INTERNAL_ERROR) console.error("[mcp]", tool, error);
    await log(false, message);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

// ─── Server ─────────────────────────────────────────────────────────────────

/** The MCP server for one request, bound to the bearer's identity. */
export function createMcpServer(identity: McpIdentity): McpServer {
  const server = new McpServer(
    { name: "betleads-financeiro", version: "1.0.0" },
    {
      instructions:
        "Financeiro das casas do Betleads. Comece por listar_escopos para saber as casas e grupos do usuário. " +
        "Escritas têm duas etapas: preparar_* devolve uma prévia e um codigo_confirmacao; mostre a prévia e só chame confirmar_alteracao depois que o usuário aprovar. " +
        MONEY_HINT,
    },
  );

  server.registerTool(
    "listar_escopos",
    {
      title: "Listar escopos",
      description:
        "Casas e grupos que o usuário pode consultar (id, nome, se é demo) e o nível de acesso ao MCP. Use os ids nas outras ferramentas.",
      annotations: READ,
    },
    () => runTool(identity, "listar_escopos", { tenantId: null }, () => listarEscopos(identity)),
  );

  server.registerTool(
    "resumo_financeiro",
    {
      title: "Resumo financeiro",
      description:
        "Mesmo resultado do painel financeiro para uma casa, um grupo ou todas as casas: totais, linhas por casa, KPIs, dias pendentes e metas. " +
        "escopo: {tipo: casa|grupo, id} ou {tipo: todas}. periodo: {preset: today|yesterday|7d|month} ou {inicio, fim} (AAAA-MM-DD). comparar (opcional): previous, same_weekday_last_week, last_week, same_period_last_year ou none. " +
        MONEY_HINT,
      inputSchema: resumoFinanceiroInput,
      annotations: READ,
    },
    (args) =>
      runTool(
        identity,
        "resumo_financeiro",
        { tenantId: args.escopo.tipo === "casa" ? args.escopo.id : null },
        () => resumoFinanceiro(identity, args),
      ),
  );

  server.registerTool(
    "mes_da_casa",
    {
      title: "Mês da casa",
      description:
        `Fechamento financeiro do mês de uma casa: dias lançados, outros custos, taxas em vigor, GGR do mês e pendências. ${CASA_HINT} mes: AAAA-MM. ` +
        MONEY_HINT,
      inputSchema: mesDaCasaInput,
      annotations: READ,
    },
    (args) =>
      runTool(identity, "mes_da_casa", { tenantId: args.casa }, () => mesDaCasa(identity, args)),
  );

  server.registerTool(
    "metas_da_casa",
    {
      title: "Metas da casa",
      description: `Metas diárias em vigor hoje para cada métrica da casa. ${CASA_HINT}`,
      inputSchema: metasDaCasaInput,
      annotations: READ,
    },
    (args) =>
      runTool(identity, "metas_da_casa", { tenantId: args.casa }, () =>
        metasDaCasa(identity, args),
      ),
  );

  for (const tool of writeTools) {
    const def = tool as WriteToolDef<z.ZodObject>;
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: `${def.summary} Não grava nada: devolve a prévia (linhas antes → depois e avisos) e um codigo_confirmacao válido por 10 minutos. ${CONFIRM_HINT} ${MONEY_HINT}`,
        inputSchema: def.shape,
        annotations: PREPARE,
      },
      (args: Record<string, unknown>) =>
        runTool(identity, def.name, { tenantId: asUuid(args.casa) }, () =>
          createPreview(identity, def.action, def.toInput(args)),
        ),
    );
  }

  server.registerTool(
    CONFIRM_TOOL,
    {
      title: "Confirmar alteração",
      description:
        "Aplica a prévia gerada por um preparar_*, usando o codigo_confirmacao dela. Só chame depois que o usuário aprovar a prévia. " +
        "O código é de uso único; repetir a chamada com o mesmo código não grava de novo (responde ja_confirmada).",
      inputSchema: z.object({ codigo: z.string().describe("codigo_confirmacao da prévia.") }),
      annotations: CONFIRM,
    },
    async ({ codigo }) => {
      const previewCodeHash = await sha256Hex(codigo);
      const context: ToolContext = {
        tenantId: await previewTenant(identity, previewCodeHash),
        previewCodeHash,
      };
      return runTool(identity, CONFIRM_TOOL, context, () => confirmPreview(identity, codigo));
    },
  );

  return server;
}

// ─── HTTP endpoint (/api/mcp) ───────────────────────────────────────────────

const BEARER = /^Bearer\s+(\S+)\s*$/i;

/** 401 pointing Claude at the protected resource metadata (RFC 9728 §5.1). */
function unauthorized(request: Request): Response {
  let base: string;
  try {
    base = publicBaseUrl(request);
  } catch (error) {
    // Production without VITE_PUBLIC_APP_URL: fail closed, never echo the Host header.
    console.error("[mcp]", error);
    return Response.json(
      { error: "server_error", error_description: "Erro interno." },
      { status: 500 },
    );
  }
  const metadata = `${base}/.well-known/oauth-protected-resource/api/mcp`;
  return Response.json(
    { error: "invalid_token", error_description: "Token ausente, inválido ou expirado." },
    {
      status: 401,
      headers: { "WWW-Authenticate": `Bearer resource_metadata="${metadata}"` },
    },
  );
}

/**
 * /api/mcp: 404 when MCP is off; 401 + WWW-Authenticate without a valid
 * access token; else one stateless Streamable HTTP exchange (JSON responses)
 * with a fresh server bound to the token's identity. Stateless means there is
 * no standalone SSE stream to open (GET) nor session to end (DELETE): both
 * get 405 once authenticated, as in the SDK's stateless examples.
 */
export async function handleMcpRequest(request: Request): Promise<Response> {
  if (!isMcpEnabled()) return notFound();
  const match = BEARER.exec(request.headers.get("authorization") ?? "");
  const identity = match ? await resolveBearer(match[1]) : null;
  if (!identity) return unauthorized(request);

  if (request.method !== "POST") {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
      { status: 405, headers: { Allow: "POST" } },
    );
  }

  const server = createMcpServer(identity);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    // JSON mode: the response body is complete once handleRequest resolves.
    await server.close().catch(() => {});
  }
}
