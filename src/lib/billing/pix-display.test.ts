import { describe, expect, it } from "vitest";

import { safeHttpsUrl, safePixImageSrc } from "./pix-display";

describe("safePixImageSrc", () => {
  it("accepts an inline PNG data URI", () => {
    expect(safePixImageSrc("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
  });

  it("accepts an inline JPEG data URI", () => {
    expect(safePixImageSrc("data:image/jpeg;base64,AAAA")).toBe("data:image/jpeg;base64,AAAA");
  });

  it("accepts an https URL", () => {
    expect(safePixImageSrc("https://img.example/qr.png")).toBe("https://img.example/qr.png");
  });

  it("rejects an http URL", () => {
    expect(safePixImageSrc("http://img.example/qr.png")).toBeNull();
  });

  it("rejects a javascript: URL", () => {
    expect(safePixImageSrc("javascript:alert(1)")).toBeNull();
  });

  it("rejects a data URI of a disallowed MIME type", () => {
    expect(safePixImageSrc("data:text/html,<script>alert(1)</script>")).toBeNull();
  });

  it("rejects null/undefined/empty", () => {
    expect(safePixImageSrc(null)).toBeNull();
    expect(safePixImageSrc(undefined)).toBeNull();
    expect(safePixImageSrc("")).toBeNull();
  });
});

describe("safeHttpsUrl", () => {
  it("accepts an https URL", () => {
    expect(safeHttpsUrl("https://pay.example/x")).toBe("https://pay.example/x");
  });

  it("rejects an http URL", () => {
    expect(safeHttpsUrl("http://pay.example/x")).toBeNull();
  });

  it("rejects a javascript: URL", () => {
    expect(safeHttpsUrl("javascript:alert(1)")).toBeNull();
  });

  it("rejects an unparseable string", () => {
    expect(safeHttpsUrl("not a url")).toBeNull();
  });

  it("rejects null/undefined/empty", () => {
    expect(safeHttpsUrl(null)).toBeNull();
    expect(safeHttpsUrl(undefined)).toBeNull();
    expect(safeHttpsUrl("")).toBeNull();
  });
});
