import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const queryState = {
  data: undefined as unknown,
  isLoading: false,
  isError: false,
  isFetching: false,
};

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => queryState,
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, className }: { children: ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  ),
}));
vi.mock("@/lib/journeys.functions", () => ({
  listDeadLeads: vi.fn(),
  reviveDeadLeadFn: vi.fn(),
  runDeadLeadBackfill: vi.fn(),
}));
vi.mock("@/components/system-dialog-host", () => ({ requestConfirmation: vi.fn() }));

import { DeadLeadsPanel, type DeadLeadRow } from "./dead-leads-panel";

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

const row = (overrides: Partial<DeadLeadRow> = {}): DeadLeadRow => ({
  playerId: "00000000-0000-4000-8000-000000000001",
  nome: "Maria Souza",
  telefone: "•••••••4321",
  email: "m•••@gmail.com",
  externalId: "EXT-9",
  markedAt: hoursAgo(48),
  messagesCount: 5,
  lastActionAt: null,
  lastActionType: null,
  lastJourneyId: "00000000-0000-4000-8000-0000000000aa",
  lastJourneyName: "Reativação 7 dias",
  exitedEnrollments: 2,
  revivedAt: null,
  revivedReason: null,
  totalDepositado: 150,
  hasFtd: true,
  ftdAt: hoursAgo(500),
  ultimoDeposito: hoursAgo(400),
  ultimoLogin: null,
  vip: true,
  playerCreatedAt: hoursAgo(900),
  ...overrides,
});

const render = () => renderToStaticMarkup(<DeadLeadsPanel onOpenSettings={() => undefined} />);

describe("DeadLeadsPanel", () => {
  it("shows summary, the off banner and the dead leads with masked contact", () => {
    queryState.data = {
      rows: [
        row(),
        row({
          playerId: "00000000-0000-4000-8000-000000000002",
          nome: "João",
          lastActionType: "deposito",
          lastActionAt: hoursAgo(72),
          vip: false,
          hasFtd: false,
        }),
      ],
      total: 2,
      searchCapped: false,
      summary: { dead: 2, revivedLast30d: 4, enabled: false, threshold: 5 },
    };

    const html = render();

    expect(html).toContain("Leads mortos agora");
    expect(html).toContain("Reativados em 30 dias");
    expect(html).toContain("Desligada");
    expect(html).toContain("A regra de leads mortos está desligada.");
    expect(html).toContain("Ligar em Limites de contato");
    expect(html).not.toContain("Avaliar base atual agora");
    expect(html).toContain("system:dead-leads");
    expect(html).toContain("Maria Souza");
    expect(html).toContain("•••••••4321 · m•••@gmail.com");
    expect(html).toContain("Nunca agiu");
    expect(html).toContain("Depósito");
    expect(html).toContain("Reativação 7 dias");
    expect(html).toContain("Com FTD");
    expect(html).toContain("Sem FTD");
    expect(html).toContain("VIP");
    expect(html).toContain("2d atrás");
    expect(html.match(/Reativar Maria Souza|Reativar João/g)).toHaveLength(2);
  });

  it("offers the backfill when the rule is on and shows the empty state", () => {
    queryState.data = {
      rows: [],
      total: 0,
      searchCapped: false,
      summary: { dead: 0, revivedLast30d: 0, enabled: true, threshold: 7 },
    };

    const html = render();

    expect(html).toContain("Ligada");
    expect(html).toContain("Após 7 mensagens seguidas sem ação");
    expect(html).toContain("Avaliar base atual agora");
    expect(html).not.toContain("A regra de leads mortos está desligada.");
    expect(html).toContain("Nenhum lead morto");
  });
});
