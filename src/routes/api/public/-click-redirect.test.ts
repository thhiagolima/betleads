import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  insertError: null as null | { code?: string; message: string },
  inserted: [] as Record<string, unknown>[],
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("@/integrations/supabase/client.server", () => {
  const from = (table: string) => {
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      gte: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({
        data:
          table === "link_dispatches"
            ? {
                id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                tenant_id: "tttttttt-tttt-4ttt-8ttt-tttttttttttt",
                tracking_token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                recipient_player_id: "pppppppp-pppp-4ppp-8ppp-pppppppppppp",
                source_type: "journey",
                source_id: "j1",
                original_url: "https://casino.example/landing",
                sent_at: new Date(Date.now() - 60_000).toISOString(),
              }
            : null,
        error: null,
      }),
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve),
      insert: async (row: Record<string, unknown>) => {
        state.inserted.push(row);
        return { error: state.insertError };
      },
    };
    return chain;
  };
  return { supabaseAdmin: { from } };
});

import { resetClickLimitersForTests, signClickToken } from "@/lib/click-tracking.server";
import { Route } from "./click.$token";

type Handler = (input: { request: Request; params: { token: string } }) => Promise<Response>;
const handlers = (
  Route as unknown as { options: { server: { handlers: Record<string, Handler> } } }
).options.server.handlers;

const token = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secret = "test-secret-that-is-longer-than-thirty-two-characters";
const previousSecret = process.env.CLICK_TRACKING_SECRET;

async function call(method: "GET" | "HEAD", headers: Record<string, string>, sig?: string) {
  const signature = sig ?? (await signClickToken(token, secret));
  const request = new Request(`https://app.example.test/api/public/click/${token}?s=${signature}`, {
    method,
    headers,
  });
  return handlers[method]({ request, params: { token } });
}

describe("click redirect route (TRK-06)", () => {
  beforeEach(() => {
    process.env.CLICK_TRACKING_SECRET = secret;
    state.insertError = null;
    state.inserted = [];
    resetClickLimitersForTests();
  });

  afterEach(() => {
    if (previousSecret === undefined) delete process.env.CLICK_TRACKING_SECRET;
    else process.env.CLICK_TRACKING_SECRET = previousSecret;
    vi.restoreAllMocks();
  });

  it.each([
    ["human browser", { "user-agent": "Mozilla/5.0 Chrome/141", "accept-language": "pt-BR" }],
    ["no user agent", {}],
    ["link preview", { "user-agent": "WhatsApp/2.24" }],
    ["security scanner", { "user-agent": "Mimecast-Url-Protect/1.0" }],
  ])("always 302s to the destination for a %s", async (_label, headers) => {
    const response = await call("GET", headers);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://casino.example/landing");
  });

  it("records only the human request as human", async () => {
    await call("GET", { "user-agent": "Mozilla/5.0 Chrome/141", "accept-language": "pt-BR" });
    await call("GET", { "user-agent": "WhatsApp/2.24", "x-forwarded-for": "198.51.100.1" });
    expect(state.inserted.map((row) => row.is_human)).toEqual([true, false]);
  });

  it("still redirects when persisting the click fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    state.insertError = { message: "db down" };
    const response = await call("GET", { "user-agent": "Mozilla/5.0", "accept-language": "pt" });
    expect(response.status).toBe(302);
    expect(response.headers.get("x-betleads-tracking")).toBe("degraded");
  });

  it("keeps redirecting a flooded token without recording beyond the limit", async () => {
    const statuses: number[] = [];
    for (let index = 0; index < 30; index++) {
      const response = await call("GET", {
        "user-agent": "Mozilla/5.0 Chrome/141",
        "accept-language": "pt-BR",
        "x-forwarded-for": `203.0.113.${index + 1}`,
      });
      statuses.push(response.status);
    }
    expect(new Set(statuses)).toEqual(new Set([302]));
    expect(state.inserted.length).toBe(20);
  });

  it("answers HEAD without recording a click", async () => {
    const response = await call("HEAD", { "user-agent": "Mozilla/5.0" });
    expect(response.status).toBe(204);
    expect(state.inserted).toHaveLength(0);
  });

  it("returns 404 for a forged signature", async () => {
    const response = await call("GET", { "user-agent": "Mozilla/5.0" }, "forged");
    expect(response.status).toBe(404);
  });
});
