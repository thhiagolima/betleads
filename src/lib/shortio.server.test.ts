import { describe, expect, it } from "vitest";
import {
  isShortioEligibleUrl,
  isProtectedDestination,
  deterministicToken,
  stripTrackingUrlTrailingPunctuation,
  withTrackingToken,
} from "./shortio.server";

describe("Short.io link tracking policy", () => {
  it("accepts public HTTP(S) URLs and rejects internal/short domains", () => {
    expect(isShortioEligibleUrl("https://site.example/cadastro")).toBe(true);
    expect(isShortioEligibleUrl("http://127.0.0.1/admin")).toBe(false);
    expect(isShortioEligibleUrl("https://localhost/test")).toBe(false);
    expect(isShortioEligibleUrl("http://[::1]/admin")).toBe(false);
    expect(isShortioEligibleUrl("https://go.example/abc", { domain: "go.example" })).toBe(false);
  });

  it("protects signed and temporary destinations from rewriting", () => {
    expect(isProtectedDestination("https://marca.com/login?token=secret")).toBe(true);
    expect(isProtectedDestination("https://marca.com/u/unsubscribe")).toBe(true);
    expect(isProtectedDestination("https://marca.com/oferta?utm_source=crm")).toBe(false);
  });

  it("derives the same dispatch token for a retry of one delivery", async () => {
    const context = {
      tenantId: "tenant-a",
      channel: "sms" as const,
      sourceType: "campaign" as const,
      sourceId: "campaign-a",
      recipientPlayerId: "player-a",
      deliveryKey: "delivery-a",
    };
    await expect(deterministicToken(context, 0)).resolves.toBe(
      await deterministicToken(context, 0),
    );
    expect(await deterministicToken(context, 1)).not.toBe(await deterministicToken(context, 0));
  });

  it("enforces the tenant destination allowlist", () => {
    expect(isShortioEligibleUrl("https://app.marca.com/x", { allowedHosts: ["marca.com"] })).toBe(
      true,
    );
    expect(isShortioEligibleUrl("https://other.example/x", { allowedHosts: ["marca.com"] })).toBe(
      false,
    );
  });

  it("preserves preexisting UTMs and adds the dedicated click id", () => {
    const url = new URL(
      withTrackingToken(
        "https://marca.com/a?utm_source=ads",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        { tenantId: "tenant", channel: "sms", sourceType: "campaign", sourceId: "camp-1" },
      ),
    );
    expect(url.searchParams.get("utm_source")).toBe("ads");
    expect(url.searchParams.get("utm_medium")).toBe("sms");
    expect(url.searchParams.get("utm_campaign")).toBe("camp-1");
    expect(url.searchParams.get("utm_content")).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(url.searchParams.get("bl_click_id")).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });

  it("does not replace creative metadata when adding the click id", () => {
    const url = new URL(
      withTrackingToken(
        "https://marca.com/a?utm_content=video-01&utm_id=ad-99&bl_click_id=stale",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        { tenantId: "tenant", channel: "email", sourceType: "journey", sourceId: "journey-1" },
      ),
    );
    expect(url.searchParams.get("utm_content")).toBe("video-01");
    expect(url.searchParams.get("utm_id")).toBe("ad-99");
    expect(url.searchParams.get("bl_click_id")).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });

  it("removes prose punctuation without damaging balanced URL parentheses", () => {
    expect(stripTrackingUrlTrailingPunctuation("https://marca.com/x, ")).toBe(
      "https://marca.com/x, ",
    );
    expect(stripTrackingUrlTrailingPunctuation("https://marca.com/x,")).toBe("https://marca.com/x");
    expect(stripTrackingUrlTrailingPunctuation("https://marca.com/(oferta)")).toBe(
      "https://marca.com/(oferta)",
    );
  });
});
