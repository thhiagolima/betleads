// Task 6 — demo tenant guard on AI features (askAi, generateEmailContent).
//
// For a demo tenant, the guard must throw DEMO_SEND_BLOCKED before the
// Lovable AI Gateway provider is created, before `generateText`/`fetch` is
// called, and before any `ai_logs` row is written. A normal tenant is the
// control: it reaches the provider and logs the result.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./sms-bulk.test-support";

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.db = createFakeDb();
  return { supabaseAdmin: fake.db.client };
});

// `getSupabase()` in ai.functions.ts builds its own client via createClient();
// point it at the same in-memory fake used for supabaseAdmin.
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => fake.db.client,
}));

const generateTextMock = vi.fn(async (..._args: any[]) => ({ text: "resposta da IA" }));
vi.mock("ai", () => ({
  generateText: (...args: any[]) => generateTextMock(...args),
}));

const gatewayModelMock = vi.fn(() => "model-handle");
const createLovableAiGatewayProviderMock = vi.fn((..._args: any[]) => gatewayModelMock);
vi.mock("./ai-gateway", () => ({
  createLovableAiGatewayProvider: (...args: any[]) => createLovableAiGatewayProviderMock(...args),
}));

import { __resetDemoTenantCacheForTests } from "./tenant-access.server";
import { askAiFor } from "./ai.functions";
import { generateEmailContentFor } from "./email-ai.functions";

const NORMAL = "00000000-0000-4000-8000-000000000001";
const DEMO = "00000000-0000-4000-8000-000000000002";

let fetchMock: ReturnType<typeof vi.fn>;

function fakeContext(tenantId: string | null) {
  fake.db.onRpc("current_tenant_id", () => ({ data: tenantId, error: null }));
  return { supabase: fake.db.client as any };
}

function installFetch() {
  fetchMock = vi.fn(async () =>
    Response.json({
      choices: [
        {
          message: {
            tool_calls: [
              {
                function: {
                  name: "email_copy",
                  arguments: JSON.stringify({
                    assunto: "Oi",
                    preheader: "Pre",
                    titulo: "Titulo",
                    texto: "Texto",
                    cta: "Ir",
                  }),
                },
              },
            ],
          },
        },
      ],
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
}

const emailInput = {
  gatilho: "Reativação",
  beneficio: "",
  tom: "amigavel" as const,
  link: "",
  cupom: "",
  modelo: "simples",
};

beforeEach(() => {
  fake.db.reset();
  __resetDemoTenantCacheForTests();
  fake.db
    .rows("tenants")
    .push({ id: NORMAL, status: "active", is_demo: false }, { id: DEMO, status: "active", is_demo: true });
  vi.stubEnv("LOVABLE_API_KEY", "lovable-test-key");
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SECRET_KEY", "secret-test-key");
  generateTextMock.mockClear();
  createLovableAiGatewayProviderMock.mockClear();
  gatewayModelMock.mockClear();
  installFetch();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("askAi (src/lib/ai.functions.ts)", () => {
  it("blocks a demo tenant: DEMO_SEND_BLOCKED, no provider call, no ai_logs row", async () => {
    await expect(askAiFor({ pergunta: "Quem é VIP?" }, fakeContext(DEMO))).rejects.toMatchObject({
      code: "DEMO_SEND_BLOCKED",
    });
    expect(createLovableAiGatewayProviderMock).not.toHaveBeenCalled();
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(fake.db.rows("ai_logs")).toEqual([]);
  });

  it("control: a normal tenant reaches the provider and logs the answer", async () => {
    const r = await askAiFor({ pergunta: "Quem é VIP?" }, fakeContext(NORMAL));
    expect(r).toMatchObject({ resposta: "resposta da IA", error: false });
    expect(createLovableAiGatewayProviderMock).toHaveBeenCalledTimes(1);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(fake.db.rows("ai_logs")).toHaveLength(1);
    expect(fake.db.rows("ai_logs")[0]).toMatchObject({ tenant_id: NORMAL });
  });

  it("fails closed when the tenant lookup errors (no provider call)", async () => {
    fake.db.failNext("tenants", "select", "connection reset");
    await expect(askAiFor({ pergunta: "Quem é VIP?" }, fakeContext(NORMAL))).rejects.toThrow();
    expect(createLovableAiGatewayProviderMock).not.toHaveBeenCalled();
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});

describe("generateEmailContent (src/lib/email-ai.functions.ts)", () => {
  it("blocks a demo tenant: DEMO_SEND_BLOCKED, no fetch to the AI gateway", async () => {
    await expect(generateEmailContentFor(emailInput, fakeContext(DEMO))).rejects.toMatchObject({
      code: "DEMO_SEND_BLOCKED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("control: a normal tenant reaches the AI gateway", async () => {
    const r = await generateEmailContentFor(emailInput, fakeContext(NORMAL));
    expect(r).toMatchObject({ assunto: "Oi", cta: "Ir" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the tenant lookup errors (no fetch)", async () => {
    fake.db.failNext("tenants", "select", "connection reset");
    await expect(generateEmailContentFor(emailInput, fakeContext(NORMAL))).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
