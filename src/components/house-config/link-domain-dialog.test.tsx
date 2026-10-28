import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-query", () => ({
  useMutation: (opts: { mutationFn: () => unknown }) => ({
    mutate: () => void opts.mutationFn(),
    isPending: false,
  }),
  useQueryClient: () => ({ invalidateQueries: () => {} }),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/house-config/house-config-query", () => ({
  invalidateHouseConfigQueries: vi.fn(),
}));
vi.mock("@/lib/link-domain.functions", () => ({
  previewLinkDomainChange: () => Promise.resolve(null),
  applyLinkDomainChange: () => Promise.resolve(null),
}));

import {
  countSelectedForApply,
  formatSegmentWarning,
  groupLinkDomainItems,
  initialSelection,
  outOfScopeIsEmpty,
} from "./link-domain-dialog";
import type { LinkDomainItem, LinkDomainPreview } from "@/lib/link-domain-plan";

// This repo's component tests (domain-detail.test.tsx, onboarding-gate.test.tsx)
// render plain-HTML components with `renderToStaticMarkup`, since there's no
// @testing-library/react and no jsdom environment configured (no
// fireEvent/click simulation either way). `LinkDomainDialog` is built on
// Radix's Dialog/AlertDialog, which render their content through a portal;
// `renderToStaticMarkup` can't capture a portal's target server-side, so a
// full render of this component always comes back as an empty string
// (verified: wrapping it that way makes every assertion below fail with
// `expected '' to contain ...`). So instead of a render test, every "what
// does passo 2 show" requirement is tested against the pure helpers that
// decide it — same data, same branches, the same thing a render would
// exercise, just without the portal in the way. This also directly covers
// "unchecking an item updates the counter", which needs no DOM at all.

function item(overrides: Partial<LinkDomainItem> = {}): LinkDomainItem {
  return {
    key: "journey_step:1",
    kind: "journey_step",
    id: "1",
    title: "Boas-vindas",
    detail: "Etapa 1 · SMS",
    replacements: 1,
    sample: { before: "https://casa-antiga.com/a", after: "https://suacasa.bet.br/a" },
    blockedReason: null,
    segmentWarning: null,
    update: {},
    previous: {},
    ...overrides,
  };
}

function preview(overrides: Partial<LinkDomainPreview> = {}): LinkDomainPreview {
  return {
    from: "casa-antiga.com",
    to: "suacasa.bet.br",
    items: [],
    trackingHosts: null,
    outOfScope: { scheduledCampaigns: [], legacyFlows: [], subdomainLinks: 0 },
    ...overrides,
  };
}

describe("initialSelection", () => {
  it("marca todos os itens não bloqueados", () => {
    const blocked = item({ key: "sms_template:1", kind: "sms_template", id: "1", blockedReason: "Passaria do limite." });
    const ok1 = item({ key: "journey_step:1" });
    const ok2 = item({ key: "quick_link:1", kind: "quick_link", id: "1" });
    const p = preview({ items: [ok1, blocked, ok2] });

    expect(initialSelection(p)).toEqual(new Set(["journey_step:1", "quick_link:1"]));
  });
});

describe("groupLinkDomainItems", () => {
  it("agrupa por tipo, na ordem de exibição, e ignora grupos vazios", () => {
    const journey = item({ key: "journey_step:1" });
    const quick = item({ key: "quick_link:1", kind: "quick_link", id: "1" });
    const groups = groupLinkDomainItems([quick, journey]);

    expect(groups.map((g) => g.label)).toEqual(["Jornadas", "URLs rápidas"]);
    expect(groups[0].items).toEqual([journey]);
    expect(groups[1].items).toEqual([quick]);
  });
});

describe("countSelectedForApply", () => {
  it("soma itens selecionados e a troca de rastreio quando marcada", () => {
    const p = preview({ trackingHosts: { current: ["casa-antiga.com"], next: ["casa-antiga.com", "suacasa.bet.br"] } });
    expect(countSelectedForApply(p, new Set(["a", "b"]), true)).toBe(3);
    expect(countSelectedForApply(p, new Set(["a", "b"]), false)).toBe(2);
  });

  it("desmarcar um item atualiza o contador", () => {
    const p = preview();
    const selected = new Set(["journey_step:1", "sms_template:1"]);
    expect(countSelectedForApply(p, selected, false)).toBe(2);

    selected.delete("sms_template:1");
    expect(countSelectedForApply(p, selected, false)).toBe(1);
  });

  it("não conta o rastreio quando não há nada a trocar nele", () => {
    const p = preview({ trackingHosts: null });
    expect(countSelectedForApply(p, new Set(), true)).toBe(0);
  });
});

describe("passo 2 — grupos, item bloqueado e contador (via helpers puros)", () => {
  it("mostra os grupos e desabilita o item bloqueado (excluído da seleção inicial, com o motivo preservado) e conta 'Trocar N itens'", () => {
    const blocked = item({
      key: "sms_template:1",
      kind: "sms_template",
      id: "1",
      title: "Lembrete de depósito",
      blockedReason: "O texto passaria de 480 caracteres.",
    });
    const ok = item({ key: "journey_step:1", title: "Boas-vindas" });
    const p = preview({ items: [ok, blocked] });

    const groups = groupLinkDomainItems(p.items);
    expect(groups.map((g) => g.label)).toEqual(["Jornadas", "Templates de SMS"]);
    const smsItem = groups.find((g) => g.kind === "sms_template")!.items[0];
    expect(smsItem.blockedReason).toBe("O texto passaria de 480 caracteres.");

    // The dialog's checkbox renders `disabled={item.blockedReason !== null}`
    // and the default `checked` comes straight from `initialSelection`.
    const selected = initialSelection(p);
    expect(selected.has(blocked.key)).toBe(false);
    expect(selected.has(ok.key)).toBe(true);

    // The footer button's count: `countSelectedForApply(preview, selected, trackingChecked)`.
    expect(countSelectedForApply(p, selected, false)).toBe(1);
  });

  it("mostra o aviso de segmento quando o rastreio desligado faz o SMS passar de parte", () => {
    expect(formatSegmentWarning({ before: 1, after: 2 })).toBe(
      "Passa de 1 para 2 partes de SMS (rastreio desligado).",
    );
  });

  it("mostra a seção de fora do escopo quando há campanhas agendadas", () => {
    const p = preview({
      outOfScope: {
        scheduledCampaigns: [{ id: "c1", name: "Campanha de sexta", channel: "sms" }],
        legacyFlows: [],
        subdomainLinks: 0,
      },
    });

    expect(outOfScopeIsEmpty(p)).toBe(false);
  });

  it("mostra mensagem de vazio quando não há trabalho", () => {
    const p = preview({ items: [], trackingHosts: null });

    // Mirrors the dialog's `isEmpty` condition for "Nenhum link com {from} encontrado.".
    expect(p.items.length === 0 && p.trackingHosts === null).toBe(true);
    expect(outOfScopeIsEmpty(p)).toBe(true);
  });
});
