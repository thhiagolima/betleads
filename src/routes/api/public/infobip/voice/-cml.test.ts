import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { from } = vi.hoisted(() => ({ from: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from } }));

// The token store has its own coverage (provider-callback-tokens.server.test.ts);
// here account A's token is "pa_token_a" and the owned accounts are A and B.
const scopeIds = vi.hoisted(() => ({
  OWN_A: "11111111-1111-4111-8111-111111111111",
  OWN_B: "22222222-2222-4222-8222-222222222222",
  TENANT: "00000000-0000-4000-8000-000000000001",
  touch: vi.fn(async (_accountId: string) => undefined),
}));
vi.mock("@/lib/provider-callback-tokens.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/provider-callback-tokens.server")>();
  return {
    ...actual,
    resolveCallbackScope: vi.fn(async (token: string | null, global: string | undefined) => {
      if (token === "pa_token_a")
        return { kind: "account", accountId: scopeIds.OWN_A, tenantId: scopeIds.TENANT };
      return token && token === global ? { kind: "platform" } : null;
    }),
    ownedAccountIdsFor: vi.fn(async (scope: { kind: string }) =>
      scope.kind === "platform" ? new Set([scopeIds.OWN_A, scopeIds.OWN_B]) : new Set(),
    ),
    touchCallbackReceived: scopeIds.touch,
  };
});

import { answeredByOf, Route } from "./cml";

type PostHandler = (input: { request: Request }) => Promise<Response>;
const post = (
  Route as unknown as {
    options: { server: { handlers: { POST: PostHandler } } };
  }
).options.server.handlers.POST;

function historyLookup(providerAccountId: string | null = null) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    maybeSingle: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.order.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  query.maybeSingle.mockResolvedValue({
    data: {
      id: "history-1",
      call_queue_id: "queue-1",
      provider_account_id: providerAccountId,
      provider_response: {
        correlation_id: "correlation-1",
        cml: { type: "say", text: "Mensagem de teste", language: "pt" },
      },
    },
  });
  return query;
}

function updateQuery() {
  const query = {
    update: vi.fn(),
    eq: vi.fn(),
    in: vi.fn(),
    then: (resolve: (value: { error: null }) => unknown) =>
      Promise.resolve(resolve({ error: null })),
  };
  query.update.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.in.mockReturnValue(query);
  return query;
}

