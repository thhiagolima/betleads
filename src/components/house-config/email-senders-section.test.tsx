import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const queryState = { data: undefined as unknown };

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => queryState,
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-is-demo-tenant", () => ({ useIsDemoTenant: () => false }));
vi.mock("@/lib/house-config.functions", () => ({
  getHouseConfig: vi.fn(),
  saveEmailSenderForHouse: vi.fn(),
  removeEmailSenderForHouse: vi.fn(),
}));
vi.mock("@/components/system-dialog-host", () => ({ requestConfirmation: vi.fn() }));
// Term pulls in HelpProvider's chain (shell nav, active tenant, ...) through
// useHelp() — out of scope for this pure component test, so it's replaced
// with a passthrough, the same way every other external dependency here is.
vi.mock("@/components/help/term", () => ({
  Term: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/ui/select", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Select: Pass,
    SelectContent: Pass,
    SelectTrigger: Pass,
    SelectValue: () => null,
    SelectItem: ({ children }: { children?: ReactNode }) => <div role="option">{children}</div>,
  };
});

import {
  buildRemoveSenderConfirmOptions,
  confirmAndRemoveSender,
  EmailSendersSection,
} from "./email-senders-section";

function configFor(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    canEdit: true,
    domains: [{ id: "dom-1", kind: "email", hostname: "mail.suacasa.bet.br", status: "verified" }],
    senders: [],
    ...overrides,
  };
}

describe("EmailSendersSection", () => {
  it("shows the create-sender hint for a verified domain and zero senders", () => {
    queryState.data = configFor();
    const html = renderToStaticMarkup(<EmailSendersSection />);
    expect(html).toContain("Agora crie um remetente");
  });

  it("does not show the hint when there is already a sender", () => {
    queryState.data = configFor({
      senders: [
        { id: "s1", fromName: "Promo", fromEmail: "promo@mail.suacasa.bet.br", isDefault: true, domainVerified: true },
      ],
    });
    const html = renderToStaticMarkup(<EmailSendersSection />);
    expect(html).not.toContain("Agora crie um remetente");
  });

  it("does not show the hint when no e-mail domain is verified yet", () => {
    queryState.data = configFor({
      domains: [{ id: "dom-1", kind: "email", hostname: "mail.suacasa.bet.br", status: "pending" }],
    });
    const html = renderToStaticMarkup(<EmailSendersSection />);
    expect(html).not.toContain("Agora crie um remetente");
  });
});

describe("buildRemoveSenderConfirmOptions", () => {
  it("asks 'Remover remetente?' naming the sender", () => {
    const options = buildRemoveSenderConfirmOptions({
      id: "s1",
      fromName: "Promo SuaCasa",
      fromEmail: "promo@mail.suacasa.bet.br",
    });
    expect(options.title).toBe("Remover remetente?");
    expect(options.description).toContain("Promo SuaCasa <promo@mail.suacasa.bet.br>");
    expect(options.destructive).toBe(true);
  });
});

describe("confirmAndRemoveSender", () => {
  const sender = { id: "s1", fromName: "Promo", fromEmail: "promo@mail.suacasa.bet.br" };

  it("never removes directly: only calls remove after an explicit confirmation", async () => {
    const remove = vi.fn();
    const confirm = vi.fn().mockResolvedValue(true);
    await confirmAndRemoveSender(sender, { confirm, remove });
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Remover remetente?" }),
    );
    expect(remove).toHaveBeenCalledWith("s1");
  });

  it("does not remove when the user cancels the confirmation", async () => {
    const remove = vi.fn();
    const confirm = vi.fn().mockResolvedValue(false);
    await confirmAndRemoveSender(sender, { confirm, remove });
    expect(remove).not.toHaveBeenCalled();
  });
});
