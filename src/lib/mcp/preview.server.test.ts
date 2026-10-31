// MCP financeiro, Task 7: write actions with a server-side preview and a
// single-use confirmation code. Same createFakeDb stand-in and permission
// model as finance.functions.test.ts / read-tools.server.test.ts; the write
// gate (assertMcpCanWrite) and the demo guard run for real against the fake
// `tenants` rows. saveFinanceDaysFor is wrapped in a spy (real behavior) so
// the double-confirm test can count calls.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("../sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

vi.mock("@/lib/finance.functions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/finance.functions")>();
  return { ...actual, saveFinanceDaysFor: vi.fn(actual.saveFinanceDaysFor) };
});

import { saveFinanceDaysFor } from "@/lib/finance.functions";
import { __resetDemoTenantCacheForTests } from "@/lib/tenant-access.server";

import type { McpIdentity } from "./access.server";
import { sha256Hex } from "./crypto.server";
import { confirmPreview, createPreview } from "./preview.server";
import { createFakeDb } from "../sms-bulk.test-support";

const SUPER = "00000000-0000-4000-8000-0000000000aa";
const G1_MANAGER = "00000000-0000-4000-8000-0000000000bb";
const ADMIN_A = "00000000-0000-4000-8000-0000000000cc";
const GESTOR_A = "00000000-0000-4000-8000-0000000000dd";
const OTHER_ADMIN = "00000000-0000-4000-8000-0000000000ef";
const G1 = "00000000-0000-4000-8000-00000000a001";
const HOUSE_A = "00000000-0000-4000-8000-000000000101";
const DEMO = "00000000-0000-4000-8000-00000000d3d0";
const COST_1 = "00000000-0000-4000-8000-00000000c001";

const identity = (
  userId: string,
  level: "read" | "write" = "write",
  connectionId = "00000000-0000-4000-8000-00000000f001",
): McpIdentity => ({ userId, connectionId, clientId: "client-1", level });

const roles = () => fake.admin.rows("user_roles");
const hasRole = (user: unknown, tenant: unknown, role: string) =>
  roles().some((r) => r.user_id === user && r.tenant_id === tenant && r.role === role);
const groupHouses = (userId: string) => {
  const groups = fake.admin
    .rows("tenant_group_managers")
    .filter((m) => m.user_id === userId)
    .map((m) => m.group_id);
  return fake.admin
    .rows("tenant_group_tenants")
    .filter((link) => groups.includes(link.group_id))
    .map((link) => link.tenant_id);
};

const daily = () => fake.admin.rows("tenant_finance_daily");
const audits = () => fake.admin.rows("tenant_audit_logs");
const previews = () => fake.admin.rows("mcp_previews");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // 12:00 in São Paulo on 2026-10-24 (matches the other finance test files).
  vi.setSystemTime(new Date("2026-10-24T15:00:00Z"));
  __resetDemoTenantCacheForTests();
  fake.admin.reset();
  vi.mocked(saveFinanceDaysFor).mockClear();

  const isSuper = (u: unknown) => u === SUPER;
  const isGroupManager = (u: unknown, t: unknown) => groupHouses(String(u)).includes(t);
  fake.admin.onRpc("is_super_admin", ({ _user_id: u }) => ({ data: isSuper(u), error: null }));
  fake.admin.onRpc("finance_can_edit_values", ({ _user: u, _tenant: t }) => ({
    data: isSuper(u) || hasRole(u, t, "admin"),
    error: null,
  }));
  fake.admin.onRpc("finance_can_manage_goals", ({ _user: u, _tenant: t }) => ({
    data: isSuper(u) || isGroupManager(u, t),
    error: null,
  }));

  fake.admin
    .rows("tenants")
    .push(
      { id: HOUSE_A, nome: "Pixreals", status: "active", is_demo: false },
      { id: DEMO, nome: "Casa Demo", status: "active", is_demo: true },
    );
  fake.admin.rows("tenant_groups").push({ id: G1, nome: "Grupo 1", is_demo: false });
  fake.admin.rows("tenant_group_tenants").push({ group_id: G1, tenant_id: HOUSE_A });
  fake.admin.rows("tenant_group_managers").push({ group_id: G1, user_id: G1_MANAGER });
  roles().push(
    { id: "r1", user_id: ADMIN_A, tenant_id: HOUSE_A, role: "admin" },
    { id: "r2", user_id: GESTOR_A, tenant_id: HOUSE_A, role: "gestor" },
    { id: "r3", user_id: OTHER_ADMIN, tenant_id: HOUSE_A, role: "admin" },
    { id: "r4", user_id: ADMIN_A, tenant_id: DEMO, role: "admin" },
  );
  for (const user of [SUPER, G1_MANAGER, ADMIN_A, GESTOR_A, OTHER_ADMIN]) {
    fake.admin.rows("mcp_access").push({ user_id: user, level: "write" });
  }
  daily().push({ tenant_id: HOUSE_A, metric_date: "2026-10-15", ad_spend: 500, ggr: 12000 });
});

