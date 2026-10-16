// F0-06 (SEC-13): the Evolution webhook only accepts EVOLUTION_WEBHOOK_SECRET
// sent in a header. No fallback to EVOLUTION_API_KEY, no ?token= query.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/lib/precall-dispatcher.server", () => ({ detectPrecallResponse: vi.fn() }));

import { Route } from "./evolution-webhook";

type Handler = (input: { request: Request }) => Promise<Response>;
const POST = (Route as unknown as { options: { server: { handlers: Record<string, Handler> } } })
  .options.server.handlers.POST;

const SECRET = "whsec-test-0123456789abcdef";
const GLOBAL_KEY = "evo-global-key";
const URL_BASE = "https://app.example.com/api/public/evolution-webhook";
// An event the handler ignores, so authorized requests answer 200 without DB.
const body = JSON.stringify({ event: "presence.update", instance: "casa-a" });

function post(url: string, headers: Record<string, string> = {}) {
  return POST({
    request: new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }),
  });
}

beforeEach(() => {
  vi.stubEnv("EVOLUTION_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("EVOLUTION_API_KEY", GLOBAL_KEY);
});
afterEach(() => vi.unstubAllEnvs());

describe("evolution webhook authentication", () => {
  it("accepts the secret in the x-webhook-secret header", async () => {
    expect((await post(URL_BASE, { "x-webhook-secret": SECRET })).status).toBe(200);
  });

  it("accepts the secret as a Bearer token", async () => {
    expect((await post(URL_BASE, { authorization: `Bearer ${SECRET}` })).status).toBe(200);
  });

  it("refuses the legacy ?token= query parameter", async () => {
    expect((await post(`${URL_BASE}?token=${SECRET}`)).status).toBe(401);
  });

  it("refuses the global EVOLUTION_API_KEY as a webhook credential", async () => {
    expect((await post(URL_BASE, { "x-webhook-secret": GLOBAL_KEY })).status).toBe(401);
  });

  it("refuses everything when EVOLUTION_WEBHOOK_SECRET is unset, even the API key", async () => {
    vi.stubEnv("EVOLUTION_WEBHOOK_SECRET", "");
    expect((await post(URL_BASE, { "x-webhook-secret": GLOBAL_KEY })).status).toBe(401);
    expect((await post(URL_BASE, { "x-webhook-secret": "" })).status).toBe(401);
  });

  it("refuses a wrong secret", async () => {
    expect((await post(URL_BASE, { "x-webhook-secret": "nope" })).status).toBe(401);
  });
});
