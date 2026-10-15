import { describe, expect, it, vi } from "vitest";

import {
  canToggleJourneyExpress,
  toggleJourneyExpress,
  type JourneyEditorRole,
  type ToggleJourneyExpressDeps,
} from "./journey-express";

function deps(
  role: JourneyEditorRole | null,
  journey: { id: string; express: boolean; status: string } | null = {
    id: "j1",
    express: false,
    status: "active",
  },
) {
  return {
    role: vi.fn(async () => role),
    loadJourney: vi.fn(async () => journey),
    updateExpress: vi.fn(async () => undefined),
    requeue: vi.fn(async () => 3),
    audit: vi.fn(async () => undefined),
  } satisfies ToggleJourneyExpressDeps;
}

describe("canToggleJourneyExpress", () => {
  it.each([
    ["admin", true],
    ["gestor", true],
    ["super_admin", true],
    ["member", false],
    [null, false],
  ] as const)("%s -> %s", (role, allowed) => {
    expect(canToggleJourneyExpress(role)).toBe(allowed);
  });
});

describe("toggleJourneyExpress", () => {
  it("rejects members and users without a role, without touching the journey", async () => {
    for (const role of ["member", null] as const) {
      const d = deps(role);
      await expect(toggleJourneyExpress(d, true)).rejects.toThrow(/permissão/);
      expect(d.loadJourney).not.toHaveBeenCalled();
      expect(d.updateExpress).not.toHaveBeenCalled();
      expect(d.audit).not.toHaveBeenCalled();
    }
  });

  it("enables express for a gestor, requeues deferred items and audits", async () => {
    const d = deps("gestor");
    await expect(toggleJourneyExpress(d, true)).resolves.toEqual({
      ok: true,
      express: true,
      requeued: 3,
      changed: true,
    });
    expect(d.updateExpress).toHaveBeenCalledWith(true);
    expect(d.audit).toHaveBeenCalledWith({ from: false, to: true, requeued: 3 });
  });

  it("disabling does not requeue", async () => {
    const d = deps("admin", { id: "j1", express: true, status: "active" });
    const result = await toggleJourneyExpress(d, false);
    expect(result).toMatchObject({ express: false, requeued: 0, changed: true });
    expect(d.requeue).not.toHaveBeenCalled();
    expect(d.audit).toHaveBeenCalledWith({ from: true, to: false, requeued: 0 });
  });

  it("is a no-op when the value does not change", async () => {
    const d = deps("super_admin", { id: "j1", express: true, status: "paused" });
    expect(await toggleJourneyExpress(d, true)).toMatchObject({ changed: false });
    expect(d.updateExpress).not.toHaveBeenCalled();
    expect(d.audit).not.toHaveBeenCalled();
  });

  it("fails for an unknown journey", async () => {
    const d = deps("admin", null);
    await expect(toggleJourneyExpress(d, true)).rejects.toThrow("Jornada não encontrada.");
  });

  it("keeps the flag saved when the requeue fails", async () => {
    const d = deps("admin");
    d.requeue.mockRejectedValueOnce(new Error("rpc missing"));
    expect(await toggleJourneyExpress(d, true)).toMatchObject({ changed: true, requeued: 0 });
    expect(d.audit).toHaveBeenCalled();
  });
});