describe("Infobip voice CML callback", () => {
  const originalToken = process.env.INFOBIP_VOICE_CALLBACK_TOKEN;

  beforeEach(() => {
    process.env.INFOBIP_VOICE_CALLBACK_TOKEN = "callback-secret";
    from.mockReset();
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.INFOBIP_VOICE_CALLBACK_TOKEN;
    else process.env.INFOBIP_VOICE_CALLBACK_TOKEN = originalToken;
  });

  it("marks the direct-call queue as answered when Infobip requests the CML", async () => {
    const historyUpdate = updateQuery();
    const queueUpdate = updateQuery();
    from
      .mockReturnValueOnce(historyLookup())
      .mockReturnValueOnce(historyUpdate)
      .mockReturnValueOnce(queueUpdate);

    const response = await post({
      request: new Request(
        "https://betleads.io/api/public/infobip/voice/cml?token=callback-secret&mode=say&correlation=correlation-1",
        {
          method: "POST",
          body: JSON.stringify({ callId: "provider-call" }),
        },
      ),
    });

    expect(response.status).toBe(200);
    expect(queueUpdate.update).toHaveBeenCalledWith({
      status: "completed",
      provider_status: "answered",
    });
    expect(queueUpdate.in).toHaveBeenCalledWith("status", ["waiting_provider", "calling"]);
    expect(await response.json()).toMatchObject({
      actions: [{ action: "say", text: "Mensagem de teste" }, { action: "hangup" }],
    });
  });

  function cml(token: string) {
    return post({
      request: new Request(
        `https://betleads.io/api/public/infobip/voice/cml?token=${token}&mode=say&correlation=correlation-1`,
        { method: "POST", body: JSON.stringify({ callId: "provider-call" }) },
      ),
    });
  }

  it("rejects an unknown token", async () => {
    expect((await cml("wrong")).status).toBe(401);
    expect(from).not.toHaveBeenCalled();
  });

  it("(a) global token + owned account's call -> 200 hangup, nothing applied nor revealed", async () => {
    from.mockReturnValueOnce(historyLookup(scopeIds.OWN_A));
    const response = await cml("callback-secret");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ actions: [{ action: "hangup" }] });
    expect(JSON.stringify(body)).not.toContain("Mensagem de teste");
    expect(from).toHaveBeenCalledTimes(1);
  });

  it("(b) account A's token + account B's or a platform call -> 200 hangup, nothing applied", async () => {
    for (const accountId of [scopeIds.OWN_B, null]) {
      from.mockReset();
      from.mockReturnValueOnce(historyLookup(accountId));
      const response = await cml("pa_token_a");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ actions: [{ action: "hangup" }] });
      expect(from).toHaveBeenCalledTimes(1);
    }
  });

  it("(c) account A's token + account A's call -> applied, last callback touched", async () => {
    scopeIds.touch.mockClear();
    const historyUpdate = updateQuery();
    const queueUpdate = updateQuery();
    from
      .mockReturnValueOnce(historyLookup(scopeIds.OWN_A))
      .mockReturnValueOnce(historyUpdate)
      .mockReturnValueOnce(queueUpdate);
    const response = await cml("pa_token_a");
    expect(await response.json()).toMatchObject({
      actions: [{ action: "say", text: "Mensagem de teste" }, { action: "hangup" }],
    });
    expect(historyUpdate.update).toHaveBeenCalled();
    expect(scopeIds.touch).toHaveBeenCalledWith(scopeIds.OWN_A);
  });

  // V1-02 — answering-machine detection (SYNC): the CML callback carries
  // `machineDetectionResult`; a machine is hung up, anything else plays.
  function cmlRequest(body: Record<string, unknown>, query = "mode=say&correlation=correlation-1") {
    return new Request(
      `https://betleads.io/api/public/infobip/voice/cml?token=callback-secret&${query}`,
      { method: "POST", body: JSON.stringify(body) },
    );
  }

  it.each(["MACHINE", "MACHINE_EOM_BEEP", "MACHINE_EOM_SILENCE", "MACHINE_EOM_TIMEOUT"])(
    "hangs up without playing when the call is answered by a machine (%s)",
    async (machineDetectionResult) => {
      const answeredByUpdate = updateQuery();
      from
        .mockReturnValueOnce(historyLookup())
        .mockReturnValueOnce(updateQuery())
        .mockReturnValueOnce(updateQuery())
        .mockReturnValueOnce(answeredByUpdate);

      const response = await post({
        request: cmlRequest({ callId: "provider-call", machineDetectionResult }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ actions: [{ action: "hangup" }] });
      expect(answeredByUpdate.update).toHaveBeenCalledWith({ answered_by: "machine" });
      expect(answeredByUpdate.eq).toHaveBeenCalledWith("id", "history-1");
    },
  );

  it("hangs up a machine even for an audio call", async () => {
    from
      .mockReturnValueOnce(historyLookup())
      .mockReturnValueOnce(updateQuery())
      .mockReturnValueOnce(updateQuery())
      .mockReturnValueOnce(updateQuery());

    const response = await post({
      request: cmlRequest(
        { callId: "provider-call", machineDetectionResult: "MACHINE" },
        "audio=https%3A%2F%2Fcdn.example%2Fa.mp3&correlation=correlation-1",
      ),
    });

    expect(await response.json()).toEqual({ actions: [{ action: "hangup" }] });
  });

  it("plays the message and records a human answer", async () => {
    const answeredByUpdate = updateQuery();
    from
      .mockReturnValueOnce(historyLookup())
      .mockReturnValueOnce(updateQuery())
      .mockReturnValueOnce(updateQuery())
      .mockReturnValueOnce(answeredByUpdate);

    const response = await post({
      request: cmlRequest({ callId: "provider-call", machineDetectionResult: "HUMAN" }),
    });

    expect(await response.json()).toMatchObject({
      actions: [{ action: "say", text: "Mensagem de teste" }, { action: "hangup" }],
    });
    expect(answeredByUpdate.update).toHaveBeenCalledWith({ answered_by: "human" });
  });

  it.each([
    ["absent", {}],
    ["unknown", { machineDetectionResult: "NOT_SURE" }],
    ["not a string", { machineDetectionResult: { value: "MACHINE" } }],
  ])("fails open and plays when the detection result is %s", async (_label, extra) => {
    from
      .mockReturnValueOnce(historyLookup())
      .mockReturnValueOnce(updateQuery())
      .mockReturnValueOnce(updateQuery());

    const response = await post({ request: cmlRequest({ callId: "provider-call", ...extra }) });

    expect(await response.json()).toMatchObject({
      actions: [{ action: "say", text: "Mensagem de teste" }, { action: "hangup" }],
    });
    // No answered_by write: only lookup, status and queue updates.
    expect(from).toHaveBeenCalledTimes(3);
  });

  it("still plays when recording answered_by fails", async () => {
    const failing = updateQuery();
    failing.then = (resolve) =>
      Promise.resolve(resolve({ error: { message: "column does not exist" } } as never));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    from
      .mockReturnValueOnce(historyLookup())
      .mockReturnValueOnce(updateQuery())
      .mockReturnValueOnce(updateQuery())
      .mockReturnValueOnce(failing);

    const response = await post({
      request: cmlRequest({ callId: "provider-call", machineDetectionResult: "HUMAN" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ actions: [{ action: "say" }, { action: "hangup" }] });
  });
});

describe("answeredByOf", () => {
  it("maps the Infobip AMD statuses", () => {
    expect(answeredByOf({ machineDetectionResult: "HUMAN" })).toBe("human");
    expect(answeredByOf({ machineDetectionResult: "MACHINE" })).toBe("machine");
    expect(answeredByOf({ machineDetectionResult: "MACHINE_EOM_BEEP" })).toBe("machine");
    expect(answeredByOf({})).toBeNull();
    expect(answeredByOf({ machineDetectionResult: "" })).toBeNull();
  });
});
