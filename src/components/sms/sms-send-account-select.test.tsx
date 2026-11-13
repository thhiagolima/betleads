import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryState: { data: unknown; enabled?: boolean } = { data: undefined };

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ enabled }: { enabled?: boolean }) => {
    queryState.enabled = enabled;
    return { data: enabled === false ? undefined : queryState.data };
  },
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/sms.functions", () => ({ listSmsSendAccounts: vi.fn() }));
vi.mock("@/components/ui/select", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Select: ({ children, value }: { children?: ReactNode; value?: string }) => (
      <div data-value={value}>{children}</div>
    ),
    SelectContent: Pass,
    SelectTrigger: Pass,
    SelectValue: () => null,
    SelectItem: ({ children, disabled }: { children?: ReactNode; disabled?: boolean }) => (
      <div role="option" aria-disabled={disabled ? "true" : "false"}>
        {children}
      </div>
    ),
  };
});

import {
  SmsSendAccountSelect,
  useSmsSendAccounts,
  type SmsSendAccountChoice,
} from "./sms-send-account-select";

const ROTA = "11111111-1111-4111-8111-111111111111";
const RESERVA = "22222222-2222-4222-8222-222222222222";
const choices: SmsSendAccountChoice[] = [
  { id: null, name: "Padrão da casa", available: true },
  { id: ROTA, name: "Rota principal", available: true },
  { id: RESERVA, name: "Rota reserva", available: false },
];

function probe(selectedId: string | null, enabled = true) {
  let result: ReturnType<typeof useSmsSendAccounts> | undefined;
  function Probe() {
    result = useSmsSendAccounts(selectedId, enabled);
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return result!;
}

beforeEach(() => {
  queryState.data = undefined;
});

describe("useSmsSendAccounts", () => {
  it("only the default: no choice, sends null", () => {
    queryState.data = { choices: [choices[0]] };
    const state = probe(null);
    expect(state.showChoice).toBe(false);
    expect(state.providerAccountId).toBeNull();
    expect(state.selectedName).toBeNull();
    expect(state.error).toBeNull();
  });

  it("with extra accounts: sends the picked id and names it", () => {
    queryState.data = { choices };
    const state = probe(ROTA);
    expect(state.showChoice).toBe(true);
    expect(state.providerAccountId).toBe(ROTA);
    expect(state.selectedName).toBe("Rota principal");
    expect(state.error).toBeNull();
  });

  it("the default stays null even when there is a choice", () => {
    queryState.data = { choices };
    const state = probe(null);
    expect(state.providerAccountId).toBeNull();
    expect(state.selectedName).toBe("Padrão da casa");
  });

  it("a picked account that went unavailable blocks the send", () => {
    queryState.data = { choices };
    expect(probe(RESERVA).error).toContain("indisponível");
  });

  it("disabled (expert / other channel): no query, no choice, null", () => {
    queryState.data = { choices };
    const state = probe(ROTA, false);
    expect(queryState.enabled).toBe(false);
    expect(state.showChoice).toBe(false);
    expect(state.providerAccountId).toBeNull();
  });
});

describe("SmsSendAccountSelect", () => {
  it("lists the names, marks and disables unavailable accounts", () => {
    const html = renderToStaticMarkup(
      <SmsSendAccountSelect id="conta" choices={choices} value={null} onChange={() => undefined} />,
    );
    expect(html).toContain("Enviar por");
    expect(html).toContain('data-value="default"');
    expect(html).toContain('aria-disabled="false">Padrão da casa<');
    expect(html).toContain('aria-disabled="false">Rota principal<');
    expect(html).toContain('aria-disabled="true">Rota reserva (indisponível)<');
  });

  it("keeps the current pick selectable even if it went unavailable", () => {
    const html = renderToStaticMarkup(
      <SmsSendAccountSelect
        id="conta"
        choices={choices}
        value={RESERVA}
        onChange={() => undefined}
      />,
    );
    expect(html).toContain(`data-value="${RESERVA}"`);
    expect(html).toContain('aria-disabled="false">Rota reserva (indisponível)<');
  });
});
