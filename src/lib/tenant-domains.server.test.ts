// tenant-domains.server (Task 4): add/refresh/default/usages/remove/purge.
// Uses a small in-memory fake of the supabase query builder (see
// makeFakeSupabase below) instead of chained mocks, since the service makes
// several different shaped queries (select/insert/update/delete, eq/in/is,
// order/limit, single/maybeSingle).
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;

type UpdateLogEntry = { table: string; payload: Row; matchedIds: string[] };

function makeFakeSupabase(tables: Record<string, Row[]>, updateLog: UpdateLogEntry[] = []) {
  function from(table: string) {
    if (!tables[table]) tables[table] = [];

    let mode: "select" | "insert" | "update" | "delete" = "select";
    let insertPayload: Row | null = null;
    let updatePayload: Row | null = null;
    const filters: ((r: Row) => boolean)[] = [];
    let orderCol: string | null = null;
    let orderAscending = true;
    let limitN: number | null = null;
    let singleMode: "single" | "maybeSingle" | null = null;
    let selectCols: string[] | null = null;

    function applyFilters(rows: Row[]) {
      return rows.filter((r) => filters.every((f) => f(r)));
    }

    function project(row: Row): Row {
      if (!selectCols) return row;
      const out: Row = {};
      for (const col of selectCols) out[col] = row[col];
      return out;
    }

    function execute() {
      const rows = tables[table];

      if (mode === "insert") {
        const row: Row = {
          id: `id-${Math.random().toString(36).slice(2, 10)}`,
          created_at: new Date().toISOString(),
          ...insertPayload,
        };
        rows.push(row);
        return { data: project(row), error: null };
      }

      if (mode === "update") {
        const matched = applyFilters(rows);
        updateLog.push({
          table,
          payload: { ...updatePayload },
          matchedIds: matched.map((r) => r.id as string),
        });
        for (const r of matched) Object.assign(r, updatePayload);
        if (singleMode) {
          return matched.length === 1
            ? { data: project({ ...matched[0] }), error: null }
            : { data: null, error: { message: "not found", code: "PGRST116" } };
        }
        return { data: matched.map((r) => project({ ...r })), error: null };
      }

      if (mode === "delete") {
        const matched = applyFilters(rows);
        tables[table] = rows.filter((r) => !matched.includes(r));
        return { data: null, error: null };
      }

      // select
      let result = applyFilters(rows).map((r) => ({ ...r }));
      if (orderCol) {
        const col = orderCol;
        result = [...result].sort((a, b) => {
          const av = a[col] ?? "";
          const bv = b[col] ?? "";
          if (av < bv) return orderAscending ? -1 : 1;
          if (av > bv) return orderAscending ? 1 : -1;
          return 0;
        });
      }
      if (limitN != null) result = result.slice(0, limitN);
      result = result.map(project);

      if (singleMode === "single") {
        return result.length === 1
          ? { data: result[0], error: null }
          : { data: null, error: { message: "not found", code: "PGRST116" } };
      }
      if (singleMode === "maybeSingle") {
        return { data: result[0] ?? null, error: null };
      }
      return { data: result, error: null };
    }

    const builder: any = {
      select(cols?: string) {
        if (cols && cols.trim() !== "*") {
          selectCols = cols.split(",").map((c) => c.trim());
        } else {
          selectCols = null;
        }
        return builder;
      },
      insert(row: Row) {
        mode = "insert";
        insertPayload = row;
        return builder;
      },
      update(row: Row) {
        mode = "update";
        updatePayload = row;
        return builder;
      },
      delete() {
        mode = "delete";
        return builder;
      },
      eq(col: string, val: unknown) {
        filters.push((r) => r[col] === val);
        return builder;
      },
      neq(col: string, val: unknown) {
        filters.push((r) => r[col] !== val);
        return builder;
      },
      is(col: string, val: unknown) {
        filters.push((r) => (r[col] ?? null) === val);
        return builder;
      },
      ilike(col: string, pattern: string) {
        // Only exact (wildcard-free) patterns are used by the service.
        filters.push((r) => String(r[col] ?? "").toLowerCase() === pattern.toLowerCase());
        return builder;
      },
      in(col: string, vals: unknown[]) {
        filters.push((r) => vals.includes(r[col]));
        return builder;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        orderCol = col;
        orderAscending = opts?.ascending !== false;
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      single() {
        singleMode = "single";
        return builder;
      },
      maybeSingle() {
        singleMode = "maybeSingle";
        return builder;
      },
      then(onFulfilled: any, onRejected: any) {
        return Promise.resolve(execute()).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  return { from };
}

const mocks = vi.hoisted(() => ({
  createShortioDomain: vi.fn(),
  getShortioDomain: vi.fn(),
  findShortioDomainByHostname: vi.fn(),
  deleteShortioDomain: vi.fn(),
  createInfobipDomain: vi.fn(),
  getInfobipDomain: vi.fn(),
  requestInfobipVerification: vi.fn(),
  deleteInfobipDomain: vi.fn(),
  callOrder: [] as string[],
}));

let tables: Record<string, Row[]> = {};
let updateLog: UpdateLogEntry[] = [];

vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return makeFakeSupabase(tables, updateLog);
  },
}));