afterEach(() => {
  vi.useRealTimers();
});

const daysInput = (entries: unknown[]) => ({ tenantId: HOUSE_A, entries });

describe("lancamento_dias", () => {
  it("previews without writing, then confirms with an mcp audit row", async () => {
    const preview = await createPreview(
      identity(ADMIN_A),
      "lancamento_dias",
      daysInput([{ date: "2026-10-15", ggr: 12345 }]),
    );

    expect(preview.linhas).toEqual(["15/10 Pixreals — GGR: R$ 12.000,00 → R$ 12.345,00"]);
    expect(preview.avisos).toEqual(["Sobrescreve um valor existente"]);
    expect(preview.expira_em).toBe("2026-10-24T15:10:00.000Z");
    expect(daily()[0].ggr).toBe(12000);
    expect(audits()).toHaveLength(0);
    expect(previews()).toHaveLength(1);
    const codeHash = await sha256Hex(preview.codigo_confirmacao);
    expect(previews()[0].code_hash).toBe(codeHash);
    expect(JSON.stringify(previews()[0])).not.toContain(preview.codigo_confirmacao);

    const confirmed = await confirmPreview(identity(ADMIN_A), preview.codigo_confirmacao);
    expect(confirmed).toEqual({ ok: true, resultado: { changed: 1 } });
    expect(daily()[0].ggr).toBe(12345);
    expect(audits()).toHaveLength(1);
    expect(audits()[0].metadata).toEqual({
      origem: "mcp",
      connectionId: identity(ADMIN_A).connectionId,
      clientId: "client-1",
      previewCode: codeHash,
    });
    expect(previews()[0].confirmed_at).toBeTruthy();
    expect(previews()[0].result).toEqual({ changed: 1 });
  });

  it("warns when a value is cleared and shows an empty value as vazio", async () => {
    const preview = await createPreview(
      identity(ADMIN_A),
      "lancamento_dias",
      daysInput([
        { date: "2026-10-15", adSpend: null },
        { date: "2026-10-16", adSpend: 80 },
      ]),
    );
    expect(preview.linhas).toEqual([
      "15/10 Pixreals — Anúncios: R$ 500,00 → vazio",
      "16/10 Pixreals — Anúncios: vazio → R$ 80,00",
    ]);
    expect(preview.avisos).toEqual(["Vai apagar o valor de Anúncios de 15/10"]);
  });

  it.each([
    [
      "duplicated date",
      [
        { date: "2026-10-15", ggr: 1 },
        { date: "2026-10-15", ggr: 2 },
      ],
    ],
    ["future date", [{ date: "2026-10-25", ggr: 1 }]],
    [
      "32 entries",
      // 32 distinct past days: 2026-09-01 .. 2026-10-02.
      Array.from({ length: 32 }, (_, i) => ({
        date: new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10),
        ggr: i,
      })),
    ],
  ])("refuses a %s at preview and stores nothing", async (_label, entries) => {
    await expect(
      createPreview(identity(ADMIN_A), "lancamento_dias", daysInput(entries)),
    ).rejects.toThrow(/Entrada inválida/);
    expect(previews()).toHaveLength(0);
  });

  it("refuses at preview without permission", async () => {
    await expect(
      createPreview(
        identity(GESTOR_A),
        "lancamento_dias",
        daysInput([{ date: "2026-10-15", ggr: 1 }]),
      ),
    ).rejects.toThrow("Sem permissão");
    expect(previews()).toHaveLength(0);
  });
});

