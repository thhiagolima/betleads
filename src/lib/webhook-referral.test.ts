// ESCOPO_ORIGEM_UTM U0: UTMs e código de indicação que só vêm na URL de entrada.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("./conversion-attribution.server", () => ({
  attributeFromLastFirstPartyClick: vi.fn(async () => undefined),
}));
vi.mock("./journey-scanner.server", () => ({
  enrollPlayerOnEvent: vi.fn(async () => undefined),
  eventEntryTriggers: () => [],
}));

import { landingParams, processWebhookEvent, resolveReferralCode } from "./webhook-process.server";

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

function setup() {
  return fakeSupabase((op) => {
    if (op.table === "webhook_logs" && op.op === "insert") return { data: { id: "log-1" } };
    if (op.table === "players" && op.op === "select") return { data: null };
    if (op.table === "players" && op.op === "insert") return { data: { id: "player-1" } };
    return undefined;
  });
}

const cadastro = (extra: Record<string, unknown>) => ({
  time: Date.parse("2026-10-16T13:51:46.900Z"),
  user: USER,
  event: "register",
  ...extra,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-16T17:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("landingParams", () => {
  it("lê a query da 1ª landing válida e junta tracking.params", () => {
    expect(
      landingParams(
        {
          trackingContext: {
            landingUrl: "https://www.betgreen.io/?inviteCode=9618DEE99DEB&modal=register",
          },
        },
        { landing_url: "", params: { ref: "abc" } },
        {},
      ),
    ).toEqual({ inviteCode: "9618DEE99DEB", modal: "register", ref: "abc" });
  });

  it("ignora URL inválida e valor vazio", () => {
    expect(
      landingParams({}, { landing_url: "nao e url" }, { landingUrl: "https://x.com/?a=&b=1" }),
    ).toEqual({
      b: "1",
    });
    expect(landingParams({}, {}, {})).toEqual({});
  });
});

describe("resolveReferralCode", () => {
  it("inviteCode vence e vale mesmo com afiliado", () => {
    expect(resolveReferralCode({}, {}, {}, { inviteCode: "ABC" }, "aff-1")).toBe("ABC");
  });

  it("ref só conta sem afiliado (na 99bet o ref é o link do próprio afiliado)", () => {
    expect(resolveReferralCode({ ref: "39682054" }, {}, {}, {}, null)).toBe("39682054");
    expect(resolveReferralCode({}, {}, { ref: "jzKu0MC" }, {}, "afiliado@casa.com")).toBeNull();
    expect(resolveReferralCode({}, {}, { ref: "" }, {}, null)).toBeNull();
  });
});

describe("cadastro com origem só na URL de entrada", () => {
  it("grava as UTMs da landing e o código de indicação à parte", async () => {
    const { sb, ops } = setup();
    await processWebhookEvent(
      sb,
      TENANT,
      "cadastro",
      cadastro({
        tracking: {
          utm_source: "",
          landing_url: "https://casa.com/?utm_source=kwai&utm_campaign=black&inviteCode=XYZ123",
        },
      }),
    );
    const insert = ops.find((o) => o.table === "players" && o.op === "insert")?.payload ?? {};
    expect(insert).toMatchObject({ utm_source: "kwai", utm_campaign: "black" });
    expect(insert).not.toHaveProperty("referral_code");
    expect(insert).not.toHaveProperty("affiliate_id", "XYZ123");

    const referral = ops.find(
      (o) =>
        o.table === "players" && o.op === "update" && o.payload && "referral_code" in o.payload,
    );
    expect(referral?.payload).toEqual({ referral_code: "XYZ123" });
    expect(referral?.filters).toContainEqual(["is", "referral_code", null]);
  });

  it("campo explícito do payload vence a landing", async () => {
    const { sb, ops } = setup();
    await processWebhookEvent(
      sb,
      TENANT,
      "cadastro",
      cadastro({
        tracking: { utm_source: "ig", landing_url: "https://casa.com/?utm_source=kwai" },
      }),
    );
    const insert = ops.find((o) => o.table === "players" && o.op === "insert")?.payload ?? {};
    expect(insert).toMatchObject({ utm_source: "ig" });
  });

  it("erro ao gravar o código de indicação não derruba o cadastro", async () => {
    const { sb } = fakeSupabase((op) => {
      if (op.table === "webhook_logs" && op.op === "insert") return { data: { id: "log-1" } };
      if (op.table === "players" && op.op === "select") return { data: null };
      if (op.table === "players" && op.op === "insert") return { data: { id: "player-1" } };
      if (
        op.table === "players" &&
        op.op === "update" &&
        op.payload &&
        "referral_code" in op.payload
      ) {
        return { error: { message: 'column "referral_code" does not exist' } };
      }
      return undefined;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const res = await processWebhookEvent(
      sb,
      TENANT,
      "cadastro",
      cadastro({ tracking: { landing_url: "https://casa.com/?inviteCode=XYZ123" } }),
    );
    expect(await res.json()).toMatchObject({ ok: true });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
