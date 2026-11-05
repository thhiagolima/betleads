// Web push (OneSignal) — Task 5: pure validators and constants shared by
// server and client code (no .server imports, no node-only APIs).
import { describe, expect, it } from "vitest";
import {
  WORKER_FILE_CONTENT,
  WORKER_PATH,
  cleanPlayerId,
  normalizeOrigin,
  validateCampaignContent,
  validatePromptConfig,
} from "./shared";

describe("WORKER_PATH / WORKER_FILE_CONTENT", () => {
  it("matches the global constraints", () => {
    expect(WORKER_PATH).toBe("/push/onesignal/OneSignalSDKWorker.js");
    expect(WORKER_FILE_CONTENT).toBe(
      'importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");\n',
    );
  });
});

describe("normalizeOrigin", () => {
  it("strips a trailing slash", () => {
    expect(normalizeOrigin("https://bravabet365.com/")).toBe("https://bravabet365.com");
  });

  it("adds https:// when no scheme is given and drops path/query", () => {
    expect(normalizeOrigin("bravabet365.com/promo?x=1")).toBe("https://bravabet365.com");
  });

  it("lowercases scheme and host but keeps www. as typed", () => {
    expect(normalizeOrigin("HTTPS://WWW.Bravabet365.com")).toBe("https://www.bravabet365.com");
  });

  it("rejects http://", () => {
    expect(normalizeOrigin("http://bravabet365.com")).toBeNull();
  });

  it("rejects localhost", () => {
    expect(normalizeOrigin("localhost:3000")).toBeNull();
  });

  it("rejects an IP literal", () => {
    expect(normalizeOrigin("10.0.0.1")).toBeNull();
  });

  it("rejects an empty string", () => {
    expect(normalizeOrigin("")).toBeNull();
  });

  it("rejects a host without a dot", () => {
    expect(normalizeOrigin("bravabet365")).toBeNull();
  });

  it("keeps a non-default port", () => {
    expect(normalizeOrigin("bravabet365.com:8443")).toBe("https://bravabet365.com:8443");
  });
});

describe("validatePromptConfig", () => {
  const base = {
    promptText: "Quer receber nossas promoções?",
    acceptLabel: "Permitir",
    cancelLabel: "Agora não",
    iconUrl: null as string | null,
  };

  it("accepts a valid config", () => {
    expect(validatePromptConfig(base)).toEqual(base);
  });

  it("accepts an https icon url", () => {
    const input = { ...base, iconUrl: "https://x.com/icon.png" };
    expect(validatePromptConfig(input)).toEqual(input);
  });

  it("rejects an empty promptText", () => {
    expect(() => validatePromptConfig({ ...base, promptText: "" })).toThrow(Error);
  });

  it("rejects a promptText longer than 90 chars", () => {
    expect(() => validatePromptConfig({ ...base, promptText: "a".repeat(91) })).toThrow(Error);
  });

  it("rejects an acceptLabel longer than 15 chars", () => {
    expect(() => validatePromptConfig({ ...base, acceptLabel: "a".repeat(16) })).toThrow(Error);
  });

  it("rejects an empty cancelLabel", () => {
    expect(() => validatePromptConfig({ ...base, cancelLabel: "" })).toThrow(Error);
  });

  it("rejects a non-https icon url", () => {
    expect(() => validatePromptConfig({ ...base, iconUrl: "http://x.com/icon.png" })).toThrow(
      Error,
    );
  });

  it("error messages are in pt-BR", () => {
    expect(() => validatePromptConfig({ ...base, promptText: "" })).toThrow(/texto do prompt/i);
  });
});

describe("validateCampaignContent", () => {
  const base = {
    title: "Promoção especial",
    body: "Aproveite agora mesmo essa oferta exclusiva para você.",
    url: "https://bravabet365.com/promo",
    imageUrl: null as string | null,
  };

  it("accepts valid content", () => {
    expect(validateCampaignContent(base)).toEqual(base);
  });

  it("accepts an https imageUrl", () => {
    const input = { ...base, imageUrl: "https://bravabet365.com/img.png" };
    expect(validateCampaignContent(input)).toEqual(input);
  });

  it("rejects a non-https url", () => {
    expect(() => validateCampaignContent({ ...base, url: "http://bravabet365.com/promo" })).toThrow(
      Error,
    );
  });

  it("rejects a title of 65 chars", () => {
    expect(() => validateCampaignContent({ ...base, title: "a".repeat(65) })).toThrow(Error);
  });

  it("rejects an empty title", () => {
    expect(() => validateCampaignContent({ ...base, title: "" })).toThrow(Error);
  });

  it("rejects an empty body", () => {
    expect(() => validateCampaignContent({ ...base, body: "" })).toThrow(Error);
  });

  it("rejects a body longer than 240 chars", () => {
    expect(() => validateCampaignContent({ ...base, body: "a".repeat(241) })).toThrow(Error);
  });

  it("rejects a missing url", () => {
    expect(() => validateCampaignContent({ ...base, url: "" })).toThrow(Error);
  });

  it("rejects a non-https imageUrl", () => {
    expect(() =>
      validateCampaignContent({ ...base, imageUrl: "http://bravabet365.com/img.png" }),
    ).toThrow(Error);
  });
});

describe("cleanPlayerId", () => {
  it("trims and returns a valid id", () => {
    expect(cleanPlayerId(" 12345 ")).toBe("12345");
  });

  it.each(["", "undefined", "null", "0", "nan", "NaN", "UNDEFINED", "NULL"])(
    "rejects garbage value %j",
    (value) => {
      expect(cleanPlayerId(value)).toBeNull();
    },
  );

  it("rejects a value longer than 128 chars", () => {
    expect(cleanPlayerId("a".repeat(129))).toBeNull();
  });

  it("accepts a value of exactly 128 chars", () => {
    const id = "a".repeat(128);
    expect(cleanPlayerId(id)).toBe(id);
  });

  it("rejects non-string values", () => {
    expect(cleanPlayerId(12345)).toBeNull();
    expect(cleanPlayerId(null)).toBeNull();
    expect(cleanPlayerId(undefined)).toBeNull();
    expect(cleanPlayerId({})).toBeNull();
  });
});
