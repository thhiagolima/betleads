import { afterEach, describe, expect, it } from "vitest";
import {
  buildFirstPartyClickUrl,
  classifyClickUserAgent,
  signClickToken,
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
