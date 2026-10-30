import { describe, expect, it } from "vitest";

import { updatedLabel } from "./updated-label";

// 28/10/2026 10:00 em São Paulo (UTC-3).
const NOW = new Date("2026-10-28T13:00:00Z");

describe("updatedLabel", () => {
  it("shows only the time for today in São Paulo", () => {
    expect(updatedLabel("2026-10-28T12:50:00Z", NOW)).toBe("Atualizado às 09:50");
    // 00:10 em SP já é hoje, embora seja 03:10 UTC.
    expect(updatedLabel("2026-10-28T03:10:00Z", NOW)).toBe("Atualizado às 00:10");
  });

  it("adds the São Paulo date when it is not today", () => {
    // 23:50 de 27/10 em SP, já 28/10 em UTC.
    expect(updatedLabel("2026-10-28T02:50:00Z", NOW)).toBe("Atualizado em 27/10 às 23:50");
    expect(updatedLabel("2026-09-03T15:05:00Z", NOW)).toBe("Atualizado em 03/09 às 12:05");
  });
});
