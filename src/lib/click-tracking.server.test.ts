import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildFirstPartyClickUrl,
  classifyClickUserAgent,
  resetClickTrackingConfigReportForTests,
  resolveClickTrackingSecret,
  signClickToken,
  validateClickTrackingConfig,
  verifyClickTokenSignature,
} from "./click-tracking.server";

const token = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secret = "test-secret-that-is-longer-than-thirty-two-characters";
const previousPublicUrl = process.env.PUBLIC_APP_URL;

afterEach(() => {
  if (previousPublicUrl === undefined) delete process.env.PUBLIC_APP_URL;
  else process.env.PUBLIC_APP_URL = previousPublicUrl;
});

describe("first-party click tracking", () => {
  it("signs one token deterministically and rejects tampering", async () => {
    const signature = await signClickToken(token, secret);
    await expect(verifyClickTokenSignature(token, signature, secret)).resolves.toBe(true);
    await expect(
      verifyClickTokenSignature("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", signature, secret),
    ).resolves.toBe(false);
  });

  it("builds a same-application redirect URL", async () => {
    process.env.PUBLIC_APP_URL = "https://app.example.test/";
    const url = new URL(await buildFirstPartyClickUrl(token, secret));
    expect(url.origin).toBe("https://app.example.test");
    expect(url.pathname).toBe(`/api/public/click/${token}`);
    await expect(verifyClickTokenSignature(token, url.searchParams.get("s"), secret)).resolves.toBe(
      true,
    );
  });

  it("separates previews and bots from human clicks", () => {
    expect(classifyClickUserAgent("WhatsApp/2.24 link preview").isHuman).toBe(false);
    expect(classifyClickUserAgent("Mozilla/5.0 Chrome/131 Safari/537.36")).toEqual({
      classification: "human",
      isHuman: true,
    });
    expect(classifyClickUserAgent(null).classification).toBe("unknown");
  });
});

describe("click tracking secret resolution", () => {
  const cron = "cron-secret-that-is-longer-than-thirty-two-chars";
  const explicitEnv = "click-secret-that-is-longer-than-thirty-two-chars";
  const previousClick = process.env.CLICK_TRACKING_SECRET;
  const previousCron = process.env.CRON_SECRET;

  afterEach(() => {
    if (previousClick === undefined) delete process.env.CLICK_TRACKING_SECRET;
    else process.env.CLICK_TRACKING_SECRET = previousClick;
    if (previousCron === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousCron;
    resetClickTrackingConfigReportForTests();
    vi.restoreAllMocks();
  });

  it("falls back to CRON_SECRET when CLICK_TRACKING_SECRET is empty", () => {
    expect(
      resolveClickTrackingSecret(undefined, { CLICK_TRACKING_SECRET: "", CRON_SECRET: cron }),
    ).toEqual({
      ok: true,
      secret: cron,
      source: "CRON_SECRET",
    });
  });

  it("treats a whitespace-only CLICK_TRACKING_SECRET as missing", () => {
    const resolved = resolveClickTrackingSecret(undefined, {
      CLICK_TRACKING_SECRET: "   	 ",
      CRON_SECRET: ` ${cron} `,
    });
    expect(resolved).toEqual({ ok: true, secret: cron, source: "CRON_SECRET" });
  });

  it("falls back to CRON_SECRET when CLICK_TRACKING_SECRET is not set", () => {
    expect(resolveClickTrackingSecret(undefined, { CRON_SECRET: cron })).toMatchObject({
      ok: true,
      source: "CRON_SECRET",
    });
  });

  it("fails when neither secret is set", () => {
    expect(
      resolveClickTrackingSecret(undefined, { CLICK_TRACKING_SECRET: " ", CRON_SECRET: "" }),
    ).toMatchObject({
      ok: false,
      source: null,
    });
  });

  it("rejects a short explicit CLICK_TRACKING_SECRET instead of silently switching secrets", () => {
    const resolved = resolveClickTrackingSecret(undefined, {
      CLICK_TRACKING_SECRET: "short",
      CRON_SECRET: cron,
    });
    expect(resolved).toMatchObject({ ok: false, source: "CLICK_TRACKING_SECRET" });
    expect(JSON.stringify(resolved)).not.toContain('short"');
  });

  it("rejects a short CRON_SECRET fallback", () => {
    expect(resolveClickTrackingSecret(undefined, { CRON_SECRET: "x".repeat(31) })).toMatchObject({
      ok: false,
      source: "CRON_SECRET",
    });
  });

  it("prefers a valid CLICK_TRACKING_SECRET over CRON_SECRET", () => {
    expect(
      resolveClickTrackingSecret(undefined, {
        CLICK_TRACKING_SECRET: explicitEnv,
        CRON_SECRET: cron,
      }),
    ).toEqual({ ok: true, secret: explicitEnv, source: "CLICK_TRACKING_SECRET" });
  });

  it("prefers an explicit argument over the environment", () => {
    expect(
      resolveClickTrackingSecret(secret, { CLICK_TRACKING_SECRET: explicitEnv }),
    ).toMatchObject({
      ok: true,
      secret,
      source: "explicit",
    });
  });

  it("signs with the CRON_SECRET fallback when CLICK_TRACKING_SECRET is empty", async () => {
    process.env.CLICK_TRACKING_SECRET = "";
    process.env.CRON_SECRET = cron;
    const signature = await signClickToken(token);
    expect(signature).toBe(await signClickToken(token, cron));
    await expect(verifyClickTokenSignature(token, signature)).resolves.toBe(true);
  });

  it("logs the invalid configuration once and keeps failing closed", async () => {
    process.env.CLICK_TRACKING_SECRET = "";
    delete process.env.CRON_SECRET;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(validateClickTrackingConfig()).toBe(false);
    await expect(signClickToken(token)).rejects.toThrow(/ao menos 32 caracteres/);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain(
      "CLICK_TRACKING_SECRET e CRON_SECRET ausentes",
    );
  });
});
