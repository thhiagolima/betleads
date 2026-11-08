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
import { Route } from "./sms-webhook";

type Handler = (input: { request: Request }) => Promise<Response>;
const get = (Route as unknown as { options: { server: { handlers: { GET: Handler } } } }).options
  .server.handlers.GET;

/** Short Brasil single callback (GET), by message id or by our delivery key. */
function callback(token: string | null, ref: { id?: string; parceiroId?: string }) {
  const url = new URL("https://betleads.io/api/public/sms-webhook");
  if (token) url.searchParams.set("token", token);
  if (ref.id) url.searchParams.set("id", ref.id);
  if (ref.parceiroId) url.searchParams.set("parceiroId", ref.parceiroId);
  url.searchParams.set("statusConfirmacao", "CONFIRMADO");
  return get({ request: new Request(url) });
}

const log = (id: string) => fake.db.rows("sms_send_logs").find((row) => row.id === id)!;
const link = (id: string) => fake.db.rows("link_dispatches").find((row) => row.id === id)!;
const orphans = () =>
  fake.db.rows("sms_send_logs").filter((row) => row.trigger_name === "callback-orphan");

let tokens: { tokenA: string; tokenB: string };

beforeEach(async () => {
  vi.stubEnv("PROVIDER_CREDENTIALS_ENCRYPTION_KEY", "k".repeat(40));
  vi.stubEnv("SHORT_BRASIL_WEBHOOK_SECRET", "global-hook-secret");
  fake.db.reset();
  tokens = await seedCallbackAccounts(fake.db);
  const row = (id: string, key: string, accountId: string | null) => ({
    id,
    provider: "short-brasil",
    status: "sent",
    provider_message_id: `msg-${key}`,
    idempotency_key: key,
    provider_account_id: accountId,
    delivery_status: "sent",
  });
  fake.db
    .rows("sms_send_logs")
    .push(
      row("log-a", "key-a", OWN_A),
      row("log-b", "key-b", OWN_B),
      row("log-p", "key-p", PLATFORM_ACCOUNT),
      row("log-l", "key-l", null),
    );
  fake.db
    .rows("link_dispatches")
    .push(
      { id: "ld-a", idempotency_key: "key-a:0", delivery_status: "sent" },
      { id: "ld-b", idempotency_key: "key-b:0", delivery_status: "sent" },
      { id: "ld-p", idempotency_key: "key-p:0", delivery_status: "sent" },
    );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Short Brasil sms-webhook: callback scope", () => {
  it("unknown or forged tokens stay 401", async () => {
    expect((await callback("wrong", { id: "msg-key-p" })).status).toBe(401);
    expect((await callback(`${tokens.tokenA.slice(0, -2)}xx`, { id: "msg-key-a" })).status).toBe(
      401,
    );
    expect(log("log-p").delivery_status).toBe("sent");
  });

  it("an account token works even without the global secret configured", async () => {
    vi.stubEnv("SHORT_BRASIL_WEBHOOK_SECRET", "");
    expect((await callback("anything", { id: "msg-key-p" })).status).toBe(500);
    expect((await callback(tokens.tokenA, { id: "msg-key-a" })).status).toBe(200);
    expect(log("log-a").delivery_status).toBe("delivered");
  });

  it("(a) global token + owned account's message -> 200, not applied (id or delivery key)", async () => {
    for (const ref of [{ id: "msg-key-a" }, { parceiroId: "key-a" }]) {
      const response = await callback("global-hook-secret", ref);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ matched: 0, ignored: 1 });
    }
    expect(log("log-a").delivery_status).toBe("sent");
    expect(link("ld-a").delivery_status).toBe("sent");
    expect(orphans()).toHaveLength(0);
  });

  it("(b) account A's token + account B's / platform message -> 200, not applied, no orphan", async () => {
    for (const ref of [
      { id: "msg-key-b" },
      { parceiroId: "key-b" },
      { id: "msg-key-p" },
      { parceiroId: "key-l" },
      { id: "msg-unknown", parceiroId: "key-p" },
      { id: "msg-unknown" },
    ]) {
      const response = await callback(tokens.tokenA, ref);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ matched: 0, ignored: 1 });
    }
    for (const id of ["log-b", "log-p", "log-l"]) expect(log(id).delivery_status).toBe("sent");
    expect(link("ld-b").delivery_status).toBe("sent");
    expect(link("ld-p").delivery_status).toBe("sent");
    expect(orphans()).toHaveLength(0);
  });

  it("(c) account A's token + account A's message -> applied, last_callback_at touched", async () => {
    const response = await callback(tokens.tokenA, { parceiroId: "key-a" });
    expect(await response.json()).toMatchObject({ matched: 1, ignored: 0 });
    expect(log("log-a").delivery_status).toBe("delivered");
    expect(link("ld-a").delivery_status).toBe("delivered");
    expect(lastCallbackAt(fake.db, OWN_A)).toEqual(expect.any(String));
  });

  it("(d) global token + platform / legacy message -> applied as today, orphan kept", async () => {
    expect(
      await (await callback("global-hook-secret", { id: "msg-key-p", parceiroId: "key-p" })).json(),
    ).toMatchObject({
      matched: 1,
    });
    expect(
      await (await callback("global-hook-secret", { parceiroId: "key-l" })).json(),
    ).toMatchObject({ matched: 1 });
    expect(log("log-p").delivery_status).toBe("delivered");
    expect(log("log-l").delivery_status).toBe("delivered");
    expect(link("ld-p").delivery_status).toBe("delivered");
    await callback("global-hook-secret", { id: "msg-unknown" });
    expect(orphans()).toHaveLength(1);
  });

  describe("no token at all (origin/main 40e5ba5: URL registered without ?token=)", () => {
    it("applies to platform / legacy rows only", async () => {
      for (const ref of [{ id: "msg-key-p" }, { parceiroId: "key-l" }]) {
        const response = await callback(null, ref);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ matched: 1 });
      }
      expect(log("log-p").delivery_status).toBe("delivered");
      expect(log("log-l").delivery_status).toBe("delivered");
      expect(link("ld-p").delivery_status).toBe("delivered");
    });

    it("never touches an owned account's row (by id or by delivery key)", async () => {
      for (const ref of [{ id: "msg-key-a" }, { parceiroId: "key-a" }, { id: "msg-key-b" }]) {
        const response = await callback(null, ref);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ matched: 0, ignored: 1 });
      }
      expect(log("log-a").delivery_status).toBe("sent");
      expect(log("log-b").delivery_status).toBe("sent");
      expect(link("ld-a").delivery_status).toBe("sent");
      expect(link("ld-b").delivery_status).toBe("sent");
      expect(lastCallbackAt(fake.db, OWN_A)).toBeNull();
    });

    it("no orphan row and no payload key reaches link_dispatches", async () => {
      fake.db
        .rows("link_dispatches")
        .push({ id: "ld-x", idempotency_key: "zz:0", delivery_status: "sent" });
      const response = await callback(null, { id: "msg-forged", parceiroId: "zz" });
      expect(await response.json()).toMatchObject({ matched: 0, ignored: 0 });
      expect(orphans()).toHaveLength(0);
      expect(link("ld-x").delivery_status).toBe("sent");
    });

    it("Short Brasil's token-only lote is acknowledged and changes nothing", async () => {
      const post = (Route as unknown as { options: { server: { handlers: { POST: Handler } } } })
        .options.server.handlers.POST;
      const response = await post({
        request: new Request("https://betleads.io/api/public/sms-webhook", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ lote: [{ token: "abc" }] }),
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ matched: 0 });
      expect(orphans()).toHaveLength(0);
    });
  });

  describe("link_dispatches only follow the matched row's own key", () => {
    beforeEach(() => {
      fake.db
        .rows("link_dispatches")
        .push(
          { id: "ld-x", idempotency_key: "zz:0", delivery_status: "sent" },
          { id: "ld-pct", idempotency_key: "a%b:0", delivery_status: "sent" },
        );
    });
    const untouched = (...ids: string[]) =>
      ids.forEach((id) => expect(link(id).delivery_status).toBe("sent"));

    it("A's token + A's real message id + B's key -> only A's links, B's untouched", async () => {
      const response = await callback(tokens.tokenA, { id: "msg-key-a", parceiroId: "key-b" });
      expect(await response.json()).toMatchObject({ matched: 1 });
      expect(log("log-a").delivery_status).toBe("delivered");
      expect(link("ld-a").delivery_status).toBe("delivered");
      untouched("ld-b", "ld-p", "ld-x", "ld-pct");
    });

    it("A's token + A's real message id + parceiroId '%' -> no other link touched", async () => {
      await callback(tokens.tokenA, { id: "msg-key-a", parceiroId: "%" });
      expect(link("ld-a").delivery_status).toBe("delivered");
      untouched("ld-b", "ld-p", "ld-x", "ld-pct");
    });

    it("global token, no row, parceiroId '%' / '_' / '*' -> no mass update", async () => {
      // A fresh message id each time (each unmatched callback leaves an orphan row).
      for (const [i, parceiroId] of ["%", "%%", "_", "key-_", "*", "a%b"].entries()) {
        await callback("global-hook-secret", { id: `msg-none-${i}`, parceiroId });
      }
      untouched("ld-a", "ld-b", "ld-p", "ld-x");
      // "a%b" is literal: only the dispatch whose key really is "a%b" moves.
      expect(link("ld-pct").delivery_status).toBe("delivered");
    });

    it("global token, no row, plain key -> today's behavior (that delivery's links)", async () => {
      await callback("global-hook-secret", { id: "msg-none", parceiroId: "zz" });
      expect(link("ld-x").delivery_status).toBe("delivered");
      untouched("ld-a", "ld-b", "ld-p");
    });
  });
});
