import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryState = { data: undefined as unknown };

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => queryState,
}));

// Radix portals render nothing on the server: show the dialog content inline.
vi.mock("@/components/ui/dialog", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: Pass,
    DialogContent: Pass,
    DialogDescription: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
  };
});

vi.mock("@/components/help/term", () => ({
  Term: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

import { PixPaymentDialog, secondsUntil, type PixChargePayload } from "./pix-payment-dialog";

const EMV = "00020101021226870014br.gov.bcb.pix";

function charge(overrides: Partial<PixChargePayload> = {}): PixChargePayload {
  return {
    chargeId: "c1",
    emv: EMV,
    qrCodeImage: null,
    paymentUrl: null,
    expiresAt: new Date(Date.now() + (4 * 60 + 32) * 1000).toISOString(),
    amountCents: 10_000,
    status: "ACTIVE",
    ...overrides,
  };
}

function render(c: PixChargePayload, extra: { onRegenerate?: () => void } = {}) {
  return renderToStaticMarkup(
    <PixPaymentDialog
      open
      onOpenChange={() => undefined}
      charge={c}
      getStatus={() => Promise.reject(new Error("unused"))}
      statusQueryKey={["test", c.chargeId]}
      onReset={() => undefined}
      successText="ok"
      {...extra}
    />,
  );
}

beforeEach(() => {
  queryState.data = undefined;
});

describe("secondsUntil", () => {
  it("returns whole seconds to expiry, negative once past, null without a date", () => {
    const now = Date.parse("2026-11-12T12:00:00Z");
    expect(secondsUntil("2026-11-12T12:04:32Z", now)).toBe(272);
    expect(secondsUntil("2026-11-12T11:59:00Z", now)).toBe(-60);
    expect(secondsUntil(null, now)).toBeNull();
    expect(secondsUntil("not a date", now)).toBeNull();
  });
});

describe("PixPaymentDialog", () => {
  it("shows the QR copy-paste and a live 'Expira em m:ss' countdown", () => {
    const html = render(charge());
    expect(html).toMatch(/Expira em 4:3[12]/);
    expect(html).toContain(EMV);
    expect(html).not.toContain("Este Pix expirou");
  });

  it("once expiresAt has passed, hides the code and offers 'Gerar novo Pix'", () => {
    const html = render(charge({ expiresAt: new Date(Date.now() - 1000).toISOString() }), {
      onRegenerate: () => undefined,
    });
    expect(html).toContain("Este Pix expirou");
    expect(html).toContain("Gerar novo Pix");
    expect(html).not.toContain(EMV);
    expect(html).not.toContain("Expira em");
  });

  it("a server EXPIRED status also shows the expired screen", () => {
    queryState.data = { status: "EXPIRED", credited: false, needsReview: false };
    const html = render(charge());
    expect(html).toContain("Este Pix expirou");
    expect(html).not.toContain(EMV);
  });

  it("a PAID result wins over the local expiry", () => {
    queryState.data = { status: "PAID", credited: false, needsReview: false };
    const html = render(charge({ expiresAt: new Date(Date.now() - 60_000).toISOString() }));
    expect(html).toContain("Pagamento recebido");
    expect(html).not.toContain("Este Pix expirou");
  });

  it("credited wins over the local expiry", () => {
    queryState.data = { status: "PAID", credited: true, needsReview: false };
    const html = render(charge({ expiresAt: new Date(Date.now() - 60_000).toISOString() }));
    expect(html).toContain("Pagamento confirmado");
    expect(html).not.toContain("Este Pix expirou");
  });
});
