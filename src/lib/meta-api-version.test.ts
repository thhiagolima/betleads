import { afterEach, describe, expect, it, vi } from "vitest";
import { META_API_DEFAULT_VERSION, resolveMetaApiVersion } from "./meta-api-version";

describe("AL0-02 resolveMetaApiVersion", () => {
  afterEach(() => vi.restoreAllMocks());

  it("usa a versão padrão quando nada está configurado", () => {
    expect(resolveMetaApiVersion(undefined)).toBe(META_API_DEFAULT_VERSION);
    expect(resolveMetaApiVersion("  ")).toBe(META_API_DEFAULT_VERSION);
  });

  it("ignora versões expiradas e avisa", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveMetaApiVersion("v23.0")).toBe(META_API_DEFAULT_VERSION);
    expect(resolveMetaApiVersion("v24.0")).toBe(META_API_DEFAULT_VERSION);
    expect(warn).toHaveBeenCalled();
  });

  it("ignora valores fora do formato", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveMetaApiVersion("25")).toBe(META_API_DEFAULT_VERSION);
    expect(resolveMetaApiVersion("latest")).toBe(META_API_DEFAULT_VERSION);
  });

  it("respeita versões no piso ou acima", () => {
    expect(resolveMetaApiVersion("v25.0")).toBe("v25.0");
    expect(resolveMetaApiVersion("v26.0")).toBe("v26.0");
    expect(resolveMetaApiVersion(" v25.1 ")).toBe("v25.1");
  });
});