describe("ggr_mensal", () => {
  it("previews and confirms the monthly total", async () => {
    fake.admin
      .rows("tenant_finance_monthly_ggr")
      .push({ tenant_id: HOUSE_A, month: "2026-10-01", ggr: 1000, valid_through: "2026-10-10" });
    const preview = await createPreview(identity(ADMIN_A), "ggr_mensal", {
      tenantId: HOUSE_A,
      month: "2026-10",
      ggr: 2500.5,
      validThrough: "2026-10-20",
    });
    expect(preview.linhas).toEqual([
      "10/2026 Pixreals — GGR do mês: R$ 1.000,00 → R$ 2.500,50",
      "10/2026 Pixreals — Atualizado até: 10/10 → 20/10",
    ]);
    expect(preview.avisos).toEqual(["Sobrescreve um valor existente"]);
    expect(fake.admin.rows("tenant_finance_monthly_ggr")[0].ggr).toBe(1000);
    expect(audits()).toHaveLength(0);

    const confirmed = await confirmPreview(identity(ADMIN_A), preview.codigo_confirmacao);
    expect(confirmed.resultado).toEqual({ changed: true });
    expect(fake.admin.rows("tenant_finance_monthly_ggr")[0].ggr).toBe(2500.5);
    expect(audits()[0].metadata).toMatchObject({ origem: "mcp" });
  });
});

describe("custo", () => {
  it("previews and confirms a new other cost", async () => {
    const preview = await createPreview(identity(ADMIN_A), "custo", {
      tenantId: HOUSE_A,
      costDate: "2026-10-20",
      descricao: "Ferramenta",
      valor: 300,
    });
    expect(preview.linhas).toEqual(['20/10 Pixreals — Custo "Ferramenta": vazio → R$ 300,00']);
    expect(fake.admin.rows("tenant_finance_other_costs")).toHaveLength(0);

    const confirmed = await confirmPreview(identity(ADMIN_A), preview.codigo_confirmacao);
    expect(confirmed.resultado).toEqual({ id: expect.any(String) });
    expect(fake.admin.rows("tenant_finance_other_costs")).toHaveLength(1);
    expect(fake.admin.rows("tenant_finance_other_costs")[0]).toMatchObject({ valor: 300 });
    expect(audits()[0].metadata).toMatchObject({ origem: "mcp" });
  });
});

describe("exclusao_custo", () => {
  it("previews and confirms deleting an other cost", async () => {
    fake.admin.rows("tenant_finance_other_costs").push({
      id: COST_1,
      tenant_id: HOUSE_A,
      month: "2026-10-01",
      cost_date: "2026-10-05",
      descricao: "CRM",
      valor: 30,
      categoria: null,
      repeat_monthly: false,
      series_id: null,
    });
    const preview = await createPreview(identity(ADMIN_A), "exclusao_custo", {
      tenantId: HOUSE_A,
      id: COST_1,
    });
    expect(preview.linhas).toEqual(['05/10 Pixreals — Custo "CRM": R$ 30,00 → vazio']);
    expect(preview.avisos).toEqual(['Vai apagar o custo "CRM" de 05/10']);
    expect(fake.admin.rows("tenant_finance_other_costs")).toHaveLength(1);

    const confirmed = await confirmPreview(identity(ADMIN_A), preview.codigo_confirmacao);
    expect(confirmed.resultado).toEqual({ ok: true });
    expect(fake.admin.rows("tenant_finance_other_costs")).toHaveLength(0);
    expect(audits()[0].metadata).toMatchObject({ origem: "mcp" });
  });
});

