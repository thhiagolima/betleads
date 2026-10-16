// F0-04 — the cashback catch-up cron (service role, all tenants) must only
// enroll a payment's player when that player belongs to the payment's tenant.

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
        rows().push(insertRow);
        return [insertRow];
      }
      return rows().filter((r) => filters.every((f) => f(r)));
    };
    const builder: any = {
      select: () => builder,
      insert: (r: Row) => ((insertRow = r), builder),
      update: () => builder,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), builder),
      in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), builder),
      gte: () => builder,
      not: () => builder,
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve({ data: run(), error: null }).then(resolve, reject),
    };
    return builder;
  }
  return { supabaseAdmin: { from } };
});

import { runCashbackCatchup } from "./cashback-catchup.server";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

beforeEach(() => {
  state.tables = {
    cashback_payments: [
      {
        id: "cb1",
        tenant_id: A,
        player_id: "p-b",
        paid_at: "2026-10-16T12:00:00Z",
        telefone: null,
        email: null,
      },
      {
        id: "cb2",
        tenant_id: A,
        player_id: "p-a",
        paid_at: "2026-10-16T12:00:00Z",
        telefone: null,
        email: null,
      },
    ],
    tenants: [{ id: A, crm_model: "CRM_PLATAFORMA" }],
    sms_flows: [{ id: "sf-a", tenant_id: A, trigger_name: "cashback_pago", is_active: true }],
    email_flows: [],
    players: [
      { id: "p-a", tenant_id: A, telefone: "5511999990001", email: null },
      { id: "p-b", tenant_id: B, telefone: "5511999990002", email: "b@b.com" },
    ],
    sms_flow_leads: [],
    email_flow_leads: [],
  };
});

describe("runCashbackCatchup", () => {
  it("skips a payment whose player belongs to another tenant", async () => {
    await runCashbackCatchup();
    expect(state.tables.sms_flow_leads.map((l) => l.player_id)).toEqual(["p-a"]);
  });
});
