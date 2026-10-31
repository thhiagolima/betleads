// MCP financeiro, Task 7: server-side preview and single-use confirmation of
// the write actions (write-actions.server.ts). Spec:
// docs/superpowers/specs/2026-10-30-mcp-financeiro-design.md §7.
//
// createPreview validates, checks permission/house state, reads the "before"
// snapshot and stores the parsed input + snapshot under the SHA-256 of a
// random code (the code itself is never stored). confirmPreview re-checks
// everything, refuses if the snapshot changed, then applies the STORED input
// through the action's `*For` core — never new data from the client.
//
// Single use / retries (Review Focus 2): confirmed_at is set with a
// conditional update (`confirmed_at is null`) BEFORE apply, so of two
// concurrent confirms only one applies; the other gets `ja_confirmada`.
// A code already confirmed returns its stored result with `ja_confirmada`,
// even after the 10 min window (a retry after a network error must not look
// like "not applied"). If apply throws after the mark, the code stays spent
// and `{ erro }` is stored as its result: a retry throws "já foi usada e
// falhou" instead of re-applying a possibly partial write; the user generates
// a new preview, whose snapshot then shows the current values. If the process
// dies between the mark and storing the result, a retry returns
// `ja_confirmada` with `resultado: null`.
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { requirePermission } from "@/lib/finance/finance-data.server";
import { assertTenantNotDemo } from "@/lib/tenant-access.server";

import { getMcpLevel, type McpIdentity } from "./access.server";
import { PREVIEW_TTL_S } from "./config.server";
import { randomToken, sha256Hex } from "./crypto.server";
import {
  WRITE_ACTIONS,
  isWriteActionName,
  type WriteAction,
  type WriteActionName,
} from "./write-actions.server";
import { assertMcpCanWrite } from "./write-gate.server";

/* eslint-disable @typescript-eslint/no-explicit-any -- loose client typing, same pattern as access.server.ts's db(). */
const db = () => supabaseAdmin as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const READ_ONLY = "Seu acesso ao MCP é só leitura.";
const REVOKED = "Seu acesso ao MCP foi revogado.";
const INVALID_CODE = "Código de confirmação inválido.";
const EXPIRED_CODE = "Código de confirmação expirado. Gere uma nova prévia.";
const CHANGED = "Os valores mudaram desde a prévia. Gere uma nova.";

type PreviewRow = {
  code_hash: string;
  user_id: string;
  connection_id: string;
  action: string;
  tenant_id: string;
  input: Json;
  snapshot: Json;
  expires_at: string;
  confirmed_at: string | null;
  result: Json | null;
};

export type PreviewResult = {
  codigo_confirmacao: string;
  expira_em: string;
  linhas: string[];
  avisos: string[];
};

export type ConfirmResult = { ok: true; resultado: unknown; ja_confirmada?: true };

const ptBrErrors = z.locales.pt().localeError;

/** Parses with the action's schema; errors come back in pt-BR, one per issue. */
function parseInput<I>(action: WriteAction<I>, raw: unknown): I & { tenantId: string } {
  const parsed = action.schema.safeParse(raw, { error: ptBrErrors });
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) =>
        issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
      )
      .join("; ");
    throw new Error(`Entrada inválida: ${detail}`);
  }
  return parsed.data as I & { tenantId: string };
}

async function houseName(tenantId: string): Promise<string> {
  const { data, error } = await db()
    .from("tenants")
    .select("nome")
    .eq("id", tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Casa não encontrada");
  return data.nome;
}

/** Deep equality that ignores object key order (jsonb reorders keys). */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((value, index) => sameJson(value, other[index]));
  }
  const left = Object.entries(a as Record<string, unknown>).filter(([, v]) => v !== undefined);
  const right = Object.entries(b as Record<string, unknown>).filter(([, v]) => v !== undefined);
  if (left.length !== right.length) return false;
  const rightMap = new Map(right);
  return left.every(([key, value]) => rightMap.has(key) && sameJson(value, rightMap.get(key)));
}

/** Errors stored as a spent code's result (see the header). */
const isStoredError = (result: unknown): result is { erro: string } =>
  typeof result === "object" &&
  result !== null &&
  typeof (result as { erro?: unknown }).erro === "string";