describe("meta", () => {
  it("previews and confirms a goal (group manager)", async () => {
    fake.admin.rows("tenant_goals").push({
      tenant_id: HOUSE_A,
      metric: "deposits",
      valid_from: "2026-10-01",
      direction: "gte",
      daily_value: 1000,
    });
    const preview = await createPreview(identity(G1_MANAGER), "meta", {
      tenantId: HOUSE_A,
      metric: "deposits",
      direction: "gte",
      dailyValue: 1500,
    });
    expect(preview.linhas).toEqual([
      "A partir de 24/10 Pixreals — Meta diária de Depósitos totais (no mínimo): R$ 1.000,00 → R$ 1.500,00",
    ]);
    expect(fake.admin.rows("tenant_goals")).toHaveLength(1);

    const confirmed = await confirmPreview(identity(G1_MANAGER), preview.codigo_confirmacao);
    expect(confirmed.resultado).toEqual({ ok: true, validFrom: "2026-10-24" });
    expect(fake.admin.rows("tenant_goals")).toHaveLength(2);
    expect(audits()[0].metadata).toMatchObject({ origem: "mcp" });
  });

  it("refuses a house admin without goal permission at preview", async () => {
    await expect(
      createPreview(identity(ADMIN_A), "meta", {
        tenantId: HOUSE_A,
        metric: "ftds",
        direction: "gte",
        dailyValue: 3,
      }),
    ).rejects.toThrow("Sem permissão");
    expect(previews()).toHaveLength(0);
  });
});

