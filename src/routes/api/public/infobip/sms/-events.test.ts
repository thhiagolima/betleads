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

const delivered = (messageId: string) => ({
  messageId,
  callbackData: messageId,
  status: { groupId: 3, groupName: "DELIVERED" },
});

function send(token: string | null, messageId: string) {
  const url = new URL("https://betleads.io/api/public/infobip/sms/events");
  if (token) url.searchParams.set("token", token);
  return post({
    request: new Request(url, {
      method: "POST",
      body: JSON.stringify({ results: [delivered(messageId)] }),
    }),
  });
}

const status = (id: string) =>
  fake.db.rows("sms_send_logs").find((row) => row.id === id)?.delivery_status;

let tokens: { tokenA: string; tokenB: string };

beforeEach(async () => {
  vi.stubEnv("PROVIDER_CREDENTIALS_ENCRYPTION_KEY", "k".repeat(40));
  vi.stubEnv("INFOBIP_SMS_CALLBACK_TOKEN", "global-sms-token");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  fake.db.reset();
  tokens = await seedCallbackAccounts(fake.db);
  fake.db
    .rows("sms_send_logs")
    .push(
      {
        id: "log-a",
        provider_message_id: "key-a",
        provider_account_id: OWN_A,
        delivery_status: "sent",
      },
      {
        id: "log-b",
        provider_message_id: "key-b",
        provider_account_id: OWN_B,
        delivery_status: "sent",
      },
      {
        id: "log-p",
        provider_message_id: "key-p",
        provider_account_id: PLATFORM_ACCOUNT,
        delivery_status: "sent",
      },
      {
        id: "log-legacy",
        provider_message_id: "key-l",
        provider_account_id: null,
        delivery_status: "sent",
      },
    );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Infobip SMS delivery-report route: callback scope", () => {
  it("unknown or forged tokens stay 401", async () => {
    expect((await send(null, "key-p")).status).toBe(401);
    expect((await send("wrong", "key-p")).status).toBe(401);
    expect((await send(`${tokens.tokenA.slice(0, -2)}xx`, "key-a")).status).toBe(401);
    expect(status("log-a")).toBe("sent");
  });

  it("(a) global token + owned account's message -> 200, not applied", async () => {
    const response = await send("global-sms-token", "key-a");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, matched: 0, ignored: 1 });
    expect(status("log-a")).toBe("sent");
  });

  it("(b) account A's token + account B's (or a platform) message -> 200, not applied", async () => {
    for (const key of ["key-b", "key-p", "key-l"]) {
      const response = await send(tokens.tokenA, key);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ matched: 0, ignored: 1 });
    }
    expect(status("log-b")).toBe("sent");
    expect(status("log-p")).toBe("sent");
    expect(status("log-legacy")).toBe("sent");
  });

  it("(c) account A's token + account A's message -> applied, last_callback_at touched", async () => {
    const response = await send(tokens.tokenA, "key-a");
    expect(await response.json()).toMatchObject({ ok: true, matched: 1, ignored: 0 });
    expect(status("log-a")).toBe("delivered");
    expect(lastCallbackAt(fake.db, OWN_A)).toEqual(expect.any(String));
    expect(lastCallbackAt(fake.db, OWN_B)).toBeNull();
  });

  it("(d) global token + platform / legacy message -> applied as today", async () => {
    expect(await (await send("global-sms-token", "key-p")).json()).toMatchObject({ matched: 1 });
    expect(await (await send("global-sms-token", "key-l")).json()).toMatchObject({ matched: 1 });
    expect(status("log-p")).toBe("delivered");
    expect(status("log-legacy")).toBe("delivered");
    expect(lastCallbackAt(fake.db, PLATFORM_ACCOUNT)).toBeNull();
  });
});
