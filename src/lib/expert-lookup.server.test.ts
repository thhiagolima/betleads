import { describe, expect, it, vi } from "vitest";
import { lookupExpertName, type SupabaseLike } from "./expert-lookup.server";

function makeSb(result: { data: unknown; error: { message: string } | null }) {
  const eqCalls: Array<[string, unknown]> = [];
  const maybeSingle = vi.fn().mockResolvedValue(result);
  const eq = vi.fn((column: string, value: unknown) => {
    eqCalls.push([column, value]);
    return { eq, maybeSingle };
  });
  const select = vi.fn(() => ({ eq, maybeSingle }));
  const from = vi.fn((_table: string) => ({ select }));
  const sb = { from } as unknown as SupabaseLike;
  return { sb, from, select, eq, maybeSingle, eqCalls };
}

describe("lookupExpertName", () => {
  it("returns null without querying for empty affiliate id", async () => {
    const { sb, from } = makeSb({ data: null, error: null });

    const result = await lookupExpertName(sb, "tenant-1", "   ");

    expect(result).toBeNull();
    expect(from).not.toHaveBeenCalled();
  });

  it("returns null without querying for null affiliate id", async () => {
    const { sb, from } = makeSb({ data: null, error: null });

    const result = await lookupExpertName(sb, "tenant-1", null);

    expect(result).toBeNull();
    expect(from).not.toHaveBeenCalled();
  });

  it("trims the affiliate id and scopes by tenant", async () => {
    const { sb, from, select, eqCalls } = makeSb({
      data: { experts: { nome: "Fulano" } },
      error: null,
    });

    await lookupExpertName(sb, "tenant-1", " AFF1 ");

    expect(from).toHaveBeenCalledWith("expert_affiliates");
    expect(select).toHaveBeenCalledWith("experts(nome)");
    expect(eqCalls).toContainEqual(["tenant_id", "tenant-1"]);
    expect(eqCalls).toContainEqual(["affiliate_id", "AFF1"]);
  });

  it("returns the expert name", async () => {
    const { sb } = makeSb({ data: { experts: { nome: "Fulano" } }, error: null });

    const result = await lookupExpertName(sb, "tenant-1", "AFF1");

    expect(result).toBe("Fulano");
  });

  it("returns the expert name when the embed comes back as an array", async () => {
    const { sb } = makeSb({ data: { experts: [{ nome: "Fulano" }] }, error: null });

    const result = await lookupExpertName(sb, "tenant-1", "AFF1");

    expect(result).toBe("Fulano");
  });

  it("returns null when no matching affiliate row exists", async () => {
    const { sb } = makeSb({ data: null, error: null });

    const result = await lookupExpertName(sb, "tenant-1", "AFF1");

    expect(result).toBeNull();
  });

  it("returns null on query error", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sb } = makeSb({ data: null, error: { message: "boom" } });

    const result = await lookupExpertName(sb, "tenant-1", "AFF1");

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