describe("confirmation code", () => {
  const preview = () =>
    createPreview(
      identity(ADMIN_A),
      "lancamento_dias",
      daysInput([{ date: "2026-10-15", ggr: 12345 }]),
    );

  it("read-level identity is refused at preview and at confirm", async () => {
    await expect(
      createPreview(
        identity(ADMIN_A, "read"),
        "lancamento_dias",
        daysInput([{ date: "2026-10-15", ggr: 1 }]),
      ),
    ).rejects.toThrow("Seu acesso ao MCP é só leitura.");
    expect(previews()).toHaveLength(0);

    const { codigo_confirmacao } = await preview();
    await expect(confirmPreview(identity(ADMIN_A, "read"), codigo_confirmacao)).rejects.toThrow(
      "Seu acesso ao MCP é só leitura.",
    );
    // Level lowered in the DB after the preview: the token's level is stale.
    fake.admin.rows("mcp_access").find((row) => row.user_id === ADMIN_A)!.level = "read";
    await expect(confirmPreview(identity(ADMIN_A), codigo_confirmacao)).rejects.toThrow(
      "Seu acesso ao MCP é só leitura.",
    );
    expect(daily()[0].ggr).toBe(12000);
  });

  it("another user or another connection cannot use the code", async () => {
    const { codigo_confirmacao } = await preview();
    await expect(confirmPreview(identity(OTHER_ADMIN), codigo_confirmacao)).rejects.toThrow(
      "Código de confirmação inválido.",
    );
    await expect(
      confirmPreview(
        identity(ADMIN_A, "write", "00000000-0000-4000-8000-00000000f002"),
        codigo_confirmacao,
      ),
    ).rejects.toThrow("Código de confirmação inválido.");
    expect(daily()[0].ggr).toBe(12000);
  });

  it("expires after 10 minutes", async () => {
    const { codigo_confirmacao } = await preview();
    vi.setSystemTime(new Date("2026-10-24T15:10:00Z"));
    await expect(confirmPreview(identity(ADMIN_A), codigo_confirmacao)).rejects.toThrow(
      "Código de confirmação expirado. Gere uma nova prévia.",
    );
    expect(daily()[0].ggr).toBe(12000);
  });

  it("a second confirm returns ja_confirmada and writes nothing twice", async () => {
    const { codigo_confirmacao } = await preview();
    const first = await confirmPreview(identity(ADMIN_A), codigo_confirmacao);
    const second = await confirmPreview(identity(ADMIN_A), codigo_confirmacao);
    expect(first).toEqual({ ok: true, resultado: { changed: 1 } });
    expect(second).toEqual({ ok: true, resultado: { changed: 1 }, ja_confirmada: true });
    expect(saveFinanceDaysFor).toHaveBeenCalledTimes(1);
    expect(audits()).toHaveLength(1);
  });

  it("concurrent confirms apply once", async () => {
    const { codigo_confirmacao } = await preview();
    const results = await Promise.all([
      confirmPreview(identity(ADMIN_A), codigo_confirmacao),
      confirmPreview(identity(ADMIN_A), codigo_confirmacao),
    ]);
    expect(saveFinanceDaysFor).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.ja_confirmada)).toHaveLength(1);
  });

  it("refuses when the values changed since the preview", async () => {
    const { codigo_confirmacao } = await preview();
    daily()[0].ggr = 13000;
    await expect(confirmPreview(identity(ADMIN_A), codigo_confirmacao)).rejects.toThrow(
      "Os valores mudaram desde a prévia. Gere uma nova.",
    );
    expect(daily()[0].ggr).toBe(13000);
    expect(saveFinanceDaysFor).not.toHaveBeenCalled();
  });

  it("refuses when mcp_access was deleted after the preview", async () => {
    const { codigo_confirmacao } = await preview();
    const access = fake.admin.rows("mcp_access");
    access.splice(
      access.findIndex((row) => row.user_id === ADMIN_A),
      1,
    );
    await expect(confirmPreview(identity(ADMIN_A), codigo_confirmacao)).rejects.toThrow(
      "Seu acesso ao MCP foi revogado.",
    );
    expect(daily()[0].ggr).toBe(12000);
  });

  it("refuses when the permission was lost after the preview", async () => {
    const { codigo_confirmacao } = await preview();
    roles().splice(
      roles().findIndex((row) => row.id === "r1"),
      1,
    );
    await expect(confirmPreview(identity(ADMIN_A), codigo_confirmacao)).rejects.toThrow(
      "Sem permissão",
    );
    expect(daily()[0].ggr).toBe(12000);
  });

  it("an apply failure spends the code and is reported on a retry", async () => {
    const { codigo_confirmacao } = await preview();
    fake.admin.failNext("tenant_finance_daily", "upsert", "falha simulada");
    await expect(confirmPreview(identity(ADMIN_A), codigo_confirmacao)).rejects.toThrow(
      "falha simulada",
    );
    expect(previews()[0].result).toEqual({ erro: "falha simulada" });
    await expect(confirmPreview(identity(ADMIN_A), codigo_confirmacao)).rejects.toThrow(
      "Esta prévia já foi usada e falhou: falha simulada. Gere uma nova.",
    );
    expect(saveFinanceDaysFor).toHaveBeenCalledTimes(1);
  });
});

describe("house state", () => {
  it("refuses the demo house at preview", async () => {
    await expect(
      createPreview(identity(ADMIN_A), "lancamento_dias", {
        tenantId: DEMO,
        entries: [{ date: "2026-10-15", ggr: 1 }],
      }),
    ).rejects.toThrow("Ambiente de demonstração");
    expect(previews()).toHaveLength(0);
  });

  it("refuses a suspended house for its admin, allows it for the super admin", async () => {
    fake.admin.rows("tenants").find((row) => row.id === HOUSE_A)!.status = "suspended";
    await expect(
      createPreview(
        identity(ADMIN_A),
        "lancamento_dias",
        daysInput([{ date: "2026-10-15", ggr: 1 }]),
      ),
    ).rejects.toThrow("Casa suspensa ou cancelada: só leitura pelo MCP.");
    expect(previews()).toHaveLength(0);

    const preview = await createPreview(
      identity(SUPER),
      "lancamento_dias",
      daysInput([{ date: "2026-10-15", ggr: 1 }]),
    );
    const confirmed = await confirmPreview(identity(SUPER), preview.codigo_confirmacao);
    expect(confirmed.ok).toBe(true);
    expect(daily()[0].ggr).toBe(1);
  });
});
