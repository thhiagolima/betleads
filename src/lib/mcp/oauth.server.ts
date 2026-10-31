// MCP financeiro: minimal OAuth 2.1 authorization server (spec §5).
// Dynamic client registration (public clients only, redirect URIs from an
// allow list), single-use authorization codes with mandatory PKCE S256, and
// opaque access/refresh tokens bound to a connection (user + client). Codes and
// tokens are stored only as sha256Hex; the access level is never in the token
// (resolveBearer reads mcp_access on every call).
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { listFinanceScopesFor } from "@/lib/finance/finance-scopes.server";

import { getMcpLevel } from "./access.server";
import { ACCESS_TOKEN_TTL_S, AUTH_CODE_TTL_S, REFRESH_TOKEN_TTL_S } from "./config.server";
import { randomToken, sha256Hex, verifyPkceS256 } from "./crypto.server";

/* eslint-disable @typescript-eslint/no-explicit-any -- loose client typing, same pattern as access.server.ts. */
const db = () => supabaseAdmin as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** RFC 6749 / RFC 7591 error: `code` is the wire `error`, `message` the description. */
export class OAuthError extends Error {
  code: string;
  constructor(code: string, description?: string) {
    super(description ?? code);
    this.name = "OAuthError";
    this.code = code;
  }
}

export const NO_MCP_ACCESS_MESSAGE = "Seu usuário não tem acesso ao MCP. Peça ao super admin.";

const CLAUDE_CALLBACKS = new Set([
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
]);

/**
 * Allow list for redirect URIs: exactly the claude.ai / claude.com callbacks,
 * or a loopback `http://localhost:<port>/<path>` / `http://127.0.0.1:<port>/<path>`
 * (Claude Code). No user info, no fragment; everything else false.
 */
export function isAllowedRedirectUri(uri: string): boolean {
  if (CLAUDE_CALLBACKS.has(uri)) return true;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return false;
  if (!url.port) return false;
  if (url.username || url.password || url.hash) return false;
  // Reject anything the URL parser had to rewrite (e.g. "localhost:80@evil").
  return uri.startsWith(`http://${url.hostname}:${url.port}/`);
}

/**
 * Who receives the authorization code, derived from the (allow-listed)
 * redirect URI — never from the free-text DCR client_name, which anyone
 * registering a client can set to anything.
 */
export function redirectRecipientLabel(uri: string): string {
  if (CLAUDE_CALLBACKS.has(uri)) return "Claude (claude.ai)";
  return "Claude Code no seu computador";
}

// ---------------------------------------------------------------------------
// Dynamic client registration (RFC 7591)
// ---------------------------------------------------------------------------

/** Max DCR request body (bytes). Real Claude registrations are well under 1 KB. */
export const REGISTER_MAX_BODY_BYTES = 16 * 1024;

/**
 * Reads the DCR body as JSON, refusing (OAuthError) a declared or actual size
 * over REGISTER_MAX_BODY_BYTES — the stream is cut as soon as it passes the cap.
 */
export async function readRegisterBody(request: Request): Promise<unknown> {
  const tooLarge = () =>
    new OAuthError("invalid_client_metadata", "Corpo da requisição grande demais.");
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > REGISTER_MAX_BODY_BYTES) throw tooLarge();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > REGISTER_MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new OAuthError("invalid_client_metadata", "JSON inválido.");
  }
}

const registrationBody = z.object({
  redirect_uris: z.array(z.string().max(2048)).min(1).max(10),
  client_name: z.string().trim().max(200).optional(),
  token_endpoint_auth_method: z.string().optional(),
});

export type RegisteredClient = {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: "none";
};

export async function registerClient(body: unknown): Promise<RegisteredClient> {
  const parsed = registrationBody.safeParse(body);
  if (!parsed.success) {
    throw new OAuthError("invalid_client_metadata", "Metadados do cliente inválidos.");
  }
  const { redirect_uris, token_endpoint_auth_method } = parsed.data;
  if (token_endpoint_auth_method && token_endpoint_auth_method !== "none") {
    throw new OAuthError(
      "invalid_client_metadata",
      "Só clientes públicos (token_endpoint_auth_method none).",
    );
  }
  if (!redirect_uris.every(isAllowedRedirectUri)) {
    throw new OAuthError("invalid_redirect_uri", "Redirect URI não permitido.");
  }
  const client_name = parsed.data.client_name || "Claude";
  const client_id = randomToken(24);
  const { error } = await db()
    .from("mcp_oauth_clients")
    .insert({ id: client_id, client_name, redirect_uris });
  if (error) throw new Error(error.message);
  return { client_id, client_name, redirect_uris, token_endpoint_auth_method: "none" };
}

