// OAuth server (Task 3). Uses the in-memory createFakeDb stand-in for
// supabaseAdmin, same pattern as access.server.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("../sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

vi.mock("@/lib/finance/finance-scopes.server", () => ({
  listFinanceScopesFor: vi.fn(async () => ({
    superAdmin: false,
    houses: [{ id: "h1", nome: "Casa Um", isDemo: false, status: "active" }],
    groups: [{ id: "g1", nome: "Grupo A", isDemo: false }],
  })),
}));

import { resolveBearer } from "./access.server";
import { randomToken } from "./crypto.server";
import {
  OAuthError,
  approveMcpAuthorizationFor,
  exchangeToken,
  getMcpAuthorizationInfoFor,
  isAllowedRedirectUri,
  issueAuthCode,
  registerClient,
} from "./oauth.server";
import { createFakeDb } from "../sms-bulk.test-support";

const USER = "00000000-0000-4000-8000-000000000001";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

async function s256(verifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  let binary = "";
  for (const b of new Uint8Array(digest)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function expectOAuthError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OAuthError);
  expect((error as OAuthError).code).toBe(code);
  return error as OAuthError;
}

async function setup() {
  const client = await registerClient({ client_name: "Claude", redirect_uris: [REDIRECT] });
  const verifier = randomToken(48);
  const code = await issueAuthCode({
    userId: USER,
    clientId: client.client_id,
    redirectUri: REDIRECT,
    codeChallenge: await s256(verifier),
    codeChallengeMethod: "S256",
  });
  return { client, verifier, code };
}

function codeForm(args: {
  code: string;
  clientId: string;
  verifier: string;
  redirectUri?: string;
}) {
  return new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    client_id: args.clientId,
    redirect_uri: args.redirectUri ?? REDIRECT,
    code_verifier: args.verifier,
  });
}

function refreshForm(refreshToken: string, clientId: string) {
  return new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
}

