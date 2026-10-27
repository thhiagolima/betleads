import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetActiveGroupStoreForTests,
  getActiveGroupId,
  setActiveGroupId,
  subscribeActiveGroup,
} from "./use-active-group";

// Store-level test (fix round 1, item 4): no jsdom/testing-library in this
// repo to render the hook itself, so this exercises the module-level store
// `useActiveGroup` is built on directly — the piece that makes switching the
// group update every subscribed component, not just the one that wrote it.
describe("active group store", () => {
  afterEach(() => __resetActiveGroupStoreForTests());

  it("has no active group id until one is set", () => {
    expect(getActiveGroupId()).toBeNull();
  });

  it("notifies every subscriber when the id is set, and the value reads back", () => {
    const first = vi.fn();
    const second = vi.fn();
    subscribeActiveGroup(first);
    subscribeActiveGroup(second);

    setActiveGroupId("group-1");

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(getActiveGroupId()).toBe("group-1");
  });

  it("stops notifying a subscriber once it unsubscribes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeActiveGroup(listener);

    setActiveGroupId("group-1");
    unsubscribe();
    setActiveGroupId("group-2");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getActiveGroupId()).toBe("group-2");
  });
});
