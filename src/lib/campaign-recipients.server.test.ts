import { describe, expect, it } from "vitest";
import {
  findAcceptedDeliveryKeys,
  resolveCampaignRecipients,
  resolveExternalListRecipients,
} from "./campaign-recipients.server";

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

describe("journey control group in campaigns (F3)", () => {
  const players = [1, 2, 3].map((i) => ({
    id: pid(i),
    tenant_id: TENANT,
    telefone: `+55119999900${i}0`,
    updated_at: "2026-10-01T00:00:00Z",
  }));
  const enrollments = [
    { tenant_id: TENANT, player_id: pid(2), is_holdout: true, status: "waiting" },
    { tenant_id: TENANT, player_id: pid(3), is_holdout: true, status: "exited" },
    { tenant_id: TENANT, player_id: pid(1), is_holdout: false, status: "active" },
  ];
  const inputs = players.map((player) => ({ phone: player.telefone }));

  it("keeps open control-group players out of a mass campaign", async () => {
    const db = fakeDb({ players, channel_consents: [], journey_enrollments: enrollments });
    const result = await resolveCampaignRecipients(db as never, TENANT, inputs);
    expect(result.resolved.map((r) => r.playerId)).toEqual([pid(1), pid(3)]);
    expect(result.unresolved).toEqual([{ phone: players[1].telefone, reason: "grupo_controle" }]);
  });

  it("still sends an individual message to a control-group player", async () => {
    const db = fakeDb({ players, channel_consents: [], journey_enrollments: enrollments });
    const result = await resolveCampaignRecipients(db as never, TENANT, [inputs[1]]);
    expect(result.resolved.map((r) => r.playerId)).toEqual([pid(2)]);
  });
});

describe("resolveExternalListRecipients (lista de números)", () => {
  it("leaves players out, honors revoked consent, reports invalid and repeated numbers", async () => {
    const db = fakeDb({
      players: [
        { id: pid(1), tenant_id: TENANT, telefone: "+5511988880001" },
        { id: pid(9), tenant_id: OTHER, telefone: "+5511988880003" },
      ],
      channel_consents: [
        { tenant_id: TENANT, channel: "sms", status: "revoked", subject: "5511988880002" },
      ],
    });
    const r = await resolveExternalListRecipients(
      db,
      TENANT,
      [
        "11988880001", // already a player here
        "+55 11 98888-0002", // revoked consent
        "11988880003", // player only in another tenant: still a lead here
        "(11) 98888-0004",
        "5511988880004", // same number again
        "999",
      ],
      { chunkSize: 2 },
    );
    expect(r.phones).toEqual(["+5511988880003", "+5511988880004"]);
    expect(r.duplicates).toBe(1);
    expect(r.unresolved).toEqual([
      { phone: "999", reason: "telefone_invalido" },
      { phone: "+5511988880001", reason: "ja_jogador" },
      { phone: "+5511988880002", reason: "sem_consentimento" },
    ]);
    const playerCalls = db.calls.filter((c) => c.table === "players");
    expect(Math.max(...playerCalls.map((c) => c.size))).toBeLessThanOrEqual(2);
  });
});
