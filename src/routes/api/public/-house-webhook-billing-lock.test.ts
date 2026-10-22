// Mensalidade Task 4 — the house's inbound webhook keeps accepting data while
// the house is locked for the monthly fee (no lost sign-ups or deposits).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  admin: null as unknown as ReturnType<typeof createFakeDb>,
  service: null as unknown as ReturnType<typeof createFakeDb>,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

const { processWebhookEvent } = vi.hoisted(() => ({ processWebhookEvent: vi.fn() }));
vi.mock("@/lib/webhook-process.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.service = createFakeDb();
  return { getServiceClient: () => fake.service.client, processWebhookEvent };
});

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import { __resetDemoTenantCacheForTests } from "@/lib/tenant-access.server";
import { Route } from "./webhook.$token.$evento";

type Handler = (input: {
  request: Request;
  params: { token: string; evento: string };
}) => Promise<Response>;
const POST = (Route as unknown as { options: { server: { handlers: Record<string, Handler> } } })
  .options.server.handlers.POST;

const TENANT = "00000000-0000-4000-8000-00000000a0a0";
const TOKEN = "house-token-locked";

beforeEach(() => {
  fake.admin.reset();
  fake.service.reset();
  __resetDemoTenantCacheForTests();
  vi.stubEnv("BILLING_ENFORCEMENT_ENABLED", "true");
  const tenant = {
    id: TENANT,
    status: "active",
    is_demo: false,
    webhook_token: TOKEN,
    webhook_secret: null,
    webhook_hmac_enforced: false,
    tenant_billing: { access_state: "locked_unpaid" },
  };
  fake.service.rows("tenants").push({ ...tenant });
  fake.admin.rows("tenants").push({ ...tenant });
  fake.admin.rows("tenant_billing").push({ tenant_id: TENANT, access_state: "locked_unpaid" });
  processWebhookEvent.mockReset();
  processWebhookEvent.mockResolvedValue(Response.json({ ok: true, evento: "cadastro" }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/public/webhook/$token/$evento on a house locked for the monthly fee", () => {
  it("accepts a sign-up event and hands it to processing", async () => {
    const payload = { id: "player-1", nome: "Jogador", telefone: "+5511999999999" };
    const response = await POST({
      request: new Request(`https://app.example.test/api/public/webhook/${TOKEN}/cadastro`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      params: { token: TOKEN, evento: "cadastro" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(processWebhookEvent).toHaveBeenCalledTimes(1);
    expect(processWebhookEvent).toHaveBeenCalledWith(
      fake.service.client,
      TENANT,
      "cadastro",
      payload,
    );
  });
});
