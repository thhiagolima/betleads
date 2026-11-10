import { describe, expect, it } from "vitest";

import {
  deriveWebpushBillingMode,
  planWebpushBillingMode,
  type WebpushItemPrice,
  type WebpushItemPrices,
} from "./webpush-billing-mode";

const catalog = (unitPrice: number | null = 0.01): WebpushItemPrice => ({
  unitPrice,
  hasOverride: false,
});
const override = (unitPrice: number | null): WebpushItemPrice => ({ unitPrice, hasOverride: true });

const prices = (webpush: WebpushItemPrice, webpush_lead: WebpushItemPrice): WebpushItemPrices => ({
  webpush,
  webpush_lead,
});

describe("deriveWebpushBillingMode", () => {
  it("is 'ambos' when both items are charged", () => {
    expect(deriveWebpushBillingMode(prices(catalog(), catalog()))).toBe("ambos");
    expect(deriveWebpushBillingMode(prices(override(0.02), catalog()))).toBe("ambos");
  });

  it("is 'envio' when only the send is charged", () => {
    expect(deriveWebpushBillingMode(prices(catalog(), override(0)))).toBe("envio");
  });

  it("is 'lead' when only the subscription is charged", () => {
    expect(deriveWebpushBillingMode(prices(override(0), catalog()))).toBe("lead");
  });

  it("is null when nothing is charged (both 0 or no price configured)", () => {
    expect(deriveWebpushBillingMode(prices(override(0), override(0)))).toBeNull();
    expect(deriveWebpushBillingMode(prices(catalog(null), catalog(0)))).toBeNull();
  });
});

describe("planWebpushBillingMode", () => {
  it("'envio' from catalog prices pins the lead item at 0 and leaves the send alone", () => {
    expect(planWebpushBillingMode("envio", prices(catalog(), catalog()))).toEqual([
      { item: "webpush_lead", action: "set_zero" },
    ]);
  });

  it("'lead' from catalog prices pins the send item at 0", () => {
    expect(planWebpushBillingMode("lead", prices(catalog(), catalog()))).toEqual([
      { item: "webpush", action: "set_zero" },
    ]);
  });

  it("'ambos' clears the zero overrides so both go back to the catalog", () => {
    expect(planWebpushBillingMode("ambos", prices(override(0), override(0)))).toEqual([
      { item: "webpush", action: "clear" },
      { item: "webpush_lead", action: "clear" },
    ]);
  });

  it("switching 'envio' -> 'lead' clears one and zeroes the other", () => {
    expect(planWebpushBillingMode("lead", prices(catalog(), override(0)))).toEqual([
      { item: "webpush", action: "set_zero" },
      { item: "webpush_lead", action: "clear" },
    ]);
  });

  it("keeps a non-zero custom override of an item that stays on", () => {
    expect(planWebpushBillingMode("ambos", prices(override(0.02), override(0.005)))).toEqual([]);
    expect(planWebpushBillingMode("envio", prices(override(0.02), catalog()))).toEqual([
      { item: "webpush_lead", action: "set_zero" },
    ]);
  });

  it("is a no-op when the house is already in the mode", () => {
    expect(planWebpushBillingMode("envio", prices(catalog(), override(0)))).toEqual([]);
    expect(planWebpushBillingMode("lead", prices(override(0), override(0.03)))).toEqual([]);
  });

  it("pins an off item at 0 even when its catalog price is already 0", () => {
    expect(planWebpushBillingMode("envio", prices(catalog(), catalog(0)))).toEqual([
      { item: "webpush_lead", action: "set_zero" },
    ]);
  });

  it("clears an override with no price (null) when the item must be on", () => {
    expect(planWebpushBillingMode("ambos", prices(catalog(), override(null)))).toEqual([
      { item: "webpush_lead", action: "clear" },
    ]);
  });

  it("does not touch an on item that has no override, even if the catalog is 0", () => {
    // Nothing to clear: the server reports it back as still uncharged.
    expect(planWebpushBillingMode("ambos", prices(catalog(0), catalog()))).toEqual([]);
  });
});
