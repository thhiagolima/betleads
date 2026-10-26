import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { externalRecipientHash } from "./campaign-external-list";
import { bindExternalListDispatches } from "./external-list-binding.server";

type Row = Record<string, unknown>;
const TENANT = "00000000-0000-4000-8000-000000000001";
const PLAYER = "00000000-0000-4000-8000-0000000000aa";

/** Supports the update(...).eq/is/gte(...).select() chain used by the bind. */
function fakeDb(rows: Row[]) {
  return {
    from() {
      const filters: Array<(row: Row) => boolean> = [];
      let patch: Row = {};
      const builder: any = {
        update: (value: Row) => {
          patch = value;
          return builder;
        },
        eq: (column: string, value: unknown) => {
          filters.push((row) => row[column] === value);
          return builder;
        },
        is: (column: string, value: unknown) => {
          filters.push((row) => (row[column] ?? null) === value);
          return builder;
        },
        gte: (column: string, value: string) => {
          filters.push((row) => String(row[column]) >= value);
          return builder;
        },
        select: async () => {
          const hit = rows.filter((row) => filters.every((f) => f(row)));
          for (const row of hit) Object.assign(row, patch);
          return { data: hit.map((row) => ({ id: row.id })), error: null };
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

describe("bindExternalListDispatches", () => {
  it("binds recent campaign links sent to the same number to the new player", async () => {
    const hash = await externalRecipientHash(TENANT, "+5511987654321");
    const rows: Row[] = [
      {
        id: "a",
        tenant_id: TENANT,
        recipient_hash: hash,
        source_type: "campaign",
        recipient_player_id: null,
        created_at: "2026-10-20T10:00:00Z",
      },
      {
        id: "old",
        tenant_id: TENANT,
        recipient_hash: hash,
        source_type: "campaign",
        recipient_player_id: null,
        created_at: "2026-08-01T10:00:00Z",
      },
      {
        id: "other-tenant",
        tenant_id: "x",
        recipient_hash: hash,
        source_type: "campaign",
        recipient_player_id: null,
        created_at: "2026-10-20T10:00:00Z",
      },
      {
        id: "bound",
        tenant_id: TENANT,
        recipient_hash: hash,
        source_type: "campaign",
        recipient_player_id: "someone",
        created_at: "2026-10-20T10:00:00Z",
      },
    ];
    const bound = await bindExternalListDispatches(fakeDb(rows), {
      tenantId: TENANT,
      playerId: PLAYER,
      // Webhook format differs from the stored canonical one.
      phone: "(11) 98765-4321",
      now: new Date("2026-10-25T12:00:00Z"),
    });
    expect(bound).toBe(1);
    expect(rows.map((r) => r.recipient_player_id)).toEqual([PLAYER, null, null, "someone"]);
  });

  it("does nothing without a valid phone", async () => {
    const rows: Row[] = [];
    expect(
      await bindExternalListDispatches(fakeDb(rows), {
        tenantId: TENANT,
        playerId: PLAYER,
        phone: null,
      }),
    ).toBe(0);
  });
});
