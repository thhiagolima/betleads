// MCP do grupo, área de operação: the list of operação tools the server
// registers (spec docs/superpowers/specs/2026-11-17-mcp-grupo-design.md §5).
//
// CONTRACT for the tool files (tools-visao / tools-experts / tools-campanhas):
// each exports an array of `OpsToolDef` and nothing here needs to change when
// a tool is added. The server (../server.server.ts) does the rest for every
// entry: registers it only when the identity has the `operacao` area, with
// `readOnlyHint: true`; and on each call runs rate limit → assertArea
// ("operacao") → `run` → `assertSemDadosPessoais(result)` → mcp_call_log row
// (args, scope) → result. A thrown Error's message goes back to Claude as is
// (pt-BR); anything else is "Erro interno.".
//
// What a tool's `run` must do:
// - parse its args with its own `inputSchema` (the SDK already validated
//   them, but `run` is also called directly by tests);
// - call `resolverEscopoOps(identity.userId, escopo)` (./scope.server) FIRST
//   and only query the houses it returns — it is the only permission gate;
// - use ./runner.server (`porCasa`, `totaisPorMoeda`, `toRange`, `truncar`,
//   `escopoOps`, `periodoOps`, `limiteInput`) for the common format
//   `{ rotulo, periodo, casas, totais_por_moeda, casas_com_erro }`;
// - return only aggregates: no telefone/email/cpf/player_id/nome_jogador key.
//
// `scopeOf(args)` is optional: by default the log scope is `args.escopo`
// (or `{tipo: "casa", id: args.casa}`), and `casas` in the logged scope is
// the length of the result's `casas` array plus `casas_com_erro`.
import type { z } from "zod";

import type { McpIdentity } from "../access.server";
import { CAMPANHAS_TOOLS } from "./tools-campanhas.server";
import { EXPERTS_TOOLS } from "./tools-experts.server";
import { VISAO_TOOLS } from "./tools-visao.server";

/** Scope written to mcp_call_log.scope. */
export type OpsLogScope = { tipo: string; id?: string | null };

export type OpsToolDef = {
  /** Tool name, snake_case pt-BR (e.g. "visao_geral"). */
  name: string;
  title: string;
  /** What Claude reads to pick the tool: inputs, output, units (pt-BR). */
  description: string;
  inputSchema: z.ZodObject;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any -- each tool narrows its own args via inputSchema */
  run(identity: McpIdentity, args: any): Promise<unknown>;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any -- same args as run */
  scopeOf?(args: any): OpsLogScope | null;
};

export const OPS_TOOLS: OpsToolDef[] = [...VISAO_TOOLS, ...EXPERTS_TOOLS, ...CAMPANHAS_TOOLS];
