import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

const mocks = vi.hoisted(() => ({
  postShortBrasilSingle: vi.fn(),
}));

vi.mock("@/lib/provider-accounts.server", () => ({
  DEFAULT_SHORT_BRASIL_ACCOUNT_ID: "00000000-0000-4000-a000-00000000a001",
  platformDefaultAccountId: vi.fn(async () => "00000000-0000-4000-a000-00000000a001"),
  loadProviderAccountForAdmin: vi.fn(async (id: string) => ({
    id,
    provider: "short_brasil",
    label: "Short Brasil padrão",
  })),
}));

vi.mock("@/lib/sms.functions", () => ({
  postShortBrasilSingle: mocks.postShortBrasilSingle,
  summarizeProviderError: (_status: number, body: { status?: number }) =>
    body?.status === 5 ? "Short Brasil: saldo insuficiente" : "HTTP 500 do provedor",
}));

import { createFakeDb } from "@/lib/sms-bulk.test-support";

import {
  applyRouteProbeCallback,
  loadProbeOverview,
  normalizeProbePhones,
  runSmsRouteProbe,
  saveProbeSettings,
} from "./sms-route-probe.server";

const NOW = new Date("2026-11-13T15:00:00.000Z");
const USER = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
  fake.admin.reset();
  mocks.postShortBrasilSingle.mockReset();
});

describe("settings", () => {
  it("normalizes, dedupes and validates phones", () => {
    expect(normalizeProbePhones(["(11) 99999-8888", "5511999998888", " "])).toEqual([
      "+5511999998888",
    ]);
    expect(() => normalizeProbePhones(["123"])).toThrow(/inválido/);
  });

  it("refuses to enable without a phone", async () => {
    await expect(saveProbeSettings({ enabled: true, phones: [] }, USER)).rejects.toThrow(
      /pelo menos um número/,
    );
  });
});

describe("runSmsRouteProbe", () => {
  it("does nothing while disabled, unless forced", async () => {
    await saveProbeSettings({ enabled: false, phones: ["11999998888"] }, USER);
    expect(await runSmsRouteProbe(NOW)).toMatchObject({ skipped: "disabled", sent: 0 });
    expect(mocks.postShortBrasilSingle).not.toHaveBeenCalled();

    mocks.postShortBrasilSingle.mockResolvedValue({ ok: true, status: 200, body: { id: "P1" } });
    expect(await runSmsRouteProbe(NOW, { force: true })).toMatchObject({ skipped: null, sent: 1 });
  });

  it("sends one SMS per phone with unique codes and records the result", async () => {
    await saveProbeSettings({ enabled: true, phones: ["11999998888", "21988887777"] }, USER);
    mocks.postShortBrasilSingle
      .mockResolvedValueOnce({ ok: true, status: 200, body: { id: "P1", parceiroId: "x" } })
      .mockResolvedValueOnce({ ok: false, status: 200, body: { status: 5 } });

    const result = await runSmsRouteProbe(NOW);
    expect(result.results).toEqual(["accepted", "no_balance"]);

    const probes = fake.admin.rows("sms_route_probes");
    expect(probes).toHaveLength(2);
    expect(probes[0].probe_code).not.toBe(probes[1].probe_code);
    expect(probes[0].round_id).toBe(probes[1].round_id);
    expect(String(probes[0].message)).toContain(String(probes[0].probe_code));
    expect(probes[0].message).not.toBe(probes[1].message);
    expect(probes[0].provider_message_id).toBe("P1");
    expect(probes[1]).toMatchObject({
      result: "no_balance",
      error: "Short Brasil: saldo insuficiente",
      provider_message_id: null,
    });
    // Nada vai para a tabela de envios das casas.
    expect(fake.admin.rows("sms_send_logs")).toHaveLength(0);

    const [, , , key] = mocks.postShortBrasilSingle.mock.calls[0];
    expect(probes[0].idempotency_key).toBe(key);
  });

  it("purges probes older than the retention", async () => {
    await saveProbeSettings({ enabled: true, phones: ["11999998888"] }, USER);
    fake.admin.rows("sms_route_probes").push({ id: "old", sent_at: "2026-09-01T00:00:00.000Z" });
    mocks.postShortBrasilSingle.mockResolvedValue({ ok: true, status: 200, body: { id: "P1" } });
    await runSmsRouteProbe(NOW);
    expect(fake.admin.rows("sms_route_probes").some((r) => r.id === "old")).toBe(false);
  });
});

describe("applyRouteProbeCallback", () => {
  beforeEach(() => {
    fake.admin.rows("sms_route_probes").push({
      id: "p1",
      provider_message_id: "PID",
      idempotency_key: "KEY",
      delivery_status: null,
    });
  });

  it("matches by provider id or idempotency key", async () => {
    const base = { deliveredAt: null, error: null, payload: {} };
    expect(
      await applyRouteProbeCallback({
        ...base,
        providerMessageId: "PID",
        idempotencyKey: null,
        deliveryStatus: "sent",
      }),
    ).toBe(true);
    expect(
      await applyRouteProbeCallback({
        ...base,
        providerMessageId: "other",
        idempotencyKey: "KEY",
        deliveryStatus: "delivered",
        deliveredAt: "2026-11-13T15:01:00.000Z",
      }),
    ).toBe(true);
    expect(fake.admin.rows("sms_route_probes")[0]).toMatchObject({
      delivery_status: "delivered",
      delivered_at: "2026-11-13T15:01:00.000Z",
    });
    expect(
      await applyRouteProbeCallback({
        ...base,
        providerMessageId: "nope",
        idempotencyKey: "nope",
        deliveryStatus: "delivered",
      }),
    ).toBe(false);
  });

  it("never downgrades a final status", async () => {
    const base = { providerMessageId: "PID", idempotencyKey: null, error: null, payload: {} };
    await applyRouteProbeCallback({ ...base, deliveryStatus: "delivered", deliveredAt: null });
    await applyRouteProbeCallback({ ...base, deliveryStatus: "sent", deliveredAt: null });
    expect(fake.admin.rows("sms_route_probes")[0].delivery_status).toBe("delivered");
  });
});

describe("loadProbeOverview", () => {
  it("returns settings, status and the recent probes", async () => {
    await saveProbeSettings({ enabled: true, phones: ["11999998888"] }, USER);
    mocks.postShortBrasilSingle.mockResolvedValue({ ok: false, status: 200, body: { status: 5 } });
    await runSmsRouteProbe(new Date());
    const overview = await loadProbeOverview(new Date());
    expect(overview.settings.phones).toEqual(["+5511999998888"]);
    expect(overview.status.balance).toBe("no_balance");
    expect(overview.recent).toHaveLength(1);
    expect(overview.accountLabel).toBe("Short Brasil padrão");
  });
});
