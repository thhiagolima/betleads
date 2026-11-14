import { describe, expect, it } from "vitest";

import type { OrphanReason } from "@/lib/marketing-overview";
import {
  ORPHAN_REASON_COPY,
  ORPHAN_REASON_SHORT,
  cadastros,
  orphanReasonLabel,
  orphanTotals,
  sortedReasons,
  unlinkedShare,
} from "./attribution-copy";

const REASONS: OrphanReason[] = [
  "live",
  "other_source",
  "macro",
  "id_not_found",
  "source_only",
  "ambiguous",
  "name_not_found",
  "pending",
];

describe("attribution-copy", () => {
  it("todo motivo da RPC tem texto, ação e rótulo curto", () => {
    for (const reason of REASONS) {
      expect(ORPHAN_REASON_COPY[reason].label.length).toBeGreaterThan(0);
      expect(ORPHAN_REASON_COPY[reason].action.length).toBeGreaterThan(0);
      expect(ORPHAN_REASON_SHORT[reason].length).toBeGreaterThan(0);
    }
  });

  it("motivo desconhecido ou ausente cai em 'Sem anúncio'", () => {
    expect(orphanReasonLabel("live")).toBe("Live");
    expect(orphanReasonLabel(null)).toBe("Sem anúncio");
    expect(orphanReasonLabel("novo_motivo")).toBe("Sem anúncio");
  });

  it("soma e ordena os motivos, tirando os zerados", () => {
    const rows = [
      { reason: "name_not_found" as const, players: 3, ftd: 1, revenue: 50 },
      { reason: "live" as const, players: 140, ftd: 85, revenue: 7542 },
      { reason: "pending" as const, players: 0, ftd: 0, revenue: 0 },
    ];
    expect(orphanTotals(rows)).toEqual({ players: 143, ftd: 86, revenue: 7592 });
    expect(sortedReasons(rows).map((row) => row.reason)).toEqual(["live", "name_not_found"]);
  });

  it("parte do investido sem cadastro ligado", () => {
    expect(unlinkedShare(4435, 6035)).toBe(73);
    expect(unlinkedShare(0, 6035)).toBeNull();
    expect(unlinkedShare(10, 0)).toBeNull();
    expect(unlinkedShare(200, 100)).toBe(100);
  });

  it("plural de cadastros", () => {
    expect(cadastros(1)).toBe("1 cadastro");
    expect(cadastros(1400)).toBe("1.400 cadastros");
  });
});
