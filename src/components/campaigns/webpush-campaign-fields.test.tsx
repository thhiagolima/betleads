import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Same convention as channel-campaign-composer.test.tsx: the Select's
// SelectContent is a Radix portal, replaced here with a plain div so its
// items show up in the static markup.
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

import { brl } from "@/lib/format";
import { EMPTY_SMS_AUDIENCE } from "@/lib/sms-audience-criteria";
import {
  WebpushCampaignFields,
  buildWebpushScheduleInput,
} from "./webpush-campaign-fields";

const noop = () => undefined;
const noop2 = () => undefined;

const baseProps = {
  title: "",
  onTitleChange: noop,
  body: "",
  onBodyChange: noop,
  url: "",
  onUrlChange: noop,
  imageUrl: "",
  onImageUrlChange: noop,
  audienceKind: "todos" as const,
  onAudienceKindChange: noop,
  audienceOptions: [],
  audienceId: "",
  onAudienceChange: noop2,
  counts: undefined,
  countsLoading: false,
  submitAttempted: false,
};

const render = (overrides: Partial<Parameters<typeof WebpushCampaignFields>[0]> = {}) =>
  renderToStaticMarkup(<WebpushCampaignFields {...baseProps} {...overrides} />);

describe("WebpushCampaignFields", () => {
  it("marks the title and link invalid once submit was attempted", () => {
    const html = render({ title: "", url: "http://inseguro.com", submitAttempted: true });
    // Title input: empty, must be invalid.
    expect(html).toMatch(/id="webpush-title"[^>]*aria-invalid="true"/);
    // Link: not https, must be invalid.
    expect(html).toMatch(/id="webpush-url"[^>]*aria-invalid="true"/);
  });

  it("does not mark fields invalid before submit was attempted, even if empty", () => {
    const html = render({ title: "", url: "", submitAttempted: false });
    expect(html).toMatch(/id="webpush-title"[^>]*aria-invalid="false"/);
    expect(html).toMatch(/id="webpush-url"[^>]*aria-invalid="false"/);
  });

  it("a valid title and https link are not marked invalid", () => {
    const html = render({
      title: "Bônus liberado",
      url: "https://casa.bet/promo",
      submitAttempted: true,
    });
    expect(html).toMatch(/id="webpush-title"[^>]*aria-invalid="false"/);
    expect(html).toMatch(/id="webpush-url"[^>]*aria-invalid="false"/);
  });

  it("'todos' shows no saved-audience picker; 'filtro' shows it", () => {
    const todos = render({ audienceKind: "todos" });
    expect(todos).toContain("Todos os inscritos ativos de web push desta casa.");
    expect(todos).not.toContain("Selecione um público salvo");

    const filtro = render({
      audienceKind: "filtro",
      audienceOptions: [{ id: "a1", name: "VIP", criteria: EMPTY_SMS_AUDIENCE }],
    });
    expect(filtro).toContain("Público salvo");
    expect(filtro).toContain("VIP");
    expect(filtro).not.toContain("Todos os inscritos ativos de web push desta casa.");
  });

  it("shows the estimated cost, never the raw unit price", () => {
    const html = render({
      counts: { subscriptions: 1200, players: null, unitPrice: 0.01, estimatedCost: 12 },
      countsLoading: false,
    });
    expect(html).toContain(`custo estimado ${brl(12)}`);
    // The unit price itself (R$ 0,01) must never show up — only the aggregate.
    expect(html).not.toContain(brl(0.01));
  });

  it("shows 'isento' when the house's unit price is 0, with no price text", () => {
    const html = render({
      counts: { subscriptions: 500, players: null, unitPrice: 0, estimatedCost: 0 },
      countsLoading: false,
    });
    expect(html).toContain("isento");
    expect(html).not.toContain("R$");
  });

  it("shows a loading state while the count is in flight", () => {
    const html = render({ counts: undefined, countsLoading: true });
    expect(html).toContain("Calculando o público…");
  });
});

describe("buildWebpushScheduleInput", () => {
  const base = {
    name: "Campanha",
    title: "Bônus liberado",
    body: "Clique para ver",
    url: "https://casa.bet/promo",
    imageUrl: "",
    scheduledAt: null,
  };

  it("'todos' produces { kind: 'todos' } with no criteria key", () => {
    const result = buildWebpushScheduleInput({
      ...base,
      audienceKind: "todos",
      audienceCriteria: null,
    });
    expect(result.audience).toEqual({ kind: "todos" });
    expect("criteria" in result.audience).toBe(false);
  });

  it("'filtro' passes the exact same criteria object through, unchanged", () => {
    const criteria = { playerIds: ["p1", "p2"], nested: { a: 1 } };
    const result = buildWebpushScheduleInput({
      ...base,
      audienceKind: "filtro",
      audienceCriteria: criteria as never,
    });
    expect(result.audience).toEqual({ kind: "filtro", criteria });
    // Same reference, not a clone: the server must receive exactly what was selected.
    expect((result.audience as { criteria: unknown }).criteria).toBe(criteria);
  });

  it("'filtro' with no criteria selected falls back to {}", () => {
    const result = buildWebpushScheduleInput({
      ...base,
      audienceKind: "filtro",
      audienceCriteria: null,
    });
    expect(result.audience).toEqual({ kind: "filtro", criteria: {} });
  });

  it("validates content the same way the server does (title/body/url/image)", () => {
    expect(() =>
      buildWebpushScheduleInput({
        ...base,
        title: "",
        audienceKind: "todos",
        audienceCriteria: null,
      }),
    ).toThrow(/título/i);
    expect(() =>
      buildWebpushScheduleInput({
        ...base,
        url: "http://inseguro.com",
        audienceKind: "todos",
        audienceCriteria: null,
      }),
    ).toThrow(/https/i);
  });

  it("passes name/title/body/url/scheduledAt through", () => {
    const result = buildWebpushScheduleInput({
      ...base,
      scheduledAt: "2026-11-10T10:00:00.000Z",
      audienceKind: "todos",
      audienceCriteria: null,
    });
    expect(result.name).toBe("Campanha");
    expect(result.title).toBe("Bônus liberado");
    expect(result.body).toBe("Clique para ver");
    expect(result.url).toBe("https://casa.bet/promo");
    expect(result.scheduledAt).toBe("2026-11-10T10:00:00.000Z");
    expect(result.imageUrl).toBeNull();
  });
});
