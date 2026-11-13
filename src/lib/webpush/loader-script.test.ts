// Web push (OneSignal) — Task 8: buildLoaderScript. Pure string builder, no DB.
import { describe, expect, it } from "vitest";

import { buildLoaderScript } from "./loader-script";

const BASE_PROMPT = {
  promptText: "Quer receber promoções e avisos da casa?",
  acceptLabel: "Permitir",
  cancelLabel: "Agora não",
  iconUrl: null,
};

describe("buildLoaderScript", () => {
  it("maps each app's appId by its origin", () => {
    const script = buildLoaderScript({
      token: "tok-123",
      apiBase: "https://betleads.io",
      apps: [
        { origin: "https://casa-a.example", appId: "app-aaa" },
        { origin: "https://casa-b.example", appId: "app-bbb" },
      ],
      prompt: BASE_PROMPT,
    });
    expect(script).toContain('"https://casa-a.example":"app-aaa"');
    expect(script).toContain('"https://casa-b.example":"app-bbb"');
  });

  it("uses the fixed OneSignal service worker path and scope", () => {
    const script = buildLoaderScript({
      token: "tok-123",
      apiBase: "https://betleads.io",
      apps: [{ origin: "https://casa-a.example", appId: "app-aaa" }],
      prompt: BASE_PROMPT,
    });
    expect(script).toContain('"serviceWorkerPath":"push/onesignal/OneSignalSDKWorker.js"');
    expect(script).toContain('"scope":"/push/onesignal/"');
  });

  it("escapes a prompt-text XSS attempt so no literal </script> appears", () => {
    const script = buildLoaderScript({
      token: "tok-123",
      apiBase: "https://betleads.io",
      apps: [{ origin: "https://casa-a.example", appId: "app-aaa" }],
      prompt: { ...BASE_PROMPT, promptText: "</script><script>alert(1)" },
    });
    expect(script).not.toMatch(/<\/script>/i);
    expect(script).not.toContain("</script><script>alert(1)");
    // The content itself still round-trips, just safely escaped.
    expect(script).toContain("alert(1)");
  });

  it("escapes line separators that would otherwise break out of a JS string", () => {
    const script = buildLoaderScript({
      token: "tok-123",
      apiBase: "https://betleads.io",
      apps: [{ origin: "https://casa-a.example", appId: "app-aaa" }],
      prompt: { ...BASE_PROMPT, promptText: "linha1 linha2 linha3" },
    });
    expect(script).not.toContain(" ");
    expect(script).not.toContain(" ");
  });

  it("never calls OneSignal.login", () => {
    const script = buildLoaderScript({
      token: "tok-123",
      apiBase: "https://betleads.io",
      apps: [{ origin: "https://casa-a.example", appId: "app-aaa" }],
      prompt: BASE_PROMPT,
    });
    expect(script).not.toContain("OneSignal.login");
  });

  it("reports via fetch to the subscribe endpoint with the token in the query string", () => {
    const script = buildLoaderScript({
      token: "tok-123",
      apiBase: "https://betleads.io",
      apps: [{ origin: "https://casa-a.example", appId: "app-aaa" }],
      prompt: BASE_PROMPT,
    });
    expect(script).toContain("/api/public/push/subscribe?t=");
    expect(script).toContain('addTag("blk"');
  });

  it("does nothing (no app match) when the current origin has no app registered", () => {
    const script = buildLoaderScript({
      token: "tok-123",
      apiBase: "https://betleads.io",
      apps: [{ origin: "https://casa-a.example", appId: "app-aaa" }],
      prompt: BASE_PROMPT,
    });
    expect(script).toContain("if (!appId) return;");
  });

  it("embeds the popup runtime only when the house has an active popup", () => {
    const base = { token: "tok-123", apiBase: "https://betleads.io", apps: [], prompt: BASE_PROMPT };
    expect(buildLoaderScript(base)).not.toContain("betleadsPopupCore");
    const withPopups = buildLoaderScript({ ...base, popups: true });
    expect(withPopups).toContain("betleadsPopupCore");
    // The popup part runs before the push part bails out on an unknown origin.
    expect(withPopups.indexOf("betleadsPopupCore")).toBeLessThan(withPopups.indexOf("if (!appId) return;"));
    expect(() => new Function(withPopups)).not.toThrow();
  });
});
