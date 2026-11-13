import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

import { forEachMessageGroup } from "./short-brasil-callback.server";

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe("forEachMessageGroup (bulk lote)", () => {
  it("keeps statuses of the same message in lote order", async () => {
    const seen: string[] = [];
    await forEachMessageGroup(
      [
        { id: "m1", statusConfirmacao: "CONFIRMADO" },
        { id: "m2", statusConfirmacao: "CONFIRMADO" },
        { id: "m1", statusDescricao: "ENVIADA" },
      ],
      10,
      async (payload) => {
        await tick();
        seen.push(`${payload.id}:${payload.statusConfirmacao ?? payload.statusDescricao}`);
      },
    );
    expect(seen.filter((s) => s.startsWith("m1"))).toEqual(["m1:CONFIRMADO", "m1:ENVIADA"]);
    expect(seen).toHaveLength(3);
  });

  it("groups by delivery key when there is no message id", async () => {
    const order: string[] = [];
    await forEachMessageGroup(
      [
        { parceiroId: "k1", statusConfirmacao: "NAO_ENTREGUE" },
        { parceiroId: "k1", statusDescricao: "ENVIADA" },
      ],
      10,
      async (payload) => {
        await tick();
        order.push(String(payload.statusConfirmacao ?? payload.statusDescricao));
      },
    );
    expect(order).toEqual(["NAO_ENTREGUE", "ENVIADA"]);
  });

  it("never runs more than `concurrency` messages at once and processes every payload", async () => {
    let inFlight = 0;
    let peak = 0;
    const payloads = Array.from({ length: 50 }, (_, i) => ({ id: `m${i}` }));
    let done = 0;
    await forEachMessageGroup(payloads, 4, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
      done++;
    });
    expect(done).toBe(50);
    expect(peak).toBe(4);
  });

  it("does nothing for an empty lote", async () => {
    const apply = vi.fn(async () => undefined);
    await forEachMessageGroup([], 10, apply);
    expect(apply).not.toHaveBeenCalled();
  });
});
