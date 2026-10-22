import { describe, expect, it, vi } from "vitest";

import {
  computeHouseSiteDirty,
  prepareQuickLinkDrafts,
  QUICK_LINKS_INCOMPLETE_ERROR,
} from "./house-site-section";
import {
  COMPOSER_OPTIONS_QUERY_KEY,
  HOUSE_CONFIG_QUERY_KEY,
  HOUSE_SETUP_STATUS_QUERY_KEY,
  invalidateHouseConfigQueries,
} from "./house-config-query";
import { suggestedQuickLinks } from "@/lib/house-config";

const saved = {
  siteUrl: "https://suacasa.bet.br",
  quickLinks: [{ id: "a", label: "Login", path: "/login" }],
};

describe("computeHouseSiteDirty", () => {
  it("is clean when the typed URL normalizes to the saved one and links are unchanged", () => {
    expect(
      computeHouseSiteDirty(
        { siteUrl: "suacasa.bet.br/", links: [{ id: "a", label: "Login", path: "/login" }] },
        saved,
      ),
    ).toEqual({ site: false, links: false });
  });

  it("flags a changed site URL", () => {
    expect(
      computeHouseSiteDirty(
        { siteUrl: "https://outra.bet.br", links: [{ id: "a", label: "Login", path: "/login" }] },
        saved,
      ).site,
    ).toBe(true);
  });

  it("does not try to save an empty URL", () => {
    expect(computeHouseSiteDirty({ siteUrl: "  ", links: [] }, { siteUrl: null, quickLinks: [] })).toEqual({
      site: false,
      links: false,
    });
  });

  it("flags renamed, added or removed links (and unsaved suggestions)", () => {
    expect(
      computeHouseSiteDirty({ siteUrl: "", links: [{ id: "a", label: "Entrar", path: "/login" }] }, saved).links,
    ).toBe(true);
    expect(
      computeHouseSiteDirty(
        {
          siteUrl: "",
          links: [
            { id: "a", label: "Login", path: "/login" },
            { label: "Promo", path: "/promo" },
          ],
        },
        saved,
      ).links,
    ).toBe(true);
    expect(computeHouseSiteDirty({ siteUrl: "", links: [] }, saved).links).toBe(true);
  });

  it("does not count the untouched pre-filled suggestions as unsaved", () => {
    const none = { siteUrl: null, quickLinks: [] };
    expect(computeHouseSiteDirty({ siteUrl: "", links: suggestedQuickLinks() }, none).links).toBe(false);
    const edited = suggestedQuickLinks().map((l, i) => (i === 0 ? { ...l, path: "/entrar" } : l));
    expect(computeHouseSiteDirty({ siteUrl: "", links: edited }, none).links).toBe(true);
    expect(computeHouseSiteDirty({ siteUrl: "", links: suggestedQuickLinks().slice(1) }, none).links).toBe(true);
  });

  it("ignores fully blank rows when comparing", () => {
    expect(
      computeHouseSiteDirty(
        {
          siteUrl: "",
          links: [
            { id: "a", label: "Login", path: "/login" },
            { label: "", path: "" },
          ],
        },
        saved,
      ).links,
    ).toBe(false);
  });
});

describe("prepareQuickLinkDrafts", () => {
  it("drops fully blank rows and trims the rest", () => {
    expect(
      prepareQuickLinkDrafts([
        { label: " Login ", path: " /login " },
        { label: "", path: "" },
      ]),
    ).toEqual({ ok: true, links: [{ label: "Login", path: "/login" }] });
  });

  it("rejects a half-filled row with a pt-BR message", () => {
    expect(prepareQuickLinkDrafts([{ label: "Promo", path: "" }])).toEqual({
      ok: false,
      error: QUICK_LINKS_INCOMPLETE_ERROR,
    });
  });
});

describe("invalidateHouseConfigQueries", () => {
  it("invalidates the config, the composer options and the setup status", () => {
    const qc = { invalidateQueries: vi.fn() };
    invalidateHouseConfigQueries(qc);
    expect(qc.invalidateQueries.mock.calls.map((c) => c[0].queryKey)).toEqual([
      HOUSE_CONFIG_QUERY_KEY,
      COMPOSER_OPTIONS_QUERY_KEY,
      HOUSE_SETUP_STATUS_QUERY_KEY,
    ]);
  });
});