// Keep the real DomainProviderError class (so `instanceof` checks in the
// implementation keep working) and only replace the HTTP-calling functions.
vi.mock("@/lib/domain-providers/shortio-domains.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/domain-providers/shortio-domains.server")>();
  return {
    ...actual,
    createShortioDomain: mocks.createShortioDomain,
    getShortioDomain: mocks.getShortioDomain,
    findShortioDomainByHostname: mocks.findShortioDomainByHostname,
    deleteShortioDomain: mocks.deleteShortioDomain,
  };
});

vi.mock("@/lib/domain-providers/infobip-domains.server", () => ({
  createInfobipDomain: mocks.createInfobipDomain,
  getInfobipDomain: mocks.getInfobipDomain,
  requestInfobipVerification: mocks.requestInfobipVerification,
  deleteInfobipDomain: mocks.deleteInfobipDomain,
}));

import { DomainProviderError } from "@/lib/domain-providers/shortio-domains.server";
import {
  addTenantDomain,
  findDomainUsages,
  purgeTenantDomain,
  refreshTenantDomain,
  removeTenantDomain,
  setDefaultTenantDomain,
} from "./tenant-domains.server";
import {
  __resetProviderAccountsCacheForTests,
  DEFAULT_INFOBIP_ACCOUNT_ID,
} from "./provider-accounts.server";

/** A house without its own e-mail account uses the platform Infobip account. */
const DEFAULT_INFOBIP = expect.objectContaining({ id: DEFAULT_INFOBIP_ACCOUNT_ID });

const TENANT_A = "00000000-0000-4000-8000-00000000000a";
const TENANT_B = "00000000-0000-4000-8000-00000000000b";
const USER_ID = "00000000-0000-4000-8000-0000000000u1";

function seed(partial: Record<string, Row[]>) {
  tables = { tenant_domains: [], tenants: [], sms_campaigns: [], email_campaigns: [], email_senders: [], journeys: [], journey_steps: [], ...partial };
  updateLog = [];
}

function domainRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "dom-1",
    tenant_id: TENANT_A,
    kind: "shortener",
    hostname: "go.example.com",
    status: "pending",
    provider_domain_id: null,
    provider_state: null,
    dns_records: [],
    is_default: false,
    last_checked_at: null,
    verified_at: null,
    last_error: null,
    removed_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  mocks.createShortioDomain.mockReset();
  mocks.getShortioDomain.mockReset();
  mocks.findShortioDomainByHostname.mockReset();
  mocks.deleteShortioDomain.mockReset();
  mocks.createInfobipDomain.mockReset();
  mocks.getInfobipDomain.mockReset();
  mocks.requestInfobipVerification.mockReset();
  mocks.deleteInfobipDomain.mockReset();
  mocks.callOrder = [];
  seed({});
});

