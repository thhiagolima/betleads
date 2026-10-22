import { describe, expect, it } from "vitest";
import {
  buildQuickLinkUrl,
  computeSetupChecklist,
  isDomainDueForCheck,
  isReservedPlatformHostname,
  normalizeHostname,
  normalizeSiteUrl,
  providerErrorMessage,
  quickLinkKeyFromLabel,
  suggestedQuickLinks,
  validateShortenerHostname,
} from "./house-config";

describe("normalizeHostname", () => {
  it("normalizes a messy hostname", () => {
    expect(normalizeHostname("https://Go.SuaCasa.bet.br/promo ")).toEqual({
      ok: true,
      hostname: "go.suacasa.bet.br",
    });
  });

  it("strips a trailing dot", () => {
    expect(normalizeHostname("go.suacasa.bet.br.")).toEqual({
      ok: true,
      hostname: "go.suacasa.bet.br",
    });
  });

  it("rejects an IP address", () => {
    expect(normalizeHostname("192.168.0.1").ok).toBe(false);
  });

  it("rejects localhost", () => {
    expect(normalizeHostname("localhost").ok).toBe(false);
  });

  it("rejects a hostname without a dot", () => {
    expect(normalizeHostname("semponto").ok).toBe(false);
  });

  it("rejects a hostname with invalid characters", () => {
    expect(normalizeHostname("go_casa.com").ok).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(normalizeHostname("").ok).toBe(false);
  });
});

describe("validateShortenerHostname", () => {
  it("rejects the house's own site domain", () => {
    expect(validateShortenerHostname("suacasa.bet.br", "https://suacasa.bet.br")).toBe(
      "Esse é o domínio do site da casa — use um subdomínio, ex.: go.suacasa.bet.br",
    );
  });

  it("ignores a leading www. on either side and still rejects, suggesting without www.", () => {
    expect(
      validateShortenerHostname("www.suacasa.bet.br", "https://www.suacasa.bet.br"),
    ).toBe("Esse é o domínio do site da casa — use um subdomínio, ex.: go.suacasa.bet.br");
  });

  it("accepts a proper subdomain", () => {
    expect(validateShortenerHostname("go.suacasa.bet.br", "https://suacasa.bet.br")).toBeNull();
  });

  it("accepts anything when there is no site url", () => {
    expect(validateShortenerHostname("suacasa.bet.br", null)).toBeNull();
  });
});

describe("normalizeSiteUrl", () => {
  it("adds https:// and strips the trailing slash", () => {
    expect(normalizeSiteUrl("suacasa.bet.br/")).toEqual({ ok: true, url: "https://suacasa.bet.br" });
  });

  it("strips query and hash and forces https", () => {
    expect(normalizeSiteUrl("http://x.com/?a=1#b")).toEqual({ ok: true, url: "https://x.com" });
  });

  it("rejects an invalid url", () => {
    expect(normalizeSiteUrl("nada").ok).toBe(false);
  });
});

describe("quickLinkKeyFromLabel", () => {
  it("slugifies a label", () => {
    expect(quickLinkKeyFromLabel("Depósito PIX")).toBe("deposito_pix");
  });
});

describe("suggestedQuickLinks", () => {
  it("offers Login, Depósito and Promo in that order", () => {
    expect(suggestedQuickLinks()).toEqual([
      { label: "Login", path: "/login" },
      { label: "Depósito", path: "/deposito" },
      { label: "Promo", path: "/promo" },
    ]);
  });
});

describe("buildQuickLinkUrl", () => {
  it("joins a relative path with a leading slash", () => {
    expect(buildQuickLinkUrl("https://x.com", "/login")).toBe("https://x.com/login");
  });

  it("joins a relative path without a leading slash", () => {
    expect(buildQuickLinkUrl("https://x.com", "login")).toBe("https://x.com/login");
  });

  it("keeps an absolute url untouched", () => {
    expect(buildQuickLinkUrl("https://x.com", "https://outra.com/a")).toBe("https://outra.com/a");
  });
});

describe("isDomainDueForCheck", () => {
  const now = new Date("2026-10-21T12:00:00.000Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000).toISOString();
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60 * 1000).toISOString();

  it("verified: checked 23h ago is not due", () => {
    expect(
      isDomainDueForCheck(
        { status: "verified", created_at: hoursAgo(100), last_checked_at: hoursAgo(23) },
        now,
      ),
    ).toBe(false);
  });

  it("verified: checked 25h ago is due", () => {
    expect(
      isDomainDueForCheck(
        { status: "verified", created_at: hoursAgo(100), last_checked_at: hoursAgo(25) },
        now,
      ),
    ).toBe(true);
  });

  it("pending younger than 6h: checked 9 min ago is not due", () => {
    expect(
      isDomainDueForCheck(
        { status: "pending", created_at: hoursAgo(1), last_checked_at: minutesAgo(9) },
        now,
      ),
    ).toBe(false);
  });

  it("pending younger than 6h: checked 11 min ago is due", () => {
    expect(
      isDomainDueForCheck(
        { status: "pending", created_at: hoursAgo(1), last_checked_at: minutesAgo(11) },
        now,
      ),
    ).toBe(true);
  });

  it("pending between 6h and 72h: checked 50 min ago is not due", () => {
    expect(
      isDomainDueForCheck(
        { status: "pending", created_at: hoursAgo(10), last_checked_at: minutesAgo(50) },
        now,
      ),
    ).toBe(false);
  });

  it("pending between 6h and 72h: checked 61 min ago is due", () => {
    expect(
      isDomainDueForCheck(
        { status: "pending", created_at: hoursAgo(10), last_checked_at: minutesAgo(61) },
        now,
      ),
    ).toBe(true);
  });

  it("pending older than 72h: checked 23h ago is not due", () => {
    expect(
      isDomainDueForCheck(
        { status: "pending", created_at: hoursAgo(4 * 24), last_checked_at: hoursAgo(23) },
        now,
      ),
    ).toBe(false);
  });

  it("pending older than 72h: checked 25h ago is due", () => {
    expect(
      isDomainDueForCheck(
        { status: "pending", created_at: hoursAgo(4 * 24), last_checked_at: hoursAgo(25) },
        now,
      ),
    ).toBe(true);
  });

  it("failed older than 72h: checked 23h ago is not due", () => {
    expect(
      isDomainDueForCheck(
        { status: "failed", created_at: hoursAgo(4 * 24), last_checked_at: hoursAgo(23) },
        now,
      ),
    ).toBe(false);
  });

  it("failed older than 72h: checked 25h ago is due", () => {
    expect(
      isDomainDueForCheck(
        { status: "failed", created_at: hoursAgo(4 * 24), last_checked_at: hoursAgo(25) },
        now,
      ),
    ).toBe(true);
  });

  it("is always due when never checked", () => {
    expect(
      isDomainDueForCheck({ status: "pending", created_at: hoursAgo(1), last_checked_at: null }, now),
    ).toBe(true);
  });
});

