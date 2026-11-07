import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryState: { data: unknown } = { data: undefined };
const mutate = vi.fn();
const activeTenant = { active: null as { id: string; role: string } | null };

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => queryState,
  useMutation: () => ({ mutate, isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/hooks/use-active-tenant", () => ({
  useActiveTenant: () => activeTenant,
}));

vi.mock("@/lib/tenant-channel-notices.functions", () => ({
  getPendingChannelNotices: vi.fn(),
  ackChannelNotice: vi.fn(),
}));

import { ChannelDisabledNoticeGate } from "./channel-disabled-notice-gate";

function render() {
  return renderToStaticMarkup(
    <ChannelDisabledNoticeGate>
      <div>conteudo-da-casa</div>
    </ChannelDisabledNoticeGate>,
  );
}

describe("ChannelDisabledNoticeGate", () => {
  beforeEach(() => {
    mutate.mockClear();
    activeTenant.active = { id: "00000000-0000-4000-8000-000000000001", role: "admin" };
  });

  it("não renderiza nada sem avisos pendentes", () => {
    queryState.data = [];
    const html = render();
    expect(html).toContain("conteudo-da-casa");
    expect(html).not.toContain("Ciente");
  });

  it("renderiza o aviso do canal Voz e o botão Ciente com 1 pendente", () => {
    queryState.data = [{ kind: "disabled", channel: "voice", disabledAt: "2026-11-05T12:00:00.000Z" }];
    const html = render();
    expect(html).toContain("O canal Voz foi desabilitado para a sua casa");
    expect(html).toContain("Ciente");
  });

  it("renderiza o aviso de revogação da conta própria com o texto exato", () => {
    queryState.data = [
      { kind: "own_revoked", channel: "sms", disabledAt: "2026-11-07T10:00:00.000Z" },
    ];
    const html = render();
    expect(html).toContain(
      "A conta própria de SMS da sua casa foi desligada pela BetLeads. Os envios desse canal estão pausados até a BetLeads definir o próximo passo.",
    );
    expect(html).not.toContain("foi desabilitado para a sua casa");
    expect(html).toContain("Ciente");
  });

  it("aviso de revogação de e-mail usa o rótulo do canal", () => {
    queryState.data = [
      { kind: "own_revoked", channel: "email", disabledAt: "2026-11-07T10:00:00.000Z" },
    ];
    expect(render()).toContain("A conta própria de E-mail da sua casa foi desligada pela BetLeads.");
  });

  it("não busca os avisos para o super admin", () => {
    activeTenant.active = { id: "00000000-0000-4000-8000-000000000001", role: "super_admin" };
    queryState.data = [{ channel: "voice", disabledAt: "2026-11-05T12:00:00.000Z" }];
    const html = render();
    expect(html).not.toContain("Ciente");
  });
});