describe("addTenantDomain", () => {
  it("rejects a shortener hostname already owned by another tenant, without calling the provider", async () => {
    seed({
      tenants: [{ id: TENANT_A, site_url: null }],
      tenant_domains: [domainRow({ id: "other-1", tenant_id: TENANT_B, hostname: "go.example.com" })],
    });

    await expect(
      addTenantDomain({ tenantId: TENANT_A, kind: "shortener", rawHostname: "go.example.com", userId: USER_ID }),
    ).rejects.toThrow("Esse domínio já está em uso por outra conta");

    expect(mocks.createShortioDomain).not.toHaveBeenCalled();
  });

  it("rejects a shortener hostname equal to the house site_url host (Task 2 validator)", async () => {
    seed({ tenants: [{ id: TENANT_A, site_url: "https://suacasa.bet.br" }] });

    await expect(
      addTenantDomain({ tenantId: TENANT_A, kind: "shortener", rawHostname: "suacasa.bet.br", userId: USER_ID }),
    ).rejects.toThrow(/use um subdomínio/);

    expect(mocks.createShortioDomain).not.toHaveBeenCalled();
  });

  it.each(["shortener", "email"] as const)(
    "rejects a new %s hostname that already exists at the provider (no adoption, no row)",
    async (kind) => {
      seed({ tenants: [{ id: TENANT_A, site_url: null }] });
      const already = new DomainProviderError("ALREADY_EXISTS", 409, "already exists");
      mocks.createShortioDomain.mockRejectedValue(already);
      mocks.createInfobipDomain.mockRejectedValue(already);
      mocks.findShortioDomainByHostname.mockResolvedValue({
        providerDomainId: "shortio-other-project",
        providerState: "configured",
        status: "verified",
        dnsRecords: [],
      });
      mocks.getInfobipDomain.mockResolvedValue({
        providerDomainId: "infobip-other-project",
        providerState: "active",
        status: "verified",
        dnsRecords: [],
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      await expect(
        addTenantDomain({ tenantId: TENANT_A, kind, rawHostname: "superbanca.short.gy", userId: USER_ID }),
      ).rejects.toThrow("Esse domínio já está cadastrado no provedor.");

      expect(mocks.findShortioDomainByHostname).not.toHaveBeenCalled();
      expect(mocks.getInfobipDomain).not.toHaveBeenCalled();
      expect(tables.tenant_domains).toHaveLength(0);
      expect(warn.mock.calls.some((c) => String(c[0]).includes("not adopting"))).toBe(true);
      warn.mockRestore();
    },
  );

  it("re-adding a removed shortener with Short.io ALREADY_EXISTS adopts it via findShortioDomainByHostname", async () => {
    seed({
      tenants: [{ id: TENANT_A, site_url: null }],
      tenant_domains: [
        domainRow({
          id: "dom-1",
          hostname: "go.example.com",
          removed_at: "2026-01-01T00:00:00.000Z",
          status: "failed",
        }),
      ],
    });
    mocks.createShortioDomain.mockRejectedValue(
      new DomainProviderError("ALREADY_EXISTS", 409, "Short.io: already exists"),
    );
    mocks.findShortioDomainByHostname.mockResolvedValue({
      providerDomainId: "shortio-999",
      providerState: "configured",
      status: "verified",
      dnsRecords: [{ type: "CNAME", name: "go", value: "cname.short.io", verified: true }],
    });

    const result = await addTenantDomain({
      tenantId: TENANT_A,
      kind: "shortener",
      rawHostname: "go.example.com",
      userId: USER_ID,
    });

    expect(mocks.findShortioDomainByHostname).toHaveBeenCalledWith("go.example.com");
    expect(result.id).toBe("dom-1");
    expect(result.removed_at).toBeNull();
    expect(result.provider_domain_id).toBe("shortio-999");
    expect(result.status).toBe("verified");
    expect(tables.tenant_domains).toHaveLength(1);
  });

  it("adding an email domain creates it at Infobip and then requests verification", async () => {
    seed({});
    mocks.createInfobipDomain.mockImplementation(async () => {
      mocks.callOrder.push("create");
      return {
        providerDomainId: "infobip-1",
        providerState: "inactive",
        status: "pending",
        dnsRecords: [],
      };
    });
    mocks.requestInfobipVerification.mockImplementation(async () => {
      mocks.callOrder.push("verify");
    });

    const result = await addTenantDomain({
      tenantId: TENANT_A,
      kind: "email",
      rawHostname: "mail.example.com",
      userId: USER_ID,
    });

    expect(mocks.createInfobipDomain).toHaveBeenCalledWith("mail.example.com", DEFAULT_INFOBIP);
    expect(mocks.requestInfobipVerification).toHaveBeenCalledWith("mail.example.com", DEFAULT_INFOBIP);
    expect(mocks.callOrder).toEqual(["create", "verify"]);
    expect(result.status).toBe("pending");
    expect(result.kind).toBe("email");
  });

  it("rethrows a pt-BR error (raw provider text only in logs) and inserts no row on a provider failure", async () => {
    seed({ tenants: [{ id: TENANT_A, site_url: null }] });
    mocks.createShortioDomain.mockRejectedValue(
      new DomainProviderError("UNAVAILABLE", 500, "Short.io service unavailable"),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    let message = "";
    try {
      await addTenantDomain({ tenantId: TENANT_A, kind: "shortener", rawHostname: "go.example.com", userId: USER_ID });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe("O provedor está indisponível no momento. Tente novamente em alguns minutos.");
    expect(warn.mock.calls.some((c) => String(c[0]).includes("Short.io service unavailable"))).toBe(true);
    warn.mockRestore();

    expect(tables.tenant_domains).toHaveLength(0);
  });

  it.each([
    ["INVALID", 400, "O provedor recusou esse domínio. Confira se o nome está correto."],
    ["NOT_FOUND", 404, "Domínio não encontrado no provedor."],
    ["ALREADY_EXISTS", 409, "Esse domínio já está cadastrado no provedor."],
  ] as const)("maps provider %s to its pt-BR message", async (code, status, expected) => {
    seed({});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.createShortioDomain.mockRejectedValue(new DomainProviderError(code, status, "raw english"));
    // ALREADY_EXISTS for a hostname this tenant never had -> rejected, not adopted.

    await expect(
      addTenantDomain({ tenantId: TENANT_A, kind: "shortener", rawHostname: "go.example.com", userId: USER_ID }),
    ).rejects.toThrow(expected);
    warn.mockRestore();
  });

  it.each(["betleads.io", "mail.betleads.io", "BETLEADS.APP", "go.betleads.app"])(
    "rejects the reserved platform hostname %s without calling any provider",
    async (host) => {
      seed({});
      for (const kind of ["shortener", "email"] as const) {
        await expect(
          addTenantDomain({ tenantId: TENANT_A, kind, rawHostname: host, userId: USER_ID }),
        ).rejects.toThrow("Esse domínio é reservado da plataforma e não pode ser usado pela casa.");
      }
      expect(mocks.createShortioDomain).not.toHaveBeenCalled();
      expect(mocks.createInfobipDomain).not.toHaveBeenCalled();
      expect(mocks.findShortioDomainByHostname).not.toHaveBeenCalled();
      expect(mocks.getInfobipDomain).not.toHaveBeenCalled();
    },
  );

  it("rejects the env-derived CRM shortener (SHORTIO_DOMAIN) and PLATFORM_EMAIL_FROM domains", async () => {
    seed({});
    vi.stubEnv("SHORTIO_DOMAIN", "lk.crmlinks.com");
    vi.stubEnv("PLATFORM_EMAIL_FROM", "avisos@plataforma-mail.com");
    try {
      await expect(
        addTenantDomain({ tenantId: TENANT_A, kind: "shortener", rawHostname: "LK.crmlinks.com", userId: USER_ID }),
      ).rejects.toThrow(/reservado da plataforma/);
      await expect(
        addTenantDomain({ tenantId: TENANT_A, kind: "email", rawHostname: "plataforma-mail.com", userId: USER_ID }),
      ).rejects.toThrow(/reservado da plataforma/);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(mocks.createShortioDomain).not.toHaveBeenCalled();
    expect(mocks.createInfobipDomain).not.toHaveBeenCalled();
  });

  it("reactivates a removed shortener row for the same tenant instead of inserting a new one", async () => {
    seed({
      tenants: [{ id: TENANT_A, site_url: null }],
      tenant_domains: [
        domainRow({
          id: "dom-1",
          hostname: "go.example.com",
          removed_at: "2026-01-01T00:00:00.000Z",
          status: "failed",
          provider_domain_id: "old-id",
        }),
      ],
    });
    mocks.createShortioDomain.mockResolvedValue({
      providerDomainId: "shortio-new",
      providerState: "pending",
      status: "pending",
      dnsRecords: [],
    });

    const result = await addTenantDomain({
      tenantId: TENANT_A,
      kind: "shortener",
      rawHostname: "go.example.com",
      userId: USER_ID,
    });

    expect(result.id).toBe("dom-1");
    expect(result.removed_at).toBeNull();
    expect(result.provider_domain_id).toBe("shortio-new");
    expect(tables.tenant_domains).toHaveLength(1);
  });

  it("re-adding a removed email domain with Infobip ALREADY_EXISTS adopts it via getInfobipDomain", async () => {
    seed({
      tenant_domains: [
        domainRow({
          id: "dom-1",
          kind: "email",
          hostname: "mail.example.com",
          removed_at: "2026-01-01T00:00:00.000Z",
          status: "failed",
        }),
      ],
    });
    mocks.createInfobipDomain.mockRejectedValue(
      new DomainProviderError("ALREADY_EXISTS", 409, "Infobip: already exists"),
    );
    mocks.getInfobipDomain.mockResolvedValue({
      providerDomainId: "infobip-adopted",
      providerState: "active",
      status: "verified",
      dnsRecords: [],
    });

    const result = await addTenantDomain({
      tenantId: TENANT_A,
      kind: "email",
      rawHostname: "mail.example.com",
      userId: USER_ID,
    });

    expect(mocks.getInfobipDomain).toHaveBeenCalledWith("mail.example.com", DEFAULT_INFOBIP);
    expect(result.id).toBe("dom-1");
    expect(result.removed_at).toBeNull();
    expect(result.provider_domain_id).toBe("infobip-adopted");
    expect(result.status).toBe("verified");
  });

  it("still persists the row when create succeeds but requestInfobipVerification fails (non-fatal)", async () => {
    seed({});
    mocks.createInfobipDomain.mockResolvedValue({
      providerDomainId: "infobip-1",
      providerState: "inactive",
      status: "pending",
      dnsRecords: [],
    });
    mocks.requestInfobipVerification.mockRejectedValue(new Error("timeout solicitando verificação"));

    const result = await addTenantDomain({
      tenantId: TENANT_A,
      kind: "email",
      rawHostname: "mail.example.com",
      userId: USER_ID,
    });

    expect(result.id).toBeTruthy();
    expect(result.status).toBe("pending");
    expect(result.last_error).toBe("O provedor está indisponível no momento. Tente novamente em alguns minutos.");
    expect(tables.tenant_domains).toHaveLength(1);
  });
});

describe("addTenantDomain: same hostname as shortener and e-mail", () => {
  const pendingInfobip = {
    providerDomainId: "infobip-1",
    providerState: "inactive",
    status: "pending" as const,
    dnsRecords: [],
  };
  const pendingShortio = {
    providerDomainId: "shortio-1",
    providerState: "pending",
    status: "pending" as const,
    dnsRecords: [],
  };

  it("same tenant already has it as shortener: adding as e-mail creates a NEW e-mail row at Infobip", async () => {
    seed({
      tenants: [{ id: TENANT_A, site_url: null }],
      tenant_domains: [
        domainRow({ id: "short-1", kind: "shortener", hostname: "bravabet365.online", status: "verified", is_default: true }),
      ],
    });
    mocks.createInfobipDomain.mockResolvedValue(pendingInfobip);
    mocks.requestInfobipVerification.mockResolvedValue(undefined);

    const result = await addTenantDomain({
      tenantId: TENANT_A,
      kind: "email",
      rawHostname: "BravaBet365.online",
      userId: USER_ID,
    });

    expect(mocks.createInfobipDomain).toHaveBeenCalledWith("bravabet365.online", DEFAULT_INFOBIP);
    expect(mocks.getShortioDomain).not.toHaveBeenCalled();
    expect(result.id).not.toBe("short-1");
    expect(result.kind).toBe("email");
    expect(result.hostname).toBe("bravabet365.online");
    expect(tables.tenant_domains).toHaveLength(2);
    const shortener = tables.tenant_domains.find((r) => r.id === "short-1")!;
    expect(shortener.kind).toBe("shortener");
    expect(shortener.is_default).toBe(true);
  });

  it("same tenant already has it as e-mail: adding as shortener creates a NEW shortener row at Short.io", async () => {
    seed({
      tenants: [{ id: TENANT_A, site_url: null }],
      tenant_domains: [domainRow({ id: "mail-1", kind: "email", hostname: "go.example.com" })],
    });
    mocks.createShortioDomain.mockResolvedValue(pendingShortio);

    const result = await addTenantDomain({
      tenantId: TENANT_A,
      kind: "shortener",
      rawHostname: "go.example.com",
      userId: USER_ID,
    });

    expect(mocks.createShortioDomain).toHaveBeenCalledWith("go.example.com");
    expect(mocks.getInfobipDomain).not.toHaveBeenCalled();
    expect(result.id).not.toBe("mail-1");
    expect(result.kind).toBe("shortener");
    expect(tables.tenant_domains).toHaveLength(2);
  });

  it("another tenant has the hostname as e-mail: adding it as shortener is rejected without calling the provider", async () => {
    seed({
      tenants: [{ id: TENANT_A, site_url: null }],
      tenant_domains: [domainRow({ id: "mail-b", tenant_id: TENANT_B, kind: "email", hostname: "go.example.com" })],
    });

    await expect(
      addTenantDomain({ tenantId: TENANT_A, kind: "shortener", rawHostname: "go.example.com", userId: USER_ID }),
    ).rejects.toThrow("Esse domínio já está em uso por outra conta");
    expect(mocks.createShortioDomain).not.toHaveBeenCalled();
    expect(tables.tenant_domains).toHaveLength(1);
  });

  it("another tenant has a REMOVED row with the hostname (other kind): still rejected", async () => {
    seed({
      tenants: [{ id: TENANT_A, site_url: null }],
      tenant_domains: [
        domainRow({
          id: "short-b",
          tenant_id: TENANT_B,
          kind: "shortener",
          hostname: "go.example.com",
          removed_at: "2026-01-01T00:00:00.000Z",
        }),
      ],
    });

    await expect(
      addTenantDomain({ tenantId: TENANT_A, kind: "email", rawHostname: "go.example.com", userId: USER_ID }),
    ).rejects.toThrow("Esse domínio já está em uso por outra conta");
    expect(mocks.createInfobipDomain).not.toHaveBeenCalled();
  });

  it("an active row of the SAME kind and tenant is still just refreshed and returned", async () => {
    seed({
      tenants: [{ id: TENANT_A, site_url: null }],
      tenant_domains: [
        domainRow({ id: "short-1", kind: "shortener", hostname: "go.example.com" }),
        domainRow({ id: "mail-1", kind: "email", hostname: "go.example.com" }),
      ],
    });
    mocks.findShortioDomainByHostname.mockResolvedValue(pendingShortio);

    const result = await addTenantDomain({
      tenantId: TENANT_A,
      kind: "shortener",
      rawHostname: "go.example.com",
      userId: USER_ID,
    });

    expect(result.id).toBe("short-1");
    expect(mocks.createShortioDomain).not.toHaveBeenCalled();
    expect(tables.tenant_domains).toHaveLength(2);
  });

  it("a removed e-mail row is reactivated even when an active shortener row exists for the same hostname", async () => {
    seed({
      tenants: [{ id: TENANT_A, site_url: null }],
      tenant_domains: [
        domainRow({ id: "short-1", kind: "shortener", hostname: "go.example.com", status: "verified" }),
        domainRow({
          id: "mail-1",
          kind: "email",
          hostname: "go.example.com",
          removed_at: "2026-01-01T00:00:00.000Z",
        }),
      ],
    });
    mocks.createInfobipDomain.mockResolvedValue(pendingInfobip);
    mocks.requestInfobipVerification.mockResolvedValue(undefined);

    const result = await addTenantDomain({
      tenantId: TENANT_A,
      kind: "email",
      rawHostname: "go.example.com",
      userId: USER_ID,
    });

    expect(result.id).toBe("mail-1");
    expect(result.removed_at).toBeNull();
    expect(tables.tenant_domains).toHaveLength(2);
  });
});

describe("refreshTenantDomain", () => {
  it("promotes pending -> verified to default when no other verified default exists", async () => {
    seed({
      tenant_domains: [
        domainRow({ id: "dom-1", status: "pending", is_default: false, provider_domain_id: "shortio-1" }),
      ],
    });
    mocks.getShortioDomain.mockResolvedValue({
      providerDomainId: "shortio-1",
      providerState: "configured",
      status: "verified",
      dnsRecords: [{ type: "CNAME", name: "go", value: "cname.short.io", verified: true }],
    });

    const result = await refreshTenantDomain("dom-1");

    expect(result.status).toBe("verified");
    expect(result.is_default).toBe(true);
    expect(result.verified_at).toBeTruthy();
  });

  it("demotes verified -> pending on a default domain and promotes the oldest remaining verified one", async () => {
    seed({
      tenant_domains: [
        domainRow({
          id: "dom-1",
          status: "verified",
          is_default: true,
          verified_at: "2026-01-02T00:00:00.000Z",
          provider_domain_id: "shortio-1",
        }),
        domainRow({
          id: "dom-2",
          hostname: "go2.example.com",
          status: "verified",
          is_default: false,
          verified_at: "2026-01-01T00:00:00.000Z",
          provider_domain_id: "shortio-2",
        }),
      ],
    });
    mocks.getShortioDomain.mockResolvedValue({
      providerDomainId: "shortio-1",
      providerState: "pending",
      status: "pending",
      dnsRecords: [],
    });

    const result = await refreshTenantDomain("dom-1");

    expect(result.status).toBe("pending");
    expect(result.is_default).toBe(false);
    expect(result.verified_at).toBeNull();

    const dom2 = tables.tenant_domains.find((r) => r.id === "dom-2");
    expect(dom2?.is_default).toBe(true);
  });

  it("keeps status unchanged and records last_error/last_checked_at on a provider error", async () => {
    seed({
      tenant_domains: [
        domainRow({ id: "dom-1", status: "pending", provider_domain_id: "shortio-1", last_error: null }),
      ],
    });
    mocks.getShortioDomain.mockRejectedValue(new DomainProviderError("UNAVAILABLE", 500, "timeout"));

    const result = await refreshTenantDomain("dom-1");

    expect(result.status).toBe("pending");
    // Stored (and shown in the UI) in pt-BR; the raw "timeout" stays in logs.
    expect(result.last_error).toBe(
      "O provedor está indisponível no momento. Tente novamente em alguns minutos.",
    );
    expect(result.last_checked_at).toBeTruthy();
  });

  it("backfills a missing provider_domain_id via findShortioDomainByHostname", async () => {
    seed({
      tenant_domains: [domainRow({ id: "dom-1", hostname: "bmkt.click", status: "verified", provider_domain_id: null })],
    });
    mocks.findShortioDomainByHostname.mockResolvedValue({
      providerDomainId: "shortio-42",
      providerState: "configured",
      status: "verified",
      dnsRecords: [],
    });

    const result = await refreshTenantDomain("dom-1");

    expect(mocks.findShortioDomainByHostname).toHaveBeenCalledWith("bmkt.click");
    expect(result.provider_domain_id).toBe("shortio-42");
  });

  it("never promotes a removed domain to default, even when it refreshes into verified", async () => {
    seed({
      tenant_domains: [
        domainRow({
          id: "dom-1",
          status: "pending",
          is_default: false,
          provider_domain_id: "shortio-1",
          removed_at: "2026-01-01T00:00:00.000Z",
        }),
      ],
    });
    mocks.getShortioDomain.mockResolvedValue({
      providerDomainId: "shortio-1",
      providerState: "configured",
      status: "verified",
      dnsRecords: [],
    });

    const result = await refreshTenantDomain("dom-1");

    expect(result.status).toBe("verified");
    expect(result.is_default).toBe(false);
  });
});

describe("setDefaultTenantDomain", () => {
  it("rejects a non-verified domain", async () => {
    seed({ tenant_domains: [domainRow({ id: "dom-1", status: "pending" })] });

    await expect(setDefaultTenantDomain(TENANT_A, "dom-1")).rejects.toThrow(
      "Só domínios verificados podem ser padrão",
    );
  });

  it("clears the previous default before setting the new one (avoids the partial unique index)", async () => {
    seed({
      tenant_domains: [
        domainRow({ id: "dom-1", status: "verified", is_default: true }),
        domainRow({ id: "dom-2", hostname: "go2.example.com", status: "verified", is_default: false }),
      ],
    });

    await setDefaultTenantDomain(TENANT_A, "dom-2");

    const dom1 = tables.tenant_domains.find((r) => r.id === "dom-1");
    const dom2 = tables.tenant_domains.find((r) => r.id === "dom-2");
    expect(dom1?.is_default).toBe(false);
    expect(dom2?.is_default).toBe(true);

    // Prove the *order* of writes: the old default must be cleared before
    // the new one is set, so the partial unique index (one default per
    // tenant+kind) is never briefly violated.
    const clearIndex = updateLog.findIndex(
      (u) => u.matchedIds.includes("dom-1") && u.payload.is_default === false,
    );
    const setIndex = updateLog.findIndex(
      (u) => u.matchedIds.includes("dom-2") && u.payload.is_default === true,
    );
    expect(clearIndex).toBeGreaterThanOrEqual(0);
    expect(setIndex).toBeGreaterThan(clearIndex);
  });
});

describe("removeTenantDomain", () => {
  it("soft-removes the domain, clears is_default, promotes another verified domain, and never calls the provider", async () => {
    seed({
      tenant_domains: [
        domainRow({
          id: "dom-1",
          status: "verified",
          is_default: true,
          verified_at: "2026-01-02T00:00:00.000Z",
        }),
        domainRow({
          id: "dom-2",
          hostname: "go2.example.com",
          status: "verified",
          is_default: false,
          verified_at: "2026-01-01T00:00:00.000Z",
        }),
      ],
    });

    await removeTenantDomain(TENANT_A, "dom-1");

    const dom1 = tables.tenant_domains.find((r) => r.id === "dom-1");
    const dom2 = tables.tenant_domains.find((r) => r.id === "dom-2");
    expect(dom1?.removed_at).toBeTruthy();
    expect(dom1?.is_default).toBe(false);
    expect(dom2?.is_default).toBe(true);
    expect(mocks.deleteShortioDomain).not.toHaveBeenCalled();
    expect(mocks.deleteInfobipDomain).not.toHaveBeenCalled();
  });
});

describe("purgeTenantDomain", () => {
  it("rejects purging a domain that was not removed first", async () => {
    seed({ tenant_domains: [domainRow({ id: "dom-1", removed_at: null })] });

    await expect(purgeTenantDomain("dom-1")).rejects.toThrow(
      "Remova o domínio antes de apagá-lo no provedor",
    );
    expect(mocks.deleteShortioDomain).not.toHaveBeenCalled();
  });

  it("calls the provider delete and removes the row for a removed domain", async () => {
    seed({
      tenant_domains: [
        domainRow({ id: "dom-1", provider_domain_id: "shortio-1", removed_at: new Date().toISOString() }),
      ],
    });

    await purgeTenantDomain("dom-1");

    expect(mocks.deleteShortioDomain).toHaveBeenCalledWith("shortio-1");
    expect(tables.tenant_domains.find((r) => r.id === "dom-1")).toBeUndefined();
  });

  it("purging an email domain deletes it at Infobip by hostname", async () => {
    seed({
      tenant_domains: [
        domainRow({
          id: "dom-1",
          kind: "email",
          hostname: "mail.example.com",
          removed_at: new Date().toISOString(),
        }),
      ],
    });

    await purgeTenantDomain("dom-1");

    expect(mocks.deleteInfobipDomain).toHaveBeenCalledWith("mail.example.com", DEFAULT_INFOBIP);
  });

  it("refuses to purge a reserved platform domain", async () => {
    seed({
      tenant_domains: [
        domainRow({ id: "dom-1", kind: "email", hostname: "betleads.io", removed_at: new Date().toISOString() }),
      ],
    });

    await expect(purgeTenantDomain("dom-1")).rejects.toThrow(/reservado da plataforma/);
    expect(mocks.deleteInfobipDomain).not.toHaveBeenCalled();
    expect(tables.tenant_domains).toHaveLength(1);
  });

  it("maps a provider failure to the pt-BR message and keeps the row (logs the raw text instead)", async () => {
    seed({
      tenant_domains: [
        domainRow({
          id: "dom-1",
          provider_domain_id: "shortio-1",
          removed_at: new Date().toISOString(),
        }),
      ],
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.deleteShortioDomain.mockRejectedValue(
      new DomainProviderError("UNAVAILABLE", 500, "raw provider english"),
    );

    await expect(purgeTenantDomain("dom-1")).rejects.toThrow(
      "O provedor está indisponível no momento. Tente novamente em alguns minutos.",
    );
    expect(warn.mock.calls.some((c) => String(c[0]).includes("raw provider english"))).toBe(true);
    expect(tables.tenant_domains).toHaveLength(1);
    warn.mockRestore();
  });
});

describe("findDomainUsages", () => {
  it("finds scheduled sms/email campaigns and active journeys using a shortener domain", async () => {
    seed({
      tenant_domains: [domainRow({ id: "dom-1", kind: "shortener" })],
      sms_campaigns: [
        { id: "sms-1", name: "SMS agendado", tenant_id: TENANT_A, status: "agendada", short_domain_id: "dom-1" },
        { id: "sms-2", name: "SMS outro domínio", tenant_id: TENANT_A, status: "agendada", short_domain_id: "dom-other" },
      ],
      email_campaigns: [
        { id: "email-1", name: "Email agendado", tenant_id: TENANT_A, status: "agendada", short_domain_id: "dom-1" },
      ],
      journeys: [{ id: "journey-1", name: "Jornada ativa", tenant_id: TENANT_A, status: "active" }],
      journey_steps: [
        { id: "step-1", journey_id: "journey-1", tenant_id: TENANT_A, config: { short_domain_id: "dom-1" } },
      ],
    });

    const usages = await findDomainUsages(TENANT_A, "dom-1");

    expect(usages.campaigns).toEqual(
      expect.arrayContaining([
        { id: "sms-1", name: "SMS agendado" },
        { id: "email-1", name: "Email agendado" },
      ]),
    );
    expect(usages.campaigns).toHaveLength(2);
    expect(usages.journeys).toEqual([{ id: "journey-1", name: "Jornada ativa" }]);
  });

  it("for an email domain, finds campaigns/journeys through its senders (sender_id / config.sender_id)", async () => {
    seed({
      tenant_domains: [domainRow({ id: "dom-1", kind: "email", hostname: "mail.example.com" })],
      email_senders: [{ id: "sender-1", tenant_id: TENANT_A, domain_id: "dom-1" }],
      email_campaigns: [
        { id: "email-1", name: "Campanha remetente", tenant_id: TENANT_A, status: "agendada", sender_id: "sender-1" },
      ],
      journeys: [{ id: "journey-1", name: "Jornada email", tenant_id: TENANT_A, status: "active" }],
      journey_steps: [
        { id: "step-1", journey_id: "journey-1", tenant_id: TENANT_A, config: { sender_id: "sender-1" } },
      ],
    });

    const usages = await findDomainUsages(TENANT_A, "dom-1");

    expect(usages.campaigns).toEqual([{ id: "email-1", name: "Campanha remetente" }]);
    expect(usages.journeys).toEqual([{ id: "journey-1", name: "Jornada email" }]);
  });
});

describe("e-mail domains per provider account", () => {
  const OWN = "55555555-5555-4555-8555-555555555555";
  const OWN_ACCOUNT = expect.objectContaining({ id: OWN });
  // An extra 'env' account: same env credentials, its own id (no encryption needed).
  const ownAccountRow = {
    id: OWN,
    provider: "infobip",
    label: "Infobip casa A",
    channels: ["email"],
    credentials_source: "env",
    credentials_encrypted: null,
    config: {},
    status: "active",
  };
  const pendingInDns = {
    providerDomainId: "ib-own-1",
    providerState: "inactive",
    status: "pending",
    dnsRecords: [{ type: "TXT", name: "own._domainkey", value: "k=rsa", verified: false }],
  };

  beforeEach(() => __resetProviderAccountsCacheForTests());

  it("a domain added for a house on its own account is registered and recorded there", async () => {
    seed({
      provider_accounts: [ownAccountRow],
      tenant_channel_providers: [{ tenant_id: TENANT_A, channel: "email", provider_account_id: OWN }],
    });
    mocks.createInfobipDomain.mockResolvedValue(pendingInDns);

    await addTenantDomain({ tenantId: TENANT_A, kind: "email", rawHostname: "mail.example.com", userId: USER_ID });

    expect(mocks.createInfobipDomain).toHaveBeenCalledWith("mail.example.com", OWN_ACCOUNT);
    expect(tables.tenant_domains[0]).toMatchObject({ provider_account_id: OWN });
  });

  it("refresh after the house moved to its own account registers the domain there (pending: new DKIM) and removes it from the old one", async () => {
    seed({
      provider_accounts: [ownAccountRow],
      tenant_channel_providers: [{ tenant_id: TENANT_A, channel: "email", provider_account_id: OWN }],
      tenant_domains: [
        domainRow({
          kind: "email",
          hostname: "mail.example.com",
          status: "verified",
          verified_at: new Date().toISOString(),
          provider_account_id: null, // registered in the platform account
        }),
      ],
    });
    mocks.createInfobipDomain.mockResolvedValue(pendingInDns);

    const result = await refreshTenantDomain("dom-1");

    expect(mocks.createInfobipDomain).toHaveBeenCalledWith("mail.example.com", OWN_ACCOUNT);
    expect(mocks.requestInfobipVerification).toHaveBeenCalledWith("mail.example.com", OWN_ACCOUNT);
    expect(mocks.deleteInfobipDomain).toHaveBeenCalledWith("mail.example.com", DEFAULT_INFOBIP);
    expect(result.status).toBe("pending");
    expect(tables.tenant_domains[0]).toMatchObject({
      provider_account_id: OWN,
      provider_domain_id: "ib-own-1",
    });
  });

  it("refresh adopts the domain when the new account already has it", async () => {
    seed({
      provider_accounts: [ownAccountRow],
      tenant_channel_providers: [{ tenant_id: TENANT_A, channel: "email", provider_account_id: OWN }],
      tenant_domains: [domainRow({ kind: "email", hostname: "mail.example.com", provider_account_id: null })],
    });
    mocks.createInfobipDomain.mockRejectedValue(new DomainProviderError("ALREADY_EXISTS", 400, "exists"));
    mocks.getInfobipDomain.mockResolvedValue(pendingInDns);
    mocks.deleteInfobipDomain.mockRejectedValue(new DomainProviderError("UNAVAILABLE", 503, "down"));

    const result = await refreshTenantDomain("dom-1");

    expect(mocks.getInfobipDomain).toHaveBeenCalledWith("mail.example.com", OWN_ACCOUNT);
    // Removing it from the old account is best effort.
    expect(result.status).toBe("pending");
    expect(tables.tenant_domains[0]).toMatchObject({ provider_account_id: OWN });
  });

  it("purge deletes the domain from the account it is registered in, not the house's current one", async () => {
    seed({
      provider_accounts: [ownAccountRow],
      tenant_domains: [
        domainRow({
          kind: "email",
          hostname: "mail.example.com",
          removed_at: new Date().toISOString(),
          provider_account_id: OWN,
        }),
      ],
    });

    await purgeTenantDomain("dom-1");

    expect(mocks.deleteInfobipDomain).toHaveBeenCalledWith("mail.example.com", OWN_ACCOUNT);
  });
});
