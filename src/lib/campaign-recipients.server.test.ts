import { describe, expect, it } from "vitest";
import { findAcceptedDeliveryKeys, resolveCampaignRecipients } from "./campaign-recipients.server";

type Row = Record<string, unknown>;
const TENANT = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const pid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Minimal PostgREST stand-in recording every `in(...)` filter size. */
function fakeDb(tables: Record<string, Row[]>) {
  const calls: Array<{ table: string; column: string; size: number }> = [];
  return {
    calls,
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = [];
      const builder: any = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters.push((row) => row[column] === value);
          return builder;
        },
        in: (column: string, values: unknown[]) => {
          calls.push({ table, column, size: values.length });
          filters.push((row) => values.includes(row[column]));
          return builder;
        },
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve({
            data: (tables[table] ?? []).filter((row) => filters.every((f) => f(row))),
            error: null,
          }).then(resolve, reject),
      };
      return builder;
    },
  };
}

describe("resolveCampaignRecipients (ENV-06)", () => {
  it("resolves by normalized phone in bounded chunks, never loading the whole table", async () => {
    const players = Array.from({ length: 10 }, (_, i) => ({
      id: pid(i + 1),
      tenant_id: TENANT,
      telefone: `+551199999000${i}`,
      updated_at: "2026-10-01T00:00:00Z",
    }));
    const db = fakeDb({ players, channel_consents: [] });
    // Mixed input formats for the same canonical numbers.
    const inputs = [
      ...players.slice(0, 5).map((p) => ({ phone: String(p.telefone).replace("+55", "") })),
      ...players.slice(5).map((p) => ({ phone: `55${String(p.telefone).slice(3)}` })),
    ];
    const r = await resolveCampaignRecipients(db, TENANT, inputs, { chunkSize: 3 });
    expect(r.resolved.map((x) => x.playerId)).toEqual(players.map((p) => p.id));
    expect(r.resolved[0].phone).toBe("+5511999990000");
    expect(r.unresolved).toEqual([]);
    const phoneCalls = db.calls.filter((c) => c.table === "players" && c.column === "telefone");
    expect(phoneCalls).toHaveLength(4); // ceil(10 / 3)
    expect(Math.max(...phoneCalls.map((c) => c.size))).toBeLessThanOrEqual(3);
  });

  it("reports each unresolved recipient with its reason and keeps the order of the rest", async () => {
    const db = fakeDb({
      players: [
        { id: pid(1), tenant_id: TENANT, telefone: "+5511988880001", updated_at: "x" },
        { id: pid(2), tenant_id: TENANT, telefone: "+5511988880002", updated_at: "x" },
        { id: pid(9), tenant_id: OTHER, telefone: "+5511988880009", updated_at: "x" },
      ],
      channel_consents: [
        { tenant_id: TENANT, channel: "sms", status: "revoked", subject: "5511988880002" },
      ],
    });
    const r = await resolveCampaignRecipients(db, TENANT, [
      { phone: "11988880001" },
      { phone: "11988880002" }, // revoked consent
      { phone: "11988880009" }, // player exists, but in another tenant
      { phone: "12345" }, // invalid
      { phone: "11988880001" }, // same player again
    ]);
    expect(r.resolved).toEqual([{ phone: "+5511988880001", playerId: pid(1) }]);
    expect(r.unresolved).toEqual([
      { phone: "+5511988880002", reason: "sem_consentimento" },
      { phone: "+5511988880009", reason: "sem_cadastro" },
      { phone: "12345", reason: "telefone_invalido" },
    ]);
    expect(r.duplicates).toBe(1);
    expect(r.assignments.map((a) => a.reason)).toEqual([
      null,
      "sem_consentimento",
      "sem_cadastro",
      "telefone_invalido",
      null,
    ]);
  });

  it("honors a client playerId only when it belongs to the tenant", async () => {
    const db = fakeDb({
      players: [
        { id: pid(1), tenant_id: TENANT, telefone: "+5511977770001", updated_at: "x" },
        { id: pid(5), tenant_id: OTHER, telefone: "+5511977770005", updated_at: "x" },
      ],
      channel_consents: [],
    });
    const r = await resolveCampaignRecipients(db, TENANT, [
      { phone: "11977770001", playerId: pid(1) },
      { phone: "11977770005", playerId: pid(5) }, // foreign id → phone lookup → no player
    ]);
    expect(r.resolved).toEqual([{ phone: "+5511977770001", playerId: pid(1) }]);
    expect(r.unresolved).toEqual([{ phone: "+5511977770005", reason: "sem_cadastro" }]);
  });

  it("sends to the owned player's stored phone, never the client-supplied one (I7)", async () => {
    const db = fakeDb({
      players: [
        { id: pid(1), tenant_id: TENANT, telefone: "+5511977770001", updated_at: "x" },
        { id: pid(2), tenant_id: TENANT, telefone: null, updated_at: "x" },
      ],
      channel_consents: [],
    });
    const r = await resolveCampaignRecipients(db, TENANT, [
      { phone: "11900000000", playerId: pid(1) }, // attacker-chosen number
      { phone: "11911111111", playerId: pid(2) }, // player without a phone
    ]);
    expect(r.resolved).toEqual([{ phone: "+5511977770001", playerId: pid(1) }]);
    expect(r.unresolved).toEqual([{ phone: "11911111111", reason: "telefone_invalido" }]);
  });

  it("picks the most recently updated player when a phone is shared", async () => {
    const db = fakeDb({
      players: [
        { id: pid(1), tenant_id: TENANT, telefone: "+5511966660001", updated_at: "2026-01-01" },
        { id: pid(2), tenant_id: TENANT, telefone: "+5511966660001", updated_at: "2026-09-01" },
      ],
      channel_consents: [],
    });
    const r = await resolveCampaignRecipients(db, TENANT, [{ phone: "+55 (11) 96666-0001" }]);
    expect(r.resolved).toEqual([{ phone: "+5511966660001", playerId: pid(2) }]);
  });

  it("finds accepted delivery keys only among provider-accepted logs", async () => {
    const db = fakeDb({
      sms_send_logs: [
        { idempotency_key: "k1", status: "sent" },
        { idempotency_key: "k2", status: "error" },
        { idempotency_key: "k3", status: "delivered" },
      ],
    });
    const keys = await findAcceptedDeliveryKeys(db, ["k1", "k2", "k3", "k4"]);
    expect([...keys].sort()).toEqual(["k1", "k3"]);
  });
});
