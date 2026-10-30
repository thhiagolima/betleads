// O e-mail de teto atingido aponta para a aba Campanhas do expert.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("./billing-emails.server", () => ({
  getPayerEmails: vi.fn(),
  getTenantForEmail: vi.fn(),
  sendPlatformEmail: vi.fn(),
}));

import { expertCampaignsUrl, expertCapEmail } from "./expert-cap-alerts.server";

describe("expertCapEmail", () => {
  it("links to the expert's Campanhas tab", () => {
    const { subject, html } = expertCapEmail(
      "Casa",
      "Queiroz",
      100,
      "00000000-0000-4000-8000-0000000000e1",
    );
    expect(subject).toBe("Teto mensal do expert Queiroz atingido");
    expect(html).toContain(
      'href="https://betleads.io/rendimento/equipe/00000000-0000-4000-8000-0000000000e1?aba=campanhas"',
    );
    expect(html).toContain("Ver campanhas do expert");
  });

  it("keeps working without the expert id (no link)", () => {
    expect(expertCapEmail("Casa", "Queiroz", null).html).not.toContain("<a ");
  });

  it("encodes the id in the URL", () => {
    expect(expertCampaignsUrl("a b")).toBe(
      "https://betleads.io/rendimento/equipe/a%20b?aba=campanhas",
    );
  });
});
