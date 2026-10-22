// F0-04 — pre-call WhatsApp: a reply received by tenant A's session must only
// touch tenant A's leads, and a campaign must never send through a session
// that belongs to another tenant.

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({ tables: {} as Record<string, Row[]>, sends: 0 }));

vi.mock("@/integrations/supabase/client.server", () => {
  function from(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    let patch: Row | null = null;
    const run = () => {
      const hit = (state.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (patch) for (const r of hit) Object.assign(r, patch);
      return hit;
    };
    const builder: any = {
      select: () => builder,
      update: (p: Row) => ((patch = p), builder),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), builder),
      in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), builder),
      gte: () => builder,
      lte: () => builder,
      or: () => builder,
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve({ data: run(), error: null, count: run().length }).then(resolve, reject),
    };
    return builder;
  }
  return { supabaseAdmin: { from } };
});
vi.mock("./whatsapp-send.server", () => ({
  sendFlowBlock: vi.fn(async () => {
    state.sends++;
    return { ok: true };
  }),
}));

import { detectPrecallResponse, runPrecallDispatcher } from "./precall-dispatcher.server";
import { __resetHouseLinksCacheForTests } from "./house-links.server";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const PHONE = "5511999990001";

beforeEach(() => {
  state.sends = 0;
  __resetHouseLinksCacheForTests();
  state.tables = {
    precall_leads: [
      { id: "la", tenant_id: A, campaign_id: "ca", telefone_e164: PHONE, status: "enviado" },
      { id: "lb", tenant_id: B, campaign_id: "cb", telefone_e164: PHONE, status: "enviado" },
    ],
    precall_campaigns: [],
  };
});

describe("detectPrecallResponse", () => {
  it("only marks leads of the tenant whose session received the reply", async () => {
    await detectPrecallResponse(PHONE, "quero sim", A);
    const byId = Object.fromEntries(state.tables.precall_leads.map((l) => [l.id, l]));
    expect(byId.la.status).toBe("ligar_agora");
    expect(byId.lb.status).toBe("enviado");
    expect(byId.lb.resposta_texto).toBeUndefined();
  });

  it("does nothing without a tenant", async () => {
    await detectPrecallResponse(PHONE, "x", "");
    expect(state.tables.precall_leads.every((l) => l.status === "enviado")).toBe(true);
  });
});

describe("runPrecallDispatcher", () => {
  it("does not send through a session of another tenant", async () => {
    state.tables = {
      precall_campaigns: [
        {
          id: "ca",
          tenant_id: A,
          session_id: "sess-b",
          status: "rodando",
          delay_min_seconds: 1,
          delay_max_seconds: 1,
        },
      ],
      precall_leads: [
        {
          id: "la",
          tenant_id: A,
          campaign_id: "ca",
          player_id: null,
          telefone_e164: PHONE,
          status: "pendente",
        },
      ],
      precall_templates: [{ id: "t1", tenant_id: A, campaign_id: "ca", ordem: 0, content: "oi" }],
      whatsapp_sessions: [
        { id: "sess-b", tenant_id: B, instance_name: "b", name: "B", status: "connected" },
      ],
      players: [],
    };
    await runPrecallDispatcher();
    expect(state.sends).toBe(0);
  });
});

// Task 9 — house URL / quick links wired through a real dispatcher call site
// (not just the pure buildPlayerVariables/renderTemplate unit tests).
describe("runPrecallDispatcher — house links", () => {
  it("renderiza {link_login} com a URL rápida da casa", async () => {
    const sendFlowBlock = (await import("./whatsapp-send.server")).sendFlowBlock;
    state.tables = {
      tenants: [{ id: A, site_url: "https://x.com" }],
      tenant_quick_links: [{ tenant_id: A, key: "login", path: "/login" }],
      precall_campaigns: [
        {
          id: "ca",
          tenant_id: A,
          session_id: "sess-a",
          status: "rodando",
          delay_min_seconds: 1,
          delay_max_seconds: 1,
        },
      ],
      precall_leads: [
        {
          id: "la",
          tenant_id: A,
          campaign_id: "ca",
          player_id: null,
          telefone_e164: PHONE,
          status: "pendente",
        },
      ],
      precall_templates: [
        { id: "t1", tenant_id: A, campaign_id: "ca", ordem: 0, content: "Entre: {link_login}" },
      ],
      whatsapp_sessions: [
        { id: "sess-a", tenant_id: A, instance_name: "a", name: "A", status: "connected" },
      ],
      players: [],
    };
    await runPrecallDispatcher();
    expect(state.sends).toBe(1);
    const sentContent = vi.mocked(sendFlowBlock).mock.calls.at(-1)?.[0]?.content;
    expect(sentContent).toBe("Entre: https://x.com/login");
  });
});
