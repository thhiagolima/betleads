// F0-04 — call flow rows written with the service role must carry the flow's
// tenant. Without it the column default files them under the main tenant,
// where that tenant can read them and the owner cannot cancel them.

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({ tables: {} as Record<string, Row[]> }));

vi.mock("@/integrations/supabase/client.server", () => {
  function from(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    let insertRow: Row | null = null;
    const rows = () => (state.tables[table] ??= []);
    const run = () => {
      if (insertRow) {
        const row = { id: `${table}-${rows().length + 1}`, ...insertRow };
        rows().push(row);
        return [row];
      }
      return rows().filter((r) => filters.every((f) => f(r)));
    };
    const builder: any = {
      select: () => builder,
      insert: (r: Row) => ((insertRow = r), builder),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), builder),
      in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), builder),
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      single: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve({ data: run(), error: null }).then(resolve, reject),
    };
    return builder;
  }
  return { supabaseAdmin: { from } };
});
vi.mock("./sms.functions", () => ({ sendSmsInternal: vi.fn() }));
vi.mock("./infobip-voice.server", () => ({
  callInfobipVoice: vi.fn(),
  normalizeE164BR: (s: string) => s,
}));

import { enrollPlayerInFlow } from "./call-flows.server";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

beforeEach(() => {
  state.tables = {
    call_flows: [{ id: "flow-b", tenant_id: B, is_active: true }],
    players: [
      { id: "p-b", tenant_id: B, telefone: "+5511999990001" },
      { id: "p-a", tenant_id: A, telefone: "+5511999990002" },
    ],
    call_flow_progress: [],
    call_flow_history: [],
  };
});

describe("enrollPlayerInFlow", () => {
  it("writes progress and history under the flow's tenant", async () => {
    const r = await enrollPlayerInFlow("flow-b", "p-b");
    expect(r.ok).toBe(true);
    expect(state.tables.call_flow_progress[0]).toMatchObject({ tenant_id: B, player_id: "p-b" });
    expect(state.tables.call_flow_history[0]).toMatchObject({
      tenant_id: B,
      event_type: "enrolled",
    });
  });

  it("refuses a player of another tenant", async () => {
    const r = await enrollPlayerInFlow("flow-b", "p-a");
    expect(r).toMatchObject({ ok: false });
    expect(state.tables.call_flow_progress).toEqual([]);
  });
});
