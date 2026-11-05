// PG1 Task 7, fix round 1 — covers the two findings on the campaign SMS
// cost: averageBilledSegments's math, and selectAllPages actually paging
// past PostgREST's 1000-row cap (the bug that silently undercounted cost
// for campaigns with over 1000 accepted SMS).
import { describe, expect, it, vi } from "vitest";
import { createFakeDb } from "@/lib/sms-bulk.test-support";
import {
  averageBilledSegments,
  getCampaignReportDetailsFor,
  selectAllPages,
} from "./conversion-report.functions";

vi.mock("@/lib/tenant-access.server", () => ({
  resolveOperationalTenantId: vi.fn(async () => "t1"),
}));

// webpush_campaigns is service_role only (no `authenticated` grant): the report reads it
// with supabaseAdmin, not the caller's client. Mock client.server with its own fake db so
// tests can seed/break that table independently of the caller client (`fake.client` below).
const adminFake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  adminFake.db = createFakeDb();
  return { supabaseAdmin: adminFake.db.client };
});

describe("averageBilledSegments", () => {
  it("counts a null billed_units as 1 segment", () => {
    expect(averageBilledSegments([{ billed_units: null }])).toBe(1);
  });

  it("returns 1 when there are no rows at all (never 0, never NaN)", () => {
    expect(averageBilledSegments([])).toBe(1);
  });

  it("averages mixed billed_units, null defaulting to 1", () => {
    expect(
      averageBilledSegments([{ billed_units: 2 }, { billed_units: 1 }, { billed_units: 3 }]),
    ).toBe(2);
    expect(
      averageBilledSegments([{ billed_units: 2 }, { billed_units: null }, { billed_units: 2 }]),
    ).toBeCloseTo(5 / 3, 10);
  });
});

/** Fake PostgREST-ish query builder: `.gt(id)` + `.order` + `.limit(n)`, each
 * page returning at most `n` rows from an in-memory array, exactly like the
 * real `.range`/`.limit` cap selectAllPages works around. */
function fakePagedQuery(allRows: Array<{ id: string; billed_units: number | null }>) {
  let afterId: string | null = null;
  const builder = {
    gt(_column: string, value: string) {
      afterId = value;
      return builder;
    },
    order(_column: string, _opts: unknown) {
      return builder;
    },
    limit(size: number) {
      const startIndex = afterId ? allRows.findIndex((row) => row.id === afterId) + 1 : 0;
      const page = allRows.slice(startIndex, startIndex + size);
      return Promise.resolve({ data: page, error: null });
    },
  };
  return builder;
}

describe("selectAllPages", () => {
  it("returns every row of a 1200-row set, past PostgREST's 1000-row cap", async () => {
    const rows = Array.from({ length: 1200 }, (_, index) => ({
      id: String(index + 1).padStart(6, "0"),
      billed_units: 2,
    }));

    const result = await selectAllPages<{ id: string; billed_units: number | null }>(
      "test:campaign_billed_units",
      () => fakePagedQuery(rows),
    );

    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(1200);
    expect(result.truncated).toBe(false);
    // The bug this covers: cost silently undercounted because only the
    // first 1000 rows were ever fetched.
    expect(averageBilledSegments(result.data)).toBe(2);
  });

  it("stops at a single page when there are fewer rows than the page size", async () => {
    const rows = [{ id: "a", billed_units: 3 }];

    const result = await selectAllPages<{ id: string; billed_units: number | null }>(
      "test:small",
      () => fakePagedQuery(rows),
    );

    expect(result.data).toHaveLength(1);
    expect(result.truncated).toBe(false);
  });
});

describe("getCampaignReportDetailsFor", () => {
  it("devolve channel: webpush e os contadores de uma campanha de push", async () => {
    const fake = createFakeDb();
    adminFake.db.reset();
    adminFake.db.rows("webpush_campaigns").push({
      id: "wp-1",
      tenant_id: "t1",
      name: "Campanha push",
      title: "Bônus liberado",
      body: "Clique para ver o bônus",
      status: "enviado",
      target_count: 500,
      sent_count: 480,
      failed_count: 20,
      scheduled_at: "2026-11-05T10:00:00.000Z",
      created_at: "2026-11-05T09:00:00.000Z",
      updated_at: "2026-11-05T10:05:00.000Z",
    });

    const result = await getCampaignReportDetailsFor(
      { supabase: fake.client },
      { campaignId: "wp-1", limit: 500 },
    );

    expect(result.campaign).toMatchObject({
      channel: "webpush",
      name: "Campanha push",
      status: "enviado",
      total: 500,
      sent: 480,
      failed: 20,
    });
    // Terminal status: finishedAt is the row's updated_at.
    expect(result.campaign?.finishedAt).toBe("2026-11-05T10:05:00.000Z");
  });

  it("finishedAt é null para uma campanha de push ainda em andamento", async () => {
    const fake = createFakeDb();
    adminFake.db.reset();
    adminFake.db.rows("webpush_campaigns").push({
      id: "wp-2",
      tenant_id: "t1",
      name: "Campanha em andamento",
      title: "Bônus liberado",
      body: "Clique para ver o bônus",
      status: "enviando",
      target_count: 500,
      sent_count: 100,
      failed_count: 0,
      scheduled_at: "2026-11-05T10:00:00.000Z",
      created_at: "2026-11-05T09:00:00.000Z",
      updated_at: "2026-11-05T10:05:00.000Z",
    });

    const result = await getCampaignReportDetailsFor(
      { supabase: fake.client },
      { campaignId: "wp-2", limit: 500 },
    );

    expect(result.campaign).toMatchObject({ channel: "webpush", status: "enviando" });
    expect(result.campaign?.finishedAt).toBeNull();
  });

  it("uma falha na consulta a webpush_campaigns não derruba o relatório de uma campanha SMS", async () => {
    // webpush_campaigns is read with supabaseAdmin alongside the SMS/e-mail/voice lookups
    // (Promise.all). A permission-denied (or any other) error on that one lookup must not
    // throw for the other channels — this pins that isolation.
    const fake = createFakeDb();
    fake.rows("sms_campaigns").push({
      id: "sms-1",
      tenant_id: "t1",
      name: "Campanha SMS",
      content: "Olá",
      route: "short",
      status: "enviado",
      total_count: 10,
      sent_count: 9,
      deduplicated_count: 0,
      failed_count: 1,
      scheduled_at: "2026-11-05T10:00:00.000Z",
      created_at: "2026-11-05T09:00:00.000Z",
      updated_at: "2026-11-05T10:05:00.000Z",
      recipients: [],
      last_error: null,
    });
    adminFake.db.reset();
    adminFake.db.failNext("webpush_campaigns", "select", "permission denied for table webpush_campaigns");

    const result = await getCampaignReportDetailsFor(
      { supabase: fake.client },
      { campaignId: "sms-1", limit: 500 },
    );

    expect(result.campaign).toMatchObject({ channel: "sms", name: "Campanha SMS", status: "enviado" });
  });
});
