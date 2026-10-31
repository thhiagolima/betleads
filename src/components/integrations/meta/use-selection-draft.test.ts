import { describe, expect, it } from "vitest";

import { selectionDiff } from "@/components/integrations/meta-connection-model";
import { reconcileDraft, selectionKey } from "./use-selection-draft";

const ids = (...values: string[]) => new Set(values);
const state = (base: string[], draft: string[]) => ({ base: ids(...base), draft: ids(...draft) });
const sorted = (set: ReadonlySet<string>) => [...set].sort();

describe("reconcileDraft", () => {
  it("is a no-op while the saved selection and rows do not change (polling)", () => {
    const current = state(["a"], ["a", "b"]);
    expect(reconcileDraft(current, ids("a"), ids("a", "b", "c"))).toBe(current);
  });

  it("follows the saved selection when there are no pending changes", () => {
    const next = reconcileDraft(state(["a"], ["a"]), ids("a", "c"), ids("a", "c"));
    expect(sorted(next.base)).toEqual(["a", "c"]);
    expect(sorted(next.draft)).toEqual(["a", "c"]);
  });

  it("replays this user's changes over another admin's adds and removes (no clobber)", () => {
    // Base a,b,c. Este usuário marcou d e desmarcou b. Outro admin salvou: tirou c, pôs e.
    const prev = state(["a", "b", "c"], ["a", "c", "d"]);
    const persisted = ids("a", "b", "e");
    const next = reconcileDraft(prev, persisted, ids("a", "b", "c", "d", "e"));
    expect(sorted(next.base)).toEqual(["a", "b", "e"]);
    expect(sorted(next.draft)).toEqual(["a", "d", "e"]);
    const diff = selectionDiff(persisted, next.draft);
    expect(diff.added).toEqual(["d"]);
    expect(diff.removed).toEqual(["b"]);
  });

  it("lands clean after the user's own save", () => {
    const next = reconcileDraft(state(["a"], ["a", "b"]), ids("a", "b"), ids("a", "b"));
    expect(selectionDiff(ids("a", "b"), next.draft).dirty).toBe(false);
  });

  it("prunes unsaved ticks whose row vanished (key disconnected) → not dirty", () => {
    // Salvo não mudou; a chave que alcançava b e c saiu, e as linhas sumiram.
    const prev = state(["a"], ["a", "b", "c"]);
    const persisted = ids("a");
    const next = reconcileDraft(prev, persisted, ids("a"));
    expect(next).not.toBe(prev);
    expect(sorted(next.draft)).toEqual(["a"]);
    expect(selectionDiff(persisted, next.draft).dirty).toBe(false);
  });

  it("keeps saved ids even without a row, and prunes after a merge too", () => {
    const next = reconcileDraft(state(["a"], ["a", "x"]), ids("a", "s"), ids("a"));
    expect(sorted(next.draft)).toEqual(["a", "s"]);
  });

  it("keeps an unsaved untick of a saved id", () => {
    const prev = state(["a", "b"], ["a"]);
    expect(reconcileDraft(prev, ids("a", "b"), ids("a", "b"))).toBe(prev);
  });
});

describe("selectionKey", () => {
  it("is order-independent", () => {
    expect(selectionKey(["b", "a"])).toBe(selectionKey(new Set(["a", "b"])));
  });
});
