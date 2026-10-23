import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { from, rpc, handleCallCompletion, settleVoiceCall } = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  handleCallCompletion: vi.fn(),
  settleVoiceCall: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from, rpc } }));
vi.mock("@/lib/call-flows.server", () => ({ handleCallCompletion }));
vi.mock("@/lib/billing/wallet.server", () => ({ settleVoiceCall }));

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
    settleVoiceCall.mockReset();
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

  describe("billing settlement (PG3 Task 5)", () => {
    const TENANT = "00000000-0000-4000-8000-000000000001";
    const REF = "voice:key-1";
    const settledResult = (blocks: number, billedAmount: number) => ({
      ok: true,
      idempotent: false,
      blocks,
      billedAmount,
      amount: 0.45 - billedAmount,
      balance: 10,
    });

    function billedHistory(overrides: Record<string, unknown> = {}) {
      return historyLookup({
        id: "history-billed",
        call_queue_id: null,
        provider_call_id: "provider-call",
        provider_response: { correlation_id: "c-1" },
        tenant_id: TENANT,
        status: "pending",
        billing_reference_id: REF,
        billing_settled_at: null,
        ...overrides,
      });
    }

    async function send(payload: Record<string, unknown>) {
      const response = await post({
        request: new Request(
          "https://betleads.io/api/public/infobip/voice/events?token=callback-secret",
          { method: "POST", body: JSON.stringify({ callId: "provider-call", ...payload }) },
        ),
      });
      expect(response.status).toBe(200);
      return response;
    }

    beforeEach(() => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("settles an answered call on the final event by its duration and records the bill", async () => {
      const billingUpdate = updateQuery();
      from
        .mockReturnValueOnce(billedHistory({ status: "answered" }))
        .mockReturnValueOnce(updateQuery())
        .mockReturnValueOnce(billingUpdate);
      settleVoiceCall.mockResolvedValue(settledResult(3, 0.27));

      await send({ status: "COMPLETED", duration: 61 });

      expect(settleVoiceCall).toHaveBeenCalledWith(expect.anything(), {
        tenantId: TENANT,
        referenceId: REF,
        durationSeconds: 61,
        answered: true,
      });
      expect(billingUpdate.update).toHaveBeenCalledWith({
        billed_blocks: 3,
        billed_amount: 0.27,
        billing_settled_at: expect.any(String),
      });
      expect(billingUpdate.eq).toHaveBeenCalledWith("id", "history-billed");
    });

    it("a repeated final callback charges once", async () => {
      from
        .mockReturnValueOnce(billedHistory({ status: "answered" }))
        .mockReturnValueOnce(updateQuery())
        .mockReturnValueOnce(updateQuery());
      settleVoiceCall.mockResolvedValue(settledResult(1, 0.09));
      await send({ status: "COMPLETED", duration: 20 });
      expect(settleVoiceCall).toHaveBeenCalledTimes(1);

      // The second delivery finds the row already settled: no new settlement.
      from
        .mockReturnValueOnce(
          billedHistory({ status: "completed", billing_settled_at: "2026-10-22T12:00:00Z" }),
        )
        .mockReturnValueOnce(updateQuery());
      await send({ status: "COMPLETED", duration: 20 });
      expect(settleVoiceCall).toHaveBeenCalledTimes(1);
    });

    it.each(["BUSY", "NO_ANSWER", "FAILED"])(
      "%s settles as unanswered (full refund by default)",
      async (status) => {
        from
          .mockReturnValueOnce(billedHistory())
          .mockReturnValueOnce(updateQuery())
          .mockReturnValueOnce(updateQuery());
        settleVoiceCall.mockResolvedValue(settledResult(0, 0));
        await send({ status });
        expect(settleVoiceCall).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ referenceId: REF, answered: false }),
        );
      },
    );

    it("completed with 0 s on a call that was never answered counts as unanswered", async () => {
      from
        .mockReturnValueOnce(billedHistory({ status: "pending" }))
        .mockReturnValueOnce(updateQuery())
        .mockReturnValueOnce(updateQuery());
      settleVoiceCall.mockResolvedValue(settledResult(0, 0));
      await send({ status: "COMPLETED", duration: 0 });
      expect(settleVoiceCall).toHaveBeenCalledWith(expect.anything(), {
        tenantId: TENANT,
        referenceId: REF,
        durationSeconds: 0,
        answered: false,
      });
    });

    it("answered with no duration in the callback passes null so the cap is charged", async () => {
      from
        .mockReturnValueOnce(billedHistory({ status: "answered" }))
        .mockReturnValueOnce(updateQuery())
        .mockReturnValueOnce(updateQuery());
      settleVoiceCall.mockResolvedValue(settledResult(5, 0.45));
      await send({ status: "COMPLETED" });
      expect(settleVoiceCall).toHaveBeenCalledWith(expect.anything(), {
        tenantId: TENANT,
        referenceId: REF,
        durationSeconds: null,
        answered: true,
      });
    });

    it("a CML fetch recorded in the callbacks still counts as answered after the status moved on", async () => {
      from
        .mockReturnValueOnce(
          billedHistory({
            status: "completed",
            provider_response: { callbacks: [{ type: "cml_answered", payload: {} }] },
          }),
        )
        .mockReturnValueOnce(updateQuery())
        .mockReturnValueOnce(updateQuery());
      settleVoiceCall.mockResolvedValue(settledResult(1, 0.09));
      await send({ status: "HANGUP", duration: 12 });
      expect(settleVoiceCall).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ answered: true, durationSeconds: 12 }),
      );
    });

    it("an intermediate ANSWERED event never settles", async () => {
      from.mockReturnValueOnce(billedHistory()).mockReturnValueOnce(updateQuery());
      await send({ status: "ANSWERED" });
      expect(settleVoiceCall).not.toHaveBeenCalled();
    });

    it("a call without a billing reference (before PG3) is not settled", async () => {
      from
        .mockReturnValueOnce(billedHistory({ billing_reference_id: null }))
        .mockReturnValueOnce(updateQuery());
      await send({ status: "COMPLETED", duration: 10 });
      expect(settleVoiceCall).not.toHaveBeenCalled();
    });

    it("a reservation already refunded on a timeout is acknowledged without billing", async () => {
      from
        .mockReturnValueOnce(billedHistory({ status: "answered" }))
        .mockReturnValueOnce(updateQuery());
      settleVoiceCall.mockResolvedValue({ ok: false, reason: "already_reversed" });
      await send({ status: "COMPLETED", duration: 40 });
      // No billing update: only the lookup and the history update touched the DB.
      expect(from).toHaveBeenCalledTimes(2);
      expect(console.error).not.toHaveBeenCalled();
    });

    it("a settlement failure never fails the provider callback", async () => {
      from
        .mockReturnValueOnce(billedHistory({ status: "answered" }))
        .mockReturnValueOnce(updateQuery());
      settleVoiceCall.mockRejectedValue(new Error("db down"));
      await send({ status: "COMPLETED", duration: 40 });
      expect(handleCallCompletion).toHaveBeenCalled();
      expect(console.error).toHaveBeenCalled();
    });
  });
});
