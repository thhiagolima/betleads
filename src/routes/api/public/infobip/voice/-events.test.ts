import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { from, rpc, handleCallCompletion } = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  handleCallCompletion: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from, rpc } }));
vi.mock("@/lib/call-flows.server", () => ({ handleCallCompletion }));

import { Route } from "./events";

type PostHandler = (input: { request: Request }) => Promise<Response>;
const post = (
  Route as unknown as {
    options: { server: { handlers: { POST: PostHandler } } };
  }
).options.server.handlers.POST;

function historyLookup(history: Record<string, unknown> | null) {
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
  query.maybeSingle.mockResolvedValue({ data: history });
  return query;
}

function updateQuery(error: unknown = null) {
  const query = { update: vi.fn(), eq: vi.fn() };
  query.update.mockReturnValue(query);
  query.eq.mockResolvedValue({ error });
  return query;
}

describe("Infobip voice event callback", () => {
  const originalToken = process.env.INFOBIP_VOICE_CALLBACK_TOKEN;

  beforeEach(() => {
    process.env.INFOBIP_VOICE_CALLBACK_TOKEN = "callback-secret";
    from.mockReset();
    rpc.mockReset();
    rpc.mockResolvedValue({ data: true, error: null });
    handleCallCompletion.mockReset();
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.INFOBIP_VOICE_CALLBACK_TOKEN;
    else process.env.INFOBIP_VOICE_CALLBACK_TOKEN = originalToken;
  });

  it("rejects an event without the callback token", async () => {
    const response = await post({
      request: new Request("https://betleads.io/api/public/infobip/voice/events", {
        method: "POST",
        body: JSON.stringify({ callId: "provider-call" }),
      }),
    });

    expect(response.status).toBe(401);
    expect(from).not.toHaveBeenCalled();
  });

  it("correlates and persists a final provider callback", async () => {
    const history = historyLookup({
      id: "history-1",
      call_queue_id: "queue-1",
      provider_call_id: "provider-call",
      provider_response: { correlation_id: "correlation-1" },
    });
    const historyUpdate = updateQuery();
    const queueUpdate = updateQuery();
    from
      .mockReturnValueOnce(history)
      .mockReturnValueOnce(historyUpdate)
      .mockReturnValueOnce(queueUpdate);

    const response = await post({
      request: new Request(
        "https://betleads.io/api/public/infobip/voice/events?token=callback-secret",
        {
          method: "POST",
          body: JSON.stringify({ callId: "provider-call", status: "COMPLETED", duration: 17 }),
        },
      ),
    });

    expect(await response.json()).toMatchObject({
      ok: true,
      matched: true,
      status: "completed",
      duration_seconds: 17,
    });
    expect(historyUpdate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "completed",
        result: "completed",
        duration_seconds: 17,
      }),
    );
    expect(queueUpdate.update).toHaveBeenCalledWith({
      status: "completed",
      provider_status: "completed",
    });
    expect(handleCallCompletion).toHaveBeenCalledWith({
      providerCallId: "provider-call",
      status: "completed",
      durationSeconds: 17,
    });
  });

  it("finishes the queue when the provider confirms the call was answered", async () => {
    const history = historyLookup({
      id: "history-answered",
      call_queue_id: "queue-answered",
      provider_call_id: "provider-call",
      provider_response: {},
    });
    const historyUpdate = updateQuery();
    const queueUpdate = updateQuery();
    from
      .mockReturnValueOnce(history)
      .mockReturnValueOnce(historyUpdate)
      .mockReturnValueOnce(queueUpdate);

    const response = await post({
      request: new Request(
        "https://betleads.io/api/public/infobip/voice/events?token=callback-secret",
        {
          method: "POST",
          body: JSON.stringify({ callId: "provider-call", status: "ANSWERED" }),
        },
      ),
    });

    expect(await response.json()).toMatchObject({ ok: true, matched: true, status: "answered" });
    expect(queueUpdate.update).toHaveBeenCalledWith({
      status: "completed",
      provider_status: "answered",
    });
    expect(handleCallCompletion).not.toHaveBeenCalled();
  });

  it("releases the journey's voice concurrency permit on a final event only (I3)", async () => {
    const send = (status: string) => {
      from
        .mockReturnValueOnce(
          historyLookup({
            id: "history-permit",
            call_queue_id: null,
            provider_call_id: "provider-call",
            provider_response: { correlation_id: "c-1", channel_permit_id: "permit-1" },
          }),
        )
        .mockReturnValueOnce(updateQuery());
      return post({
        request: new Request(
          "https://betleads.io/api/public/infobip/voice/events?token=callback-secret",
          { method: "POST", body: JSON.stringify({ callId: "provider-call", status }) },
        ),
      });
    };
    await send("ANSWERED");
    expect(rpc).not.toHaveBeenCalled();
    await send("COMPLETED");
    expect(rpc).toHaveBeenCalledWith("release_channel_slot", { p_permit_id: "permit-1" });
    // A failing release never fails the provider callback.
    rpc.mockRejectedValueOnce(new Error("db down"));
    expect((await send("FAILED")).status).toBe(200);
  });

  it("does not acknowledge a callback when its history update fails", async () => {
    from
      .mockReturnValueOnce(
        historyLookup({
          id: "history-2",
          call_queue_id: null,
          provider_call_id: "provider-call",
          provider_response: {},
        }),
      )
      .mockReturnValueOnce(updateQuery(new Error("database unavailable")));

    await expect(
      post({
        request: new Request(
          "https://betleads.io/api/public/infobip/voice/events?token=callback-secret",
          {
            method: "POST",
            body: JSON.stringify({ callId: "provider-call", status: "COMPLETED" }),
          },
        ),
      }),
    ).rejects.toThrow("database unavailable");
  });
});