export async function createPreview(
  identity: McpIdentity,
  actionName: WriteActionName,
  rawInput: unknown,
): Promise<PreviewResult> {
  if (identity.level !== "write") throw new Error(READ_ONLY);
  if (!isWriteActionName(actionName)) throw new Error("Ação desconhecida");
  const action = WRITE_ACTIONS[actionName];

  const input = parseInput(action, rawInput);
  await requirePermission(action.permission, identity.userId, input.tenantId);
  await assertTenantNotDemo(input.tenantId);
  await assertMcpCanWrite(input.tenantId, identity.userId);

  const snapshot = await action.snapshot(input.tenantId, input);
  const { linhas, avisos } = action.describe(snapshot, input, await houseName(input.tenantId));

  const code = randomToken(24);
  const expiresAt = new Date(Date.now() + PREVIEW_TTL_S * 1000).toISOString();
  const { error } = await db()
    .from("mcp_previews")
    .insert({
      code_hash: await sha256Hex(code),
      user_id: identity.userId,
      connection_id: identity.connectionId,
      action: actionName,
      tenant_id: input.tenantId,
      input: input as unknown as Json,
      snapshot,
      expires_at: expiresAt,
    });
  if (error) throw new Error(error.message);

  return { codigo_confirmacao: code, expira_em: expiresAt, linhas, avisos };
}

function alreadyConfirmed(row: PreviewRow): ConfirmResult {
  if (isStoredError(row.result)) {
    throw new Error(`Esta prévia já foi usada e falhou: ${row.result.erro}. Gere uma nova.`);
  }
  return { ok: true, resultado: row.result, ja_confirmada: true };
}

async function readPreview(codeHash: string, identity: McpIdentity) {
  const { data, error } = await db()
    .from("mcp_previews")
    .select(
      "code_hash,user_id,connection_id,action,tenant_id,input,snapshot,expires_at,confirmed_at,result",
    )
    .eq("code_hash", codeHash)
    .eq("user_id", identity.userId)
    .eq("connection_id", identity.connectionId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as PreviewRow | null) ?? null;
}

export async function confirmPreview(identity: McpIdentity, code: string): Promise<ConfirmResult> {
  const codeHash = await sha256Hex(code);
  const row = await readPreview(codeHash, identity);
  if (!row || !isWriteActionName(row.action)) throw new Error(INVALID_CODE);
  if (row.confirmed_at) return alreadyConfirmed(row);
  if (Date.parse(row.expires_at) <= Date.now()) throw new Error(EXPIRED_CODE);

  if (identity.level !== "write") throw new Error(READ_ONLY);
  const level = await getMcpLevel(identity.userId);
  if (level === "none") throw new Error(REVOKED);
  if (level !== "write") throw new Error(READ_ONLY);

  const action = WRITE_ACTIONS[row.action];
  const input = parseInput(action, row.input);
  if (input.tenantId !== row.tenant_id) throw new Error(INVALID_CODE);
  await requirePermission(action.permission, identity.userId, row.tenant_id);
  await assertMcpCanWrite(row.tenant_id, identity.userId);

  const current = await action.snapshot(row.tenant_id, input);
  if (!sameJson(current, row.snapshot)) throw new Error(CHANGED);

  // Single use: only the caller whose conditional update hits the row applies.
  const { data: marked, error: markError } = await db()
    .from("mcp_previews")
    .update({ confirmed_at: new Date().toISOString() })
    .eq("code_hash", codeHash)
    .is("confirmed_at", null)
    .select("code_hash");
  if (markError) throw new Error(markError.message);
  if (!marked?.length) {
    const latest = await readPreview(codeHash, identity);
    if (!latest) throw new Error(INVALID_CODE);
    return alreadyConfirmed(latest);
  }

  let resultado: unknown;
  try {
    resultado = await action.apply(
      {
        userId: identity.userId,
        auditMetadata: {
          origem: "mcp",
          connectionId: identity.connectionId,
          clientId: identity.clientId,
          previewCode: codeHash,
        },
      },
      input,
    );
  } catch (applyError) {
    const message = applyError instanceof Error ? applyError.message : String(applyError);
    await storeResult(codeHash, { erro: message });
    throw applyError;
  }
  await storeResult(codeHash, (resultado ?? null) as Json);
  return { ok: true, resultado };
}

async function storeResult(codeHash: string, result: Json) {
  const { error } = await db().from("mcp_previews").update({ result }).eq("code_hash", codeHash);
  if (error) console.warn("[mcp] failed storing preview result", error.message);
}