beforeEach(() => {
  fake.admin.reset();
  fake.admin.rows("mcp_access").push({ user_id: USER, level: "read" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isAllowedRedirectUri", () => {
  it("accepts the claude.ai and claude.com callbacks", () => {
    expect(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isAllowedRedirectUri("https://claude.com/api/mcp/auth_callback")).toBe(true);
  });

  it("accepts localhost and 127.0.0.1 with a port", () => {
    expect(isAllowedRedirectUri("http://localhost:33418/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:5000/oauth/callback")).toBe(true);
  });

  it("refuses everything else", () => {
    expect(isAllowedRedirectUri("https://evil.com/api/mcp/auth_callback")).toBe(false);
    expect(isAllowedRedirectUri("https://claude.ai.evil.com/api/mcp/auth_callback")).toBe(false);
    expect(isAllowedRedirectUri("http://localhost.evil.com/")).toBe(false);
    expect(isAllowedRedirectUri("http://claude.ai/api/mcp/auth_callback")).toBe(false);
    expect(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback?x=1")).toBe(false);
    expect(isAllowedRedirectUri("http://localhost:80@evil.com/callback")).toBe(false);
    expect(isAllowedRedirectUri("http://user@localhost:33418/callback")).toBe(false);
    expect(isAllowedRedirectUri("not a url")).toBe(false);
  });
});

describe("registerClient", () => {
  it("refuses a redirect URI outside the allow list", async () => {
    await expectOAuthError(
      registerClient({ client_name: "x", redirect_uris: [REDIRECT, "https://evil.com/cb"] }),
      "invalid_redirect_uri",
    );
    expect(fake.admin.rows("mcp_oauth_clients")).toHaveLength(0);
  });

  it("stores the client and answers as a public client", async () => {
    const client = await registerClient({ client_name: "Claude", redirect_uris: [REDIRECT] });
    expect(client.client_id).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(client).toMatchObject({
      client_name: "Claude",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
    });
    expect(fake.admin.rows("mcp_oauth_clients")[0]).toMatchObject({ id: client.client_id });
  });
});

describe("authorization code flow", () => {
  it("register → code → tokens that resolve via resolveBearer", async () => {
    const { client, verifier, code } = await setup();
    const tokens = await exchangeToken(codeForm({ code, clientId: client.client_id, verifier }));

    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.refresh_token).toBeTruthy();
    const identity = await resolveBearer(tokens.access_token);
    expect(identity).toMatchObject({ userId: USER, clientId: client.client_id, level: "read" });

    // Only hashes are stored.
    const stored = fake.admin.rows("mcp_tokens").map((r) => r.token_hash);
    expect(stored).not.toContain(tokens.access_token);
    expect(stored).not.toContain(tokens.refresh_token);
    expect(fake.admin.rows("mcp_auth_codes").map((r) => r.code_hash)).not.toContain(code);
  });

  it("wrong code_verifier → invalid_grant", async () => {
    const { client, code } = await setup();
    await expectOAuthError(
      exchangeToken(codeForm({ code, clientId: client.client_id, verifier: randomToken(48) })),
      "invalid_grant",
    );
  });

  it("code reused → invalid_grant", async () => {
    const { client, verifier, code } = await setup();
    await exchangeToken(codeForm({ code, clientId: client.client_id, verifier }));
    await expectOAuthError(
      exchangeToken(codeForm({ code, clientId: client.client_id, verifier })),
      "invalid_grant",
    );
  });

  it("code after 10 minutes → invalid_grant", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-30T12:00:00Z"));
    const { client, verifier, code } = await setup();
    vi.setSystemTime(new Date("2026-10-30T12:10:01Z"));
    await expectOAuthError(
      exchangeToken(codeForm({ code, clientId: client.client_id, verifier })),
      "invalid_grant",
    );
  });

  it("different redirect_uri at exchange → invalid_grant", async () => {
    const { client, verifier, code } = await setup();
    await expectOAuthError(
      exchangeToken(
        codeForm({
          code,
          clientId: client.client_id,
          verifier,
          redirectUri: "https://claude.com/api/mcp/auth_callback",
        }),
      ),
      "invalid_grant",
    );
  });

  it("different client_id at exchange → invalid_grant", async () => {
    const { verifier, code } = await setup();
    const other = await registerClient({ client_name: "Outro", redirect_uris: [REDIRECT] });
    await expectOAuthError(
      exchangeToken(codeForm({ code, clientId: other.client_id, verifier })),
      "invalid_grant",
    );
  });

  it("codeChallengeMethod plain → refused", async () => {
    const client = await registerClient({ client_name: "Claude", redirect_uris: [REDIRECT] });
    await expectOAuthError(
      issueAuthCode({
        userId: USER,
        clientId: client.client_id,
        redirectUri: REDIRECT,
        codeChallenge: randomToken(32),
        codeChallengeMethod: "plain",
      }),
      "invalid_request",
    );
    expect(fake.admin.rows("mcp_auth_codes")).toHaveLength(0);
  });

  it("redirect URI not registered for the client → refused", async () => {
    const client = await registerClient({ client_name: "Claude", redirect_uris: [REDIRECT] });
    await expectOAuthError(
      issueAuthCode({
        userId: USER,
        clientId: client.client_id,
        redirectUri: "http://localhost:33418/callback",
        codeChallenge: randomToken(32),
        codeChallengeMethod: "S256",
      }),
      "invalid_request",
    );
  });

  it("user without mcp_access → access_denied", async () => {
    fake.admin.rows("mcp_access").length = 0;
    const client = await registerClient({ client_name: "Claude", redirect_uris: [REDIRECT] });
    const error = await expectOAuthError(
      issueAuthCode({
        userId: USER,
        clientId: client.client_id,
        redirectUri: REDIRECT,
        codeChallenge: randomToken(32),
        codeChallengeMethod: "S256",
      }),
      "access_denied",
    );
    expect(error.message).toBe("Seu usuário não tem acesso ao MCP. Peça ao super admin.");
  });

  it("unknown grant_type → unsupported_grant_type", async () => {
    await expectOAuthError(
      exchangeToken(new URLSearchParams({ grant_type: "password" })),
      "unsupported_grant_type",
    );
  });
});

describe("refresh token rotation", () => {
  it("new pair works; old refresh reused → invalid_grant and the connection is revoked", async () => {
    const { client, verifier, code } = await setup();
    const first = await exchangeToken(codeForm({ code, clientId: client.client_id, verifier }));

    const second = await exchangeToken(refreshForm(first.refresh_token, client.client_id));
    expect(second.access_token).not.toBe(first.access_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(await resolveBearer(second.access_token)).toMatchObject({ userId: USER });

    await expectOAuthError(
      exchangeToken(refreshForm(first.refresh_token, client.client_id)),
      "invalid_grant",
    );
    expect(await resolveBearer(second.access_token)).toBeNull();
    expect(fake.admin.rows("mcp_connections")[0].revoked_at).not.toBeNull();
    // The newer refresh token is dead too.
    await expectOAuthError(
      exchangeToken(refreshForm(second.refresh_token, client.client_id)),
      "invalid_grant",
    );
  });

  it("expired refresh token → invalid_grant", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    const { client, verifier, code } = await setup();
    const first = await exchangeToken(codeForm({ code, clientId: client.client_id, verifier }));
    vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
    await expectOAuthError(
      exchangeToken(refreshForm(first.refresh_token, client.client_id)),
      "invalid_grant",
    );
  });

  it("an access token presented as refresh → invalid_grant", async () => {
    const { client, verifier, code } = await setup();
    const first = await exchangeToken(codeForm({ code, clientId: client.client_id, verifier }));
    await expectOAuthError(
      exchangeToken(refreshForm(first.access_token, client.client_id)),
      "invalid_grant",
    );
  });
});

describe("consent screen cores", () => {
  it("getMcpAuthorizationInfoFor returns client name, level and scope names", async () => {
    const client = await registerClient({ client_name: "Claude", redirect_uris: [REDIRECT] });
    const info = await getMcpAuthorizationInfoFor(
      { userId: USER },
      { clientId: client.client_id, redirectUri: REDIRECT },
    );
    expect(info).toEqual({
      clientName: "Claude",
      level: "read",
      scopes: { houses: ["Casa Um"], groups: ["Grupo A"] },
    });
  });

  it("getMcpAuthorizationInfoFor refuses an unregistered redirect URI", async () => {
    const client = await registerClient({ client_name: "Claude", redirect_uris: [REDIRECT] });
    await expect(
      getMcpAuthorizationInfoFor(
        { userId: USER },
        { clientId: client.client_id, redirectUri: "http://localhost:1/x" },
      ),
    ).rejects.toThrow(/inválido/);
  });

  it("getMcpAuthorizationInfoFor refuses a user without access", async () => {
    fake.admin.rows("mcp_access").length = 0;
    const client = await registerClient({ client_name: "Claude", redirect_uris: [REDIRECT] });
    await expect(
      getMcpAuthorizationInfoFor(
        { userId: USER },
        { clientId: client.client_id, redirectUri: REDIRECT },
      ),
    ).rejects.toThrow("Seu usuário não tem acesso ao MCP. Peça ao super admin.");
  });

  it("approveMcpAuthorizationFor redirects with code and state, and the code works", async () => {
    const client = await registerClient({ client_name: "Claude", redirect_uris: [REDIRECT] });
    const verifier = randomToken(48);
    const { redirectTo } = await approveMcpAuthorizationFor(
      { userId: USER },
      {
        clientId: client.client_id,
        redirectUri: REDIRECT,
        codeChallenge: await s256(verifier),
        codeChallengeMethod: "S256",
        state: "st-123",
      },
    );
    const url = new URL(redirectTo);
    expect(`${url.origin}${url.pathname}`).toBe(REDIRECT);
    expect(url.searchParams.get("state")).toBe("st-123");
    const code = url.searchParams.get("code")!;
    const tokens = await exchangeToken(codeForm({ code, clientId: client.client_id, verifier }));
    expect(await resolveBearer(tokens.access_token)).not.toBeNull();
  });
});
