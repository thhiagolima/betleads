// platform-email.server (Task 5): DNS instructions email copy and the
// platform-identity send path used to deliver it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/infobip-email.server", () => ({
  callInfobipEmail: vi.fn(),
}));

import { callInfobipEmail } from "@/lib/infobip-email.server";
import { renderDnsInstructionsEmail, sendPlatformEmail } from "./platform-email.server";

describe("renderDnsInstructionsEmail", () => {
  it("builds the subject from the hostname and tenant name", () => {
    const result = renderDnsInstructionsEmail({
      tenantName: "Casa X",
      hostname: "go.x.com",
      kind: "shortener",
      records: [],
    });
    expect(result.subject).toBe("Registros DNS para go.x.com — Casa X");
  });

  it("renders one line per DNS record with type, name and value", () => {
    const result = renderDnsInstructionsEmail({
      tenantName: "Casa X",
      hostname: "go.x.com",
      kind: "shortener",
      records: [
        { type: "CNAME", name: "go", value: "cname.short.io", verified: null },
        { type: "A", name: "@", value: "207.174.61.1", verified: null },
      ],
    });
    expect(result.html).toContain("CNAME");
    expect(result.html).toContain("go");
    expect(result.html).toContain("cname.short.io");
    expect(result.html).toContain("A");
    expect(result.html).toContain("@");
    expect(result.html).toContain("207.174.61.1");
  });

  it("escapes HTML special characters in the interpolated record values", () => {
    const result = renderDnsInstructionsEmail({
      tenantName: "Casa <X>",
      hostname: "go.x.com",
      kind: "shortener",
      records: [
        { type: "TXT", name: "<script>", value: "v=1 <tag>", verified: null },
      ],
    });
    expect(result.html).not.toContain("<script>");
    expect(result.html).toContain("&lt;script&gt;");
    expect(result.html).toContain("v=1 &lt;tag&gt;");
    expect(result.html).toContain("Casa &lt;X&gt;");
  });

  it("mentions e-mail when kind is email", () => {
    const result = renderDnsInstructionsEmail({
      tenantName: "Casa X",
      hostname: "mail.x.com",
      kind: "email",
      records: [],
    });
    expect(result.html.toLowerCase()).toContain("e-mail");
  });

  it("does not mention e-mail for a shortener domain, but still shows its records", () => {
    const result = renderDnsInstructionsEmail({
      tenantName: "Casa X",
      hostname: "go.x.com",
      kind: "shortener",
      records: [{ type: "CNAME", name: "go", value: "cname.short.io", verified: null }],
    });
    expect(result.html).toContain("CNAME");
    expect(result.html).toContain("cname.short.io");
    expect(result.html.toLowerCase()).not.toContain("e-mail");
  });
});

describe("sendPlatformEmail", () => {
  const mockedCallInfobipEmail = vi.mocked(callInfobipEmail);

  beforeEach(() => {
    mockedCallInfobipEmail.mockReset();
    delete process.env.PLATFORM_EMAIL_FROM;
  });

  afterEach(() => {
    delete process.env.PLATFORM_EMAIL_FROM;
  });

  it("sends with the default platform identity", async () => {
    mockedCallInfobipEmail.mockResolvedValue({
      ok: true,
      status: 200,
      body: {},
      idempotencyKey: "k1",
    });

    await sendPlatformEmail({ to: "a@b.com", subject: "S", html: "<p>hi</p>" });

    expect(mockedCallInfobipEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "a@b.com",
        from: "no-reply@betleads.io",
        fromName: "Betleads",
        subject: "S",
        html: "<p>hi</p>",
      }),
    );
  });

  it("uses PLATFORM_EMAIL_FROM when set", async () => {
    process.env.PLATFORM_EMAIL_FROM = "oi@outra.com";
    mockedCallInfobipEmail.mockResolvedValue({
      ok: true,
      status: 200,
      body: {},
      idempotencyKey: "k2",
    });

    await sendPlatformEmail({ to: "a@b.com", subject: "S", html: "<p>hi</p>" });

    expect(mockedCallInfobipEmail).toHaveBeenCalledWith(
      expect.objectContaining({ from: "oi@outra.com", fromName: "Betleads" }),
    );
  });

  it("throws when the provider call fails", async () => {
    mockedCallInfobipEmail.mockResolvedValue({
      ok: false,
      status: 500,
      body: { error: "boom" },
      idempotencyKey: "k3",
    });

    await expect(
      sendPlatformEmail({ to: "a@b.com", subject: "S", html: "<p>hi</p>" }),
    ).rejects.toThrow();
  });
});
