import { beforeEach, describe, expect, it, vi } from "vitest";

const { from } = vi.hoisted(() => ({ from: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from },
}));

import { reconcilePendingInfobipVoiceCalls } from "./infobip-voice-reconciliation.server";

type VoiceRow = {
  id: string;
  provider_call_id: string | null;
  created_at: string;
  provider_response: Record<string, unknown>;
};

function createVoiceQuery(rows: VoiceRow[], updateError: unknown = null) {
  const updates: Array<Record<string, unknown>> = [];
  const updateResult = {
    eq: vi.fn(() => ({
      in: vi.fn().mockResolvedValue({ error: updateError }),
    })),
  };
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    in: vi.fn(),
    lte: vi.fn(),
    gte: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    update: vi.fn((payload: Record<string, unknown>) => {
      updates.push(payload);
      return updateResult;
    }),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.in.mockReturnValue(query);
  query.lte.mockReturnValue(query);
  query.gte.mockReturnValue(query);
  query.order.mockReturnValue(query);
  query.limit.mockResolvedValue({ data: rows, error: null });
  return { query, updates };
}

describe("Infobip callback reconciliation", () => {
  beforeEach(() => {
    from.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("only audits missing voice callbacks and never infers a final call status", async () => {
    const { query, updates } = createVoiceQuery([
      {
        id: "voice-history-1",
        provider_call_id: "provider-call-1",
        created_at: new Date(Date.now() - 25 * 60 * 60_000).toISOString(),
        provider_response: { correlation_id: "correlation-1" },
      },
    ]);
    from.mockReturnValue(query);

    await expect(reconcilePendingInfobipVoiceCalls()).resolves.toEqual({ audited: 1, alerted: 1 });

    expect(from).toHaveBeenCalledWith("call_history");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      provider_response: {
        correlation_id: "correlation-1",
        reconciliation: {
          callback_missing: true,
          requires_attention: true,
        },
      },
    });
    expect(updates[0]).not.toHaveProperty("status");
    expect(updates[0]).not.toHaveProperty("result");
  });

  it("fails the job when an audit update cannot be persisted", async () => {
    const { query } = createVoiceQuery(
      [
        {
          id: "voice-history-2",
          provider_call_id: "provider-call-2",
          created_at: new Date(Date.now() - 20 * 60_000).toISOString(),
          provider_response: {},
        },
      ],
      new Error("database unavailable"),
    );
    from.mockReturnValue(query);

    await expect(reconcilePendingInfobipVoiceCalls()).rejects.toThrow("database unavailable");
  });
});
