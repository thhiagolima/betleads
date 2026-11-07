import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "@/lib/sms-bulk.test-support";

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.db = createFakeDb();
  return { supabaseAdmin: fake.db.client };
});

import {
  OWN_A,
  OWN_B,
  PLATFORM_ACCOUNT,
  lastCallbackAt,
  seedCallbackAccounts,
} from "@/lib/provider-callback-tokens.test-support";
import { Route } from "./events";

type PostHandler = (input: { request: Request }) => Promise<Response>;
const post = (Route as unknown as { options: { server: { handlers: { POST: PostHandler } } } })
  .options.server.handlers.POST;

function send(token: string | null, correlation: string) {
  const url = new URL("https://betleads.io/api/public/infobip/email/events");
  if (token) url.searchParams.set("token", token);
  url.searchParams.set("correlation", correlation);
  return post({
    request: new Request(url, {
      method: "POST",
      body: JSON.stringify({
        results: [{ callbackData: correlation, status: { groupName: "DELIVERED" } }],
      }),
    }),
  });
}

const status = (id: string) => fake.db.rows("email_send_logs").find((row) => row.id === id)?.status;

let tokens: { tokenA: string; tokenB: string };

beforeEach(async () => {
  vi.stubEnv("PROVIDER_CREDENTIALS_ENCRYPTION_KEY", "k".repeat(40));
  vi.stubEnv("INFOBIP_EMAIL_CALLBACK_TOKEN", "global-email-token");
  fake.db.reset();
  tokens = await seedCallbackAccounts(fake.db);
  const row = (id: string, key: string, accountId: string | null) => ({
    id,
    status: "sent",
    provider_account_id: accountId,
    provider_response: { idempotency_key: key },
  });
  fake.db
    .rows("email_send_logs")
    .push(
      row("mail-a", "key-a", OWN_A),
      row("mail-b", "key-b", OWN_B),
      row("mail-p", "key-p", PLATFORM_ACCOUNT),
      row("mail-l", "key-l", null),
    );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Infobip e-mail events route: callback scope", () => {
  it("unknown or forged tokens stay 401", async () => {
    expect((await send(null, "key-p")).status).toBe(401);
    expect((await send("wrong", "key-p")).status).toBe(401);
    expect((await send(`${tokens.tokenA.slice(0, -2)}xx`, "key-a")).status).toBe(401);
  });

  it("(a) global token + owned account's e-mail -> 200, not applied", async () => {
    const response = await send("global-email-token", "key-a");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, matched: 0 });
    expect(status("mail-a")).toBe("sent");
  });

  it("(b) account A's token + account B's (or a platform) e-mail -> 200, not applied", async () => {
    for (const key of ["key-b", "key-p", "key-l"]) {
      const response = await send(tokens.tokenA, key);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ matched: 0 });
    }
    expect(status("mail-b")).toBe("sent");
    expect(status("mail-p")).toBe("sent");
    expect(status("mail-l")).toBe("sent");
  });

  it("(c) account A's token + account A's e-mail -> applied, last_callback_at touched", async () => {
    expect(await (await send(tokens.tokenA, "key-a")).json()).toMatchObject({ matched: 1 });
    expect(status("mail-a")).toBe("delivered");
    expect(lastCallbackAt(fake.db, OWN_A)).toEqual(expect.any(String));
  });

  it("(d) global token + platform / legacy e-mail -> applied as today", async () => {
    expect(await (await send("global-email-token", "key-p")).json()).toMatchObject({ matched: 1 });
    expect(await (await send("global-email-token", "key-l")).json()).toMatchObject({ matched: 1 });
    expect(status("mail-p")).toBe("delivered");
    expect(status("mail-l")).toBe("delivered");
  });
});