describe("computeSetupChecklist", () => {
  it("is all todo and incomplete with nothing set up", () => {
    expect(
      computeSetupChecklist({
        siteUrl: null,
        shortenerStatuses: [],
        emailStatuses: [],
        hasVerifiedSender: false,
      }),
    ).toEqual({
      items: [
        { id: "house", state: "todo" },
        { id: "shortener", state: "todo" },
        { id: "email", state: "todo" },
      ],
      complete: false,
    });
  });

  it("mixes done and pending_dns states", () => {
    expect(
      computeSetupChecklist({
        siteUrl: "https://suacasa.bet.br",
        shortenerStatuses: ["pending"],
        emailStatuses: ["verified"],
        hasVerifiedSender: true,
      }),
    ).toEqual({
      items: [
        { id: "house", state: "done" },
        { id: "shortener", state: "pending_dns" },
        { id: "email", state: "done" },
      ],
      complete: false,
    });
  });

  it("marks email todo when there is a verified domain but no verified sender", () => {
    const result = computeSetupChecklist({
      siteUrl: "https://suacasa.bet.br",
      shortenerStatuses: ["verified"],
      emailStatuses: ["verified"],
      hasVerifiedSender: false,
    });
    expect(result.items.find((i) => i.id === "email")).toEqual({ id: "email", state: "todo" });
  });

  it("is complete when everything is verified and there's a sender", () => {
    const result = computeSetupChecklist({
      siteUrl: "https://suacasa.bet.br",
      shortenerStatuses: ["verified"],
      emailStatuses: ["verified"],
      hasVerifiedSender: true,
    });
    expect(result.complete).toBe(true);
  });
});

describe("isReservedPlatformHostname", () => {
  const env = { platformEmailFrom: "no-reply@betleads.io", shortioDomain: null };

  it("blocks the platform domains exactly", () => {
    expect(isReservedPlatformHostname("betleads.io", env)).toBe(true);
    expect(isReservedPlatformHostname("betleads.app", env)).toBe(true);
  });

  it("blocks any subdomain of a reserved domain", () => {
    expect(isReservedPlatformHostname("mail.betleads.io", env)).toBe(true);
    expect(isReservedPlatformHostname("a.b.betleads.app", env)).toBe(true);
  });

  it("is case-insensitive and ignores a trailing dot", () => {
    expect(isReservedPlatformHostname("Mail.BetLeads.IO", env)).toBe(true);
    expect(isReservedPlatformHostname("betleads.app.", env)).toBe(true);
  });

  it("derives reserved domains from PLATFORM_EMAIL_FROM and SHORTIO_DOMAIN", () => {
    const custom = { platformEmailFrom: "Betleads <avisos@Notify.Example.com>", shortioDomain: "https://LK.crm.link/" };
    expect(isReservedPlatformHostname("notify.example.com", custom)).toBe(true);
    expect(isReservedPlatformHostname("x.notify.example.com", custom)).toBe(true);
    expect(isReservedPlatformHostname("lk.crm.link", custom)).toBe(true);
    expect(isReservedPlatformHostname("go.lk.crm.link", custom)).toBe(true);
    // Siblings/parents of an env-derived host are not reserved.
    expect(isReservedPlatformHostname("example.com", custom)).toBe(false);
    expect(isReservedPlatformHostname("crm.link", custom)).toBe(false);
  });

  it("does not block look-alike or unrelated domains", () => {
    expect(isReservedPlatformHostname("notbetleads.io", env)).toBe(false);
    expect(isReservedPlatformHostname("betleads.io.suacasa.bet.br", env)).toBe(false);
    expect(isReservedPlatformHostname("go.suacasa.bet.br", env)).toBe(false);
  });
});

describe("providerErrorMessage", () => {
  it("maps every provider code to pt-BR", () => {
    expect(providerErrorMessage("ALREADY_EXISTS")).toBe("Esse domínio já está cadastrado no provedor.");
    expect(providerErrorMessage("INVALID")).toBe("O provedor recusou esse domínio. Confira se o nome está correto.");
    expect(providerErrorMessage("UNAVAILABLE")).toBe(
      "O provedor está indisponível no momento. Tente novamente em alguns minutos.",
    );
    expect(providerErrorMessage("NOT_FOUND")).toBe("Domínio não encontrado no provedor.");
  });

  it("falls back to the unavailable message for unknown failures", () => {
    expect(providerErrorMessage(null)).toBe(
      "O provedor está indisponível no momento. Tente novamente em alguns minutos.",
    );
  });
});
