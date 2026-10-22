// Task 9 fix round 1 — Critical 1: an SMS actually sent through
// sendSmsInternal must resolve the house's quick links, including a dynamic
// unknown {link_*} token, not just the 3 hard-coded variables baked into
// buildPlayerVariables. Exercises the real sendSmsInternal (as
// sms-dispatcher.server.ts's campaign `send` path does) against an in-memory
// stand-in for tenants/tenant_quick_links/sms_send_logs/wallet_ledger,
// the same mock shape as sms-delivery-idempotency.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  tenants: [] as Row[],
  quickLinks: [] as Row[],
  smsLogs: [] as Row[],
  ledger: [] as Row[],
}));

vi.mock("@/integrations/supabase/client.server", () => {
  type Filter = (row: Row) => boolean;
  const tables: Record<string, () => Row[]> = {
    tenants: () => state.tenants,
    tenant_quick_links: () => state.quickLinks,
    sms_send_logs: () => state.smsLogs,
    wallet_ledger: () => state.ledger,
    link_dispatches: () => [],
  };
  function from(table: string) {
    const filters: Filter[] = [];
    let insertRow: Row | null = null;
    const result = () => {
      if (insertRow) {
        const row = { id: `${table}-${(tables[table]?.() ?? []).length + 1}`, ...insertRow };
        tables[table]().push(row);
        return { data: row, error: null };
      }
      return { data: tables[table]().filter((row) => filters.every((f) => f(row))), error: null };
    };
    const builder: any = {
      select: () => builder,
      update: () => builder,
      insert: (row: Row) => {
        insertRow = row;
        return builder;
      },
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return builder;
      },
      in: (column: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[column]));
        return builder;
      },
      limit: () => builder,
      single: async () => {
        const r = result();
        const list = r.data as Row[] | Row;
        return Array.isArray(list) ? { data: list[0] ?? null, error: r.error } : r;
      },
      maybeSingle: async () => {
        const r = result();
        const list = r.data as Row[] | Row;
        return Array.isArray(list) ? { data: list[0] ?? null, error: r.error } : r;
      },
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(result()).then(resolve, reject),
    };
    return builder;
  }
  function reserve(args: Row) {
    const existing = state.ledger.find(
      (row) => row.tenant_id === args._tenant && row.idempotency_key === args._idempotency_key,
    );
    if (existing)
      return { data: { ok: true, idempotent: true, amount: existing.amount }, error: null };
    const units = Number(args._units ?? 1);
    const amount = -(units * 0.08);
    state.ledger.push({
      tenant_id: args._tenant,
      idempotency_key: args._idempotency_key,
      reference_id: args._reference_id,
      units,
      amount,
      entry_type: "usage_reservation",
    });
    return { data: { ok: true, idempotent: false, amount, exempt: false }, error: null };
  }
  function refund(args: Row) {
    state.ledger.push({
      tenant_id: args._tenant,
      idempotency_key: args._idempotency_key,
      reference_id: args._reference_id,
      entry_type: "usage_refund",
    });
    return { data: { ok: true, idempotent: false }, error: null };
  }
  async function rpc(fn: string, args: Row) {
    if (fn === "wallet_reserve") return reserve(args);
    if (fn === "wallet_refund") return refund(args);
    throw new Error(`unexpected rpc ${fn}`);
  }
  return { supabaseAdmin: { from, rpc } };
});

vi.mock("@/lib/tenant-access.server", () => ({
  assertTenantCanOperate: vi.fn(async () => undefined),
  assertTenantCanSendExternally: vi.fn(async () => undefined),
  assertTenantNotDemoForSend: vi.fn(async () => undefined),
  demoSendBlockedReason: vi.fn(async () => null),
  resolveCurrentTenantId: vi.fn(),
  resolveOperationalTenantId: vi.fn(),
}));
vi.mock("./consent.server", () => ({ isChannelRevoked: vi.fn(async () => false) }));
vi.mock("./shortio.server", () => ({
  prepareTrackedText: vi.fn(async (content: string) => ({ content, links: [] })),
  markTrackedDispatchesSent: vi.fn(async () => undefined),
  markTrackedDispatchesFailed: vi.fn(async () => undefined),
}));

import { sendSmsInternal } from "./sms.functions";
import { __resetHouseLinksCacheForTests, loadHouseLinks } from "./house-links.server";

const TENANT = "00000000-0000-4000-8000-000000000001";

function providerAccepts() {
  return vi.fn(
    async () =>
      new Response(JSON.stringify([{ external_id: "x", status: "accepted" }]), { status: 200 }),
  );
}

function lastSentContent(fetchMock: ReturnType<typeof providerAccepts>): string {
  const call = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
  const body = JSON.parse(String(call[1].body));
  return body[0].message;
}

describe("sendSmsInternal — house quick links (Task 9 fix round 1, Critical 1)", () => {
  beforeEach(() => {
    state.tenants.length = 0;
    state.quickLinks.length = 0;
    state.smsLogs.length = 0;
    state.ledger.length = 0;
    __resetHouseLinksCacheForTests();
    process.env.SHORTCODE_SMS_TOKEN = "test-token";
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.SHORTCODE_SMS_TOKEN;
  });

  it("resolves a dynamic {link_promo} and a deleted-quick-link {link_apagado} via house passed straight to sendSmsInternal", async () => {
    state.tenants.push({ id: TENANT, site_url: "https://x.com" });
    state.quickLinks.push({ tenant_id: TENANT, key: "promo", path: "/promo" });
    const house = await loadHouseLinks(TENANT);

    const fetchMock = providerAccepts();
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendSmsInternal({
      to: "+5511999999999",
      content: "Promo: {link_promo} | Antigo: {link_apagado}",
      tenantId: TENANT,
      house,
    });

    expect(result.ok).toBe(true);
    expect(lastSentContent(fetchMock)).toBe("Promo: https://x.com/promo | Antigo: https://x.com");
  });

  it("without house, unknown {link_*} tokens stay literal (legacy, unchanged)", async () => {
    const fetchMock = providerAccepts();
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendSmsInternal({
      to: "+5511999999999",
      content: "Promo: {link_promo}",
      tenantId: TENANT,
    });

    expect(result.ok).toBe(true);
    expect(lastSentContent(fetchMock)).toBe("Promo: {link_promo}");
  });
});