type ClientRow = { id: string; client_name: string | null; redirect_uris: string[] };

/** The registered client, if `redirectUri` is one of its redirect URIs (and still allowed). */
export async function findClientForRedirect(
  clientId: string,
  redirectUri: string,
): Promise<ClientRow | null> {
  const { data, error } = await db()
    .from("mcp_oauth_clients")
    .select("id, client_name, redirect_uris")
    .eq("id", clientId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as ClientRow | null;
  if (!row || !Array.isArray(row.redirect_uris)) return null;
  if (!row.redirect_uris.includes(redirectUri) || !isAllowedRedirectUri(redirectUri)) return null;
  return row;
}

// ---------------------------------------------------------------------------
// Authorization code
// ---------------------------------------------------------------------------

const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;

export async function issueAuthCode(args: {
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
}): Promise<string> {
  if (args.codeChallengeMethod !== "S256") {
    throw new OAuthError("invalid_request", "PKCE S256 é obrigatório.");
  }
  if (!PKCE_CHALLENGE.test(args.codeChallenge)) {
    throw new OAuthError("invalid_request", "code_challenge inválido.");
  }
  const client = await findClientForRedirect(args.clientId, args.redirectUri);
  if (!client) {
    throw new OAuthError("invalid_request", "Cliente ou redirect URI não registrado.");
  }
  if ((await getMcpLevel(args.userId)) === "none") {
    throw new OAuthError("access_denied", NO_MCP_ACCESS_MESSAGE);
  }
  const code = randomToken(32);
  const { error } = await db()
    .from("mcp_auth_codes")
    .insert({
      code_hash: await sha256Hex(code),
      client_id: client.id,
      user_id: args.userId,
      redirect_uri: args.redirectUri,
      code_challenge: args.codeChallenge,
      expires_at: new Date(Date.now() + AUTH_CODE_TTL_S * 1000).toISOString(),
    });
  if (error) throw new Error(error.message);
  return code;
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

export type TokenResponse = {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
};

const isExpired = (expiresAt: string) => new Date(expiresAt).getTime() <= Date.now();

function required(form: URLSearchParams, name: string): string {
  const value = form.get(name);
  if (!value) throw new OAuthError("invalid_request", `Parâmetro ${name} ausente.`);
  return value;
}

async function issueTokenPair(connectionId: string): Promise<TokenResponse> {
  const access = randomToken(32);
  const refresh = randomToken(32);
  const now = Date.now();
  const { error } = await db()
    .from("mcp_tokens")
    .insert([
      {
        token_hash: await sha256Hex(access),
        connection_id: connectionId,
        kind: "access",
        expires_at: new Date(now + ACCESS_TOKEN_TTL_S * 1000).toISOString(),
      },
      {
        token_hash: await sha256Hex(refresh),
        connection_id: connectionId,
        kind: "refresh",
        expires_at: new Date(now + REFRESH_TOKEN_TTL_S * 1000).toISOString(),
      },
    ]);
  if (error) throw new Error(error.message);
  return {
    access_token: access,
    refresh_token: refresh,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_S,
  };
}

/** Marks a connection revoked (idempotent: a no-op if already revoked). */
export async function revokeConnection(connectionId: string) {
  const { error } = await db()
    .from("mcp_connections")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", connectionId)
    .is("revoked_at", null);
  if (error) throw new Error(error.message);
}

/**
 * Cuts a user off MCP entirely: deletes their `mcp_access` row and revokes
 * every active connection (so their tokens stop resolving at once). Shared by
 * the super admin "Sem acesso" level and user deactivation/deletion.
 */
export async function removeMcpAccessForUser(userId: string): Promise<void> {
  const { error: deleteError } = await db().from("mcp_access").delete().eq("user_id", userId);
  if (deleteError) throw new Error(deleteError.message);
  const { data: conns, error: connError } = await db()
    .from("mcp_connections")
    .select("id")
    .eq("user_id", userId)
    .is("revoked_at", null);
  if (connError) throw new Error(connError.message);
  for (const conn of (conns ?? []) as Array<{ id: string }>) {
    await revokeConnection(conn.id);
  }
}

type CodeRow = {
  code_hash: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  code_challenge: string;
  expires_at: string;
  used_at: string | null;
};

async function exchangeAuthorizationCode(form: URLSearchParams): Promise<TokenResponse> {
  const code = required(form, "code");
  const clientId = required(form, "client_id");
  const redirectUri = required(form, "redirect_uri");
  const verifier = required(form, "code_verifier");

  const codeHash = await sha256Hex(code);
  const { data, error } = await db()
    .from("mcp_auth_codes")
    .select("code_hash, client_id, user_id, redirect_uri, code_challenge, expires_at, used_at")
    .eq("code_hash", codeHash)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as CodeRow | null;
  const invalid = () =>
    new OAuthError("invalid_grant", "Código de autorização inválido ou expirado.");
  if (!row || row.used_at || isExpired(row.expires_at)) throw invalid();
  if (row.client_id !== clientId || row.redirect_uri !== redirectUri) throw invalid();
  if (!(await verifyPkceS256(verifier, row.code_challenge))) throw invalid();

  // Single use: only the request that flips used_at from null wins.
  const { data: claimed, error: claimError } = await db()
    .from("mcp_auth_codes")
    .update({ used_at: new Date().toISOString() })
    .eq("code_hash", codeHash)
    .is("used_at", null)
    .select("code_hash");
  if (claimError) throw new Error(claimError.message);
  if (!Array.isArray(claimed) || claimed.length === 0) throw invalid();

  const { data: conn, error: connError } = await db()
    .from("mcp_connections")
    .insert({ user_id: row.user_id, client_id: row.client_id })
    .select("id")
    .single();
  if (connError || !conn) throw new Error(connError?.message ?? "connection insert failed");
  return issueTokenPair(conn.id as string);
}

type TokenRow = {
  token_hash: string;
  connection_id: string;
  kind: string;
  expires_at: string;
  used_at: string | null;
};

async function exchangeRefreshToken(form: URLSearchParams): Promise<TokenResponse> {
  const refreshToken = required(form, "refresh_token");
  const clientId = form.get("client_id");
  const invalid = () => new OAuthError("invalid_grant", "Refresh token inválido ou expirado.");

  const tokenHash = await sha256Hex(refreshToken);
  const { data, error } = await db()
    .from("mcp_tokens")
    .select("token_hash, connection_id, kind, expires_at, used_at")
    .eq("token_hash", tokenHash)
    .eq("kind", "refresh")
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as TokenRow | null;
  if (!row) throw invalid();

  // Reuse of a rotated refresh token = retry or theft: kill the whole
  // connection, which also invalidates the newer pair (resolveBearer checks
  // revoked_at).
  if (row.used_at) {
    await revokeConnection(row.connection_id);
    throw invalid();
  }
  if (isExpired(row.expires_at)) throw invalid();

  const { data: conn, error: connError } = await db()
    .from("mcp_connections")
    .select("id, client_id, revoked_at")
    .eq("id", row.connection_id)
    .maybeSingle();
  if (connError) throw new Error(connError.message);
  if (!conn || conn.revoked_at) throw invalid();
  if (clientId && conn.client_id !== clientId) throw invalid();

  const { data: claimed, error: claimError } = await db()
    .from("mcp_tokens")
    .update({ used_at: new Date().toISOString() })
    .eq("token_hash", tokenHash)
    .is("used_at", null)
    .select("token_hash");
  if (claimError) throw new Error(claimError.message);
  if (!Array.isArray(claimed) || claimed.length === 0) {
    // Lost a race against a concurrent use of the same refresh token.
    await revokeConnection(row.connection_id);
    throw invalid();
  }
  return issueTokenPair(row.connection_id);
}

export async function exchangeToken(form: URLSearchParams): Promise<TokenResponse> {
  const grantType = form.get("grant_type");
  if (grantType === "authorization_code") return exchangeAuthorizationCode(form);
  if (grantType === "refresh_token") return exchangeRefreshToken(form);
  throw new OAuthError("unsupported_grant_type", "grant_type não suportado.");
}

// ---------------------------------------------------------------------------
// Metadata (RFC 9728 protected resource + RFC 8414 authorization server)
// ---------------------------------------------------------------------------

/** VITE_PUBLIC_APP_URL without a trailing slash, or "" when unset. Request-free: usable outside a request handler. */
export function publicBaseUrlFromEnv(): string {
  return (process.env.VITE_PUBLIC_APP_URL ?? "").trim().replace(/\/+$/, "");
}

export class PublicBaseUrlMissingError extends Error {
  constructor() {
    super("VITE_PUBLIC_APP_URL não configurada em produção.");
    this.name = "PublicBaseUrlMissingError";
  }
}

/**
 * Public base URL: VITE_PUBLIC_APP_URL without trailing slash. Outside
 * production it falls back to the request origin; in production an unset
 * variable fails closed (throws), so the OAuth metadata is never built from a
 * client-controlled Host header.
 */
export function publicBaseUrl(request: Request): string {
  const fromEnv = publicBaseUrlFromEnv();
  if (fromEnv) return fromEnv;
  if (process.env.NODE_ENV === "production") throw new PublicBaseUrlMissingError();
  return new URL(request.url).origin;
}

export function oauthMetadata(request: Request) {
  const base = publicBaseUrl(request);
  return {
    resource: `${base}/api/mcp`,
    issuer: base,
    authorization_servers: [base],
    authorization_endpoint: `${base}/mcp/autorizar`,
    token_endpoint: `${base}/api/mcp/oauth/token`,
    registration_endpoint: `${base}/api/mcp/oauth/register`,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    bearer_methods_supported: ["header"],
  };
}

const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };

/** RFC 6749 §5.2 JSON error body (400), or a 500 for anything unexpected. */
export function oauthErrorResponse(error: unknown): Response {
  if (error instanceof OAuthError) {
    return Response.json(
      { error: error.code, error_description: error.message },
      { status: 400, headers: NO_STORE },
    );
  }
  console.error("[mcp-oauth]", error);
  return Response.json(
    { error: "server_error", error_description: "Erro interno." },
    { status: 500, headers: NO_STORE },
  );
}

export function oauthJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}

