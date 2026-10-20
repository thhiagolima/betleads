// AL1-06: a origem de aquisição do jogador é o primeiro toque.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("./conversion-attribution.server", () => ({
  attributeFromLastFirstPartyClick: vi.fn(async () => undefined),
}));
vi.mock("./journey-scanner.server", () => ({
  enrollPlayerOnEvent: vi.fn(async () => undefined),
  eventEntryTriggers: () => [],
}));

import {
  hasAcquisitionOrigin,
  inferAttributionProvider,
  processWebhookEvent,
} from "./webhook-process.server";

type Op = {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete";
  payload?: Record<string, unknown>;
  filters: Array<[string, ...unknown[]]>;
};
type Result = { data?: unknown; error?: unknown };

function fakeSupabase(handler: (op: Op) => Result | undefined) {
  const ops: Op[] = [];
  const from = (table: string) => {
    const op: Op = { table, op: "select", filters: [] };
    let registered = false;
    const resolve = (): Result => {
      if (!registered) {
        ops.push(op);
        registered = true;
      }
      return { data: null, error: null, ...(handler(op) ?? {}) };
    };
    const builder: Record<string, unknown> = {};
    for (const m of ["insert", "update", "upsert", "delete"] as const) {
      builder[m] = (payload?: Record<string, unknown>) => {
        op.op = m;
        op.payload = payload;
        return builder;
      };
    }
    builder.select = () => builder;
    for (const f of ["eq", "neq", "in", "is", "lt", "lte", "gt", "gte", "order", "limit"]) {
      builder[f] = (...args: unknown[]) => {
        op.filters.push([f, ...args]);
        return builder;
      };
    }
    builder.single = async () => resolve();
    builder.maybeSingle = async () => resolve();
    builder.then = (ok: (v: Result) => unknown, ko: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(ok, ko);
    return builder;
  };
  const sb = {
    from,
    rpc: vi.fn(async (name: string) => ({
      data: name === "claim_webhook_event" ? true : null,
      error: null,
    })),
  };
  return { sb: sb as unknown as SupabaseClient, ops };
}

const TENANT = "00000000-0000-0000-0000-00000000000b";
const USER = {
  id: "6ad25622df1ea51c6d1c802d",
  email: "jogador@example.com",
  phone: "27999990000",
  username: "jogador8b71816c",
  created_at: "2026-10-16T16:51:46.514Z",
  first_name: "Wenderson",
};
const AD_TRACKING = {
  utm_source: "ig",
  utm_medium: "paid",
  utm_content: "120255699527850054",
  utm_campaign: "120255698807120054",
};
const CRM_TRACKING = {
  utm_source: "betleads",
  utm_medium: "sms",
  utm_campaign: "reativacao-outubro",
};

function setup(origin: Record<string, unknown> | null) {
  return fakeSupabase((op) => {
    if (op.table === "webhook_logs" && op.op === "insert") return { data: { id: "log-1" } };
    if (op.table === "players" && op.op === "select") {
      const byId = op.filters.some(([f, column]) => f === "eq" && column === "id");
      return { data: byId ? origin : { id: "player-1" } };
    }
    if (op.table === "players" && op.op === "insert") return { data: { id: "player-1" } };
    return undefined;
  });
}

function playerUpdate(ops: Op[]) {
  return ops.find((o) => o.table === "players" && o.op === "update")?.payload ?? {};
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-16T17:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("AL1-06 primeiro toque", () => {
  it("um clique de SMS depois do cadastro não troca o anúncio que trouxe o jogador", async () => {
    const { sb, ops } = setup({ utm_source: "ig", utm_content: "120255699527850054" });
    await processWebhookEvent(sb, TENANT, "login", {
      time: Date.parse("2026-10-16T13:55:00.000Z"),
      user: USER,
      event: "login",
      tracking: CRM_TRACKING,
    });
    const update = playerUpdate(ops);
    expect(update).toHaveProperty("updated_at");
    expect(update).not.toHaveProperty("utm_source");
    expect(update).not.toHaveProperty("utm_campaign");
  });

  it("jogador sem origem recebe as UTMs do primeiro evento que as trouxer", async () => {
    const { sb, ops } = setup({ utm_source: null, utm_content: "  " });
    await processWebhookEvent(sb, TENANT, "login", {
      time: Date.parse("2026-10-16T13:55:00.000Z"),
      user: USER,
      event: "login",
      tracking: AD_TRACKING,
    });
    expect(playerUpdate(ops)).toMatchObject({
      utm_source: "ig",
      utm_content: "120255699527850054",
      utm_campaign: "120255698807120054",
    });
  });

  it("o cadastro grava a atribuição como pendente de reconciliação", async () => {
    const { sb, ops } = setup(null);
    await processWebhookEvent(sb, TENANT, "cadastro", {
      time: Date.parse("2026-10-16T13:51:46.900Z"),
      user: USER,
      event: "register",
      tracking: AD_TRACKING,
    });
    const attribution = ops.find((o) => o.table === "player_attributions" && o.op === "upsert");
    expect(attribution?.payload).toMatchObject({
      provider: "meta",
      match_status: "pending",
      utm_content: "120255699527850054",
    });
  });
});

describe("helpers", () => {
  it("hasAcquisitionOrigin ignora vazios", () => {
    expect(hasAcquisitionOrigin(null)).toBe(false);
    expect(hasAcquisitionOrigin({ utm_source: " ", utm_id: null })).toBe(false);
    expect(hasAcquisitionOrigin({ utm_campaign: "123" })).toBe(true);
  });

  it("inferAttributionProvider compara a origem exata", () => {
    const none = {
      fbclid: null,
      gclid: null,
      gbraid: null,
      wbraid: null,
      ttclid: null,
      msclkid: null,
      trackgram_click_id: null,
    };
    const utm = (source: string) => ({
      utm_source: source,
      utm_medium: null,
      utm_campaign: null,
      utm_content: null,
      utm_term: null,
      utm_id: null,
    });
    expect(inferAttributionProvider(utm("ig"), none)).toBe("meta");
    expect(inferAttributionProvider(utm("Facebook_Ads"), none)).toBe("meta");
    expect(inferAttributionProvider(utm("digital"), none)).toBe("digital");
    expect(inferAttributionProvider(utm("original"), none)).toBe("original");
    expect(inferAttributionProvider(utm(""), { ...none, fbclid: "x" })).toBe("meta");
  });
});
