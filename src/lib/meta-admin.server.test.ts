// MB4-03: painel "Meta Ads por casa" (super admin) e alerta de teste.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

vi.mock("@/lib/meta.functions", () => ({
  readAllPages: async (
    page: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
  ) => {
    const rows: unknown[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await page(from, from + 999);
      if (error) throw new Error((error as { message: string }).message);
      const chunk = (data ?? []) as unknown[];
      rows.push(...chunk);
      if (chunk.length < 1000) return rows;
    }
  },
}));

const health = vi.hoisted(() => ({
  findings: [] as unknown[],
  checkMetaHealth: vi.fn(),
  reportMetaAlerts: vi.fn(async (..._args: unknown[]) => 1),
}));
vi.mock("@/lib/meta-health.server", () => ({
  checkMetaHealth: health.checkMetaHealth,
  reportMetaAlerts: health.reportMetaAlerts,
}));

const sentry = vi.hoisted(() => ({ active: false }));
vi.mock("@/lib/observability/sentry.server", () => ({
  isServerSentryActive: () => sentry.active,
}));

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import {
  META_TEST_ALERT_MESSAGE,
  adminListMetaHousesFor,
  adminTestMetaAlertFor,
} from "./meta-admin.server";

const SUPER_ADMIN = "00000000-0000-4000-8000-0000000000dd";
const PLAIN_USER = "00000000-0000-4000-8000-0000000000ee";
const FORBIDDEN = "Acesso restrito à administração da plataforma.";

beforeEach(() => {
  fake.admin.reset();
  fake.admin.onRpc("is_super_admin", (args) => ({
    data: args._user_id === SUPER_ADMIN,
    error: null,
  }));
  health.findings = [];
  health.checkMetaHealth.mockReset();
  health.checkMetaHealth.mockImplementation(async () => health.findings);
  health.reportMetaAlerts.mockClear();
  sentry.active = false;
});

function seed() {
  const rows = fake.admin.rows;
  rows("tenants").push(
    { id: "t-a", nome: "Alfa" },
    { id: "t-b", nome: "Beta" },
    { id: "t-c", nome: "Gama" },
    { id: "t-none", nome: "Sem Meta" },
  );
  rows("meta_connections").push(
    { id: "c1", tenant_id: "t-a", status: "connected" },
    { id: "c2", tenant_id: "t-a", status: "error" },
    { id: "c3", tenant_id: "t-a", status: "disabled" },
    { id: "c4", tenant_id: "t-b", status: "connected" },
    // Só chave desconectada: não entra.
    { id: "c5", tenant_id: "t-none", status: "disabled" },
  );
  rows("meta_ad_accounts").push(
    {
      id: "a1",
      tenant_id: "t-a",
      selected: true,
      sync_status: "success",
      last_success_at: "2026-10-31T10:00:00Z",
    },
    {
      id: "a2",
      tenant_id: "t-a",
      selected: true,
      sync_status: "error",
      last_success_at: "2026-10-30T10:00:00Z",
    },
    {
      id: "a3",
      tenant_id: "t-a",
      selected: false,
      sync_status: "error",
      last_success_at: "2026-10-31T11:00:00Z",
    },
    // Casa só com conta (chave já desconectada): entra.
    { id: "a4", tenant_id: "t-c", selected: false, sync_status: "pending", last_success_at: null },
  );
  rows("meta_sync_runs").push(
    {
      id: "r1",
      tenant_id: "t-a",
      status: "completed",
      trigger_type: "scheduled",
      created_at: "2026-10-31T09:00:00Z",
      finished_at: "2026-10-31T09:05:00Z",
    },
    {
      id: "r2",
      tenant_id: "t-a",
      status: "running",
      trigger_type: "manual",
      created_at: "2026-10-31T11:00:00Z",
      finished_at: null,
    },
  );
}

describe("adminListMetaHousesFor", () => {
  it("só o super admin", async () => {
    await expect(adminListMetaHousesFor({ userId: PLAIN_USER })).rejects.toThrow(FORBIDDEN);
    expect(health.checkMetaHealth).not.toHaveBeenCalled();
  });

  it("linhas por casa com contagens, última leitura, último run e alertas; alertas primeiro", async () => {
    seed();
    health.findings = [
      {
        code: "house_stale",
        tenantId: "t-b",
        tenantName: "Beta",
        subjectId: "t-b",
        message: "Casa parada.",
        since: null,
      },
    ];
    const rows = await adminListMetaHousesFor({ userId: SUPER_ADMIN });
    expect(rows.map((row) => row.tenantId)).toEqual(["t-b", "t-a", "t-c"]);

    const [beta, alfa, gama] = rows;
    expect(beta.alerts).toEqual([{ code: "house_stale", message: "Casa parada." }]);
    expect(beta.connections).toEqual({ total: 1, connected: 1, error: 0 });
    expect(beta.latestRun).toBeNull();

    expect(alfa).toEqual({
      tenantId: "t-a",
      tenantName: "Alfa",
      connections: { total: 2, connected: 1, error: 1 },
      accounts: { selected: 2, total: 3, inError: 1 },
      lastSuccessAt: "2026-10-31T10:00:00Z",
      latestRun: {
        status: "running",
        triggerType: "manual",
        createdAt: "2026-10-31T11:00:00Z",
        finishedAt: null,
      },
      alerts: [],
    });

    expect(gama.tenantName).toBe("Gama");
    expect(gama.connections.total).toBe(0);
    expect(gama.accounts).toEqual({ selected: 0, total: 1, inError: 0 });
    expect(gama.lastSuccessAt).toBeNull();
  });

  it("sem nenhuma casa com Meta, lista vazia", async () => {
    expect(await adminListMetaHousesFor({ userId: SUPER_ADMIN })).toEqual([]);
  });
});

describe("adminTestMetaAlertFor", () => {
  it("só o super admin", async () => {
    await expect(adminTestMetaAlertFor({ userId: PLAIN_USER })).rejects.toThrow(FORBIDDEN);
    expect(health.reportMetaAlerts).not.toHaveBeenCalled();
  });

  it("manda um run_stuck de teste sem dedupe e diz se o Sentry está ativo", async () => {
    expect(await adminTestMetaAlertFor({ userId: SUPER_ADMIN })).toEqual({
      ok: true,
      sentry: false,
    });
    expect(health.reportMetaAlerts).toHaveBeenCalledWith(
      [expect.objectContaining({ code: "run_stuck", message: META_TEST_ALERT_MESSAGE })],
      { dedupe: false },
    );
    expect(META_TEST_ALERT_MESSAGE).toBe("Alerta de teste da integração Meta.");
    sentry.active = true;
    expect(await adminTestMetaAlertFor({ userId: SUPER_ADMIN })).toEqual({
      ok: true,
      sentry: true,
    });
  });
});

describe("meta-admin.functions", () => {
  it("cada server fn chama o *For por import dinâmico", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(process.cwd(), "src/lib/meta-admin.functions.ts"), "utf8");
    expect(source).toContain(
      'export const adminListMetaHouses = createServerFn({ method: "GET" })',
    );
    expect(source).toContain(
      'export const adminTestMetaAlert = createServerFn({ method: "POST" })',
    );
    expect(source).toContain("adminListMetaHousesFor(context)");
    expect(source).toContain("adminTestMetaAlertFor(context)");
  });
});