// ---------------------------------------------------------------------------
// Consent screen cores (called by oauth.functions.ts with the signed-in user)
// ---------------------------------------------------------------------------

export type McpAuthorizationInfo = {
  /** Who receives the code, from the redirect URI (shown prominently). */
  recipient: string;
  /** Free-text DCR client_name (secondary text only: client-controlled). */
  clientName: string;
  level: "read" | "write";
  scopes: { houses: string[]; groups: string[] };
};

/**
 * What the consent screen shows. Throws (pt-BR message) when the client or
 * redirect URI is not registered/allowed, or the user has no MCP access — the
 * screen then shows the error and no buttons, so Cancelar never redirects to
 * an unvalidated URI.
 */
export async function getMcpAuthorizationInfoFor(
  ctx: { userId: string },
  data: { clientId: string; redirectUri: string },
): Promise<McpAuthorizationInfo> {
  const client = await findClientForRedirect(data.clientId, data.redirectUri);
  if (!client)
    throw new Error("Pedido de conexão inválido: cliente ou endereço de retorno desconhecido.");
  const level = await getMcpLevel(ctx.userId);
  if (level === "none") throw new Error(NO_MCP_ACCESS_MESSAGE);
  const scopes = await listFinanceScopesFor(ctx.userId);
  return {
    recipient: redirectRecipientLabel(data.redirectUri),
    clientName: client.client_name || "Claude",
    level,
    scopes: {
      houses: scopes.houses.map((h) => h.nome),
      groups: scopes.groups.map((g) => g.nome),
    },
  };
}

/** Issues the code and returns the client's redirect URI with `code` and `state`. */
export async function approveMcpAuthorizationFor(
  ctx: { userId: string },
  data: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    state?: string;
  },
): Promise<{ redirectTo: string }> {
  let code: string;
  try {
    code = await issueAuthCode({
      userId: ctx.userId,
      clientId: data.clientId,
      redirectUri: data.redirectUri,
      codeChallenge: data.codeChallenge,
      codeChallengeMethod: data.codeChallengeMethod,
    });
  } catch (error) {
    if (error instanceof OAuthError) throw new Error(error.message);
    throw error;
  }
  const url = new URL(data.redirectUri);
  url.searchParams.set("code", code);
  if (data.state) url.searchParams.set("state", data.state);
  return { redirectTo: url.toString() };
}

/** GET handler body shared by the well-known metadata routes (404 when MCP is off). */
export function wellKnownResponse(request: Request, enabled: boolean): Response {
  if (!enabled) return notFound();
  let metadata: ReturnType<typeof oauthMetadata>;
  try {
    metadata = oauthMetadata(request);
  } catch (error) {
    return oauthErrorResponse(error);
  }
  return Response.json(metadata, {
    headers: { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
  });
}
