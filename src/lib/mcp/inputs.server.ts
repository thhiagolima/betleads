// Inputs shared by the finance and the operação MCP tools: `escopo` (casa,
// grupo or todas) and `periodo` ({preset} or {inicio, fim}). Both areas take
// the same shapes so Claude learns them once, and a period preset always maps
// through the panel's own `presetRange` (days in Brasília time), so "7d" in
// the MCP is the same window as "7d" in the finance panel.
import { z } from "zod";

import { presetRange } from "@/lib/finance/calc";
import { isoDate, periodPreset } from "@/lib/finance/finance-data.server";
import { dbUuid } from "@/lib/zod-helpers";

export const escopoInput = z.discriminatedUnion("tipo", [
  z.object({ tipo: z.literal("casa"), id: dbUuid() }),
  z.object({ tipo: z.literal("grupo"), id: dbUuid() }),
  z.object({ tipo: z.literal("todas") }),
]);
export type Escopo = z.infer<typeof escopoInput>;

export const periodoInput = z.object({
  preset: periodPreset.optional(),
  inicio: isoDate.optional(),
  fim: isoDate.optional(),
});
export type Periodo = z.infer<typeof periodoInput>;

/** The periodo's range and preset — "preset" (not "custom") maps through the
 * same `presetRange` the panel's period filter sends the server, so
 * `periodo.preset` always yields the same window. */
export function toRangeAndPreset(periodo: Periodo, now: Date) {
  if (periodo.preset && periodo.preset !== "custom") {
    return { range: presetRange(periodo.preset, now), preset: periodo.preset };
  }
  if (!periodo.inicio || !periodo.fim) {
    throw new Error("Informe o período: preset, ou início e fim.");
  }
  return { range: { from: periodo.inicio, to: periodo.fim }, preset: "custom" as const };
}
