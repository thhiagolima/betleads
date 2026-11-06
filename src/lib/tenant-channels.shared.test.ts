// newDisabledChannelSteps (Task 7): diff puro usado por saveJourney e
// setJourneyStatus para recusar só passos novos/alterados de canal
// desligado, mantendo salvável uma jornada antiga que já tinha o passo.
//
// Shape real: os passos armazenados vêm do banco COM id; os de entrada
// (payload do editor / versão publicada) chegam SEM id ou com outro id —
// o casamento é só por conteúdo (multiconjunto), ignorando ids, com
// stringify estável (jsonb reordena as chaves).
import { describe, expect, it } from "vitest";
import { newDisabledChannelSteps, stableStringify, type StepLike } from "./tenant-channels.shared";

describe("stableStringify", () => {
  it("independe da ordem das chaves, recursivamente", () => {
    expect(stableStringify({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(
      stableStringify({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }),
    );
  });

  it("preserva a ordem dos arrays", () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });
});

describe("newDisabledChannelSteps", () => {
  it("passo voice armazenado (com id) inalterado chegando sem id → []", () => {
    const stored: StepLike[] = [{ id: "db-1", step_type: "voice", config: { asset_id: "a1" } }];
    const incoming: StepLike[] = [{ step_type: "voice", config: { asset_id: "a1" } }];
    expect(newDisabledChannelSteps(stored, incoming, new Set(["voice"]))).toEqual([]);
  });

  it("config com chaves em outra ordem (jsonb reordena) continua casando", () => {
    const stored: StepLike[] = [
      {
        id: "db-1",
        step_type: "sms",
        config: { variants: [{ weight: 50, content: "B" }], content: "Oi", link: { url: "https://x", tracked: true } },
      },
    ];
    const incoming: StepLike[] = [
      {
        step_type: "sms",
        config: { content: "Oi", link: { tracked: true, url: "https://x" }, variants: [{ content: "B", weight: 50 }] },
      },
    ];
    expect(newDisabledChannelSteps(stored, incoming, new Set(["sms"]))).toEqual([]);
  });

  it("ids diferentes (rascunho vs publicada) com mesmo conteúdo → []", () => {
    const stored: StepLike[] = [{ id: "published-1", step_type: "voice", config: { asset_id: "a1" } }];
    const incoming: StepLike[] = [{ id: "draft-1", step_type: "voice", config: { asset_id: "a1" } }];
    expect(newDisabledChannelSteps(stored, incoming, new Set(["voice"]))).toEqual([]);
  });

  it("passo alterado (mesmo id ou sem id) → [passo]", () => {
    const stored: StepLike[] = [{ id: "db-1", step_type: "voice", config: { asset_id: "a1" } }];
    const sameId: StepLike[] = [{ id: "db-1", step_type: "voice", config: { asset_id: "a2" } }];
    const noId: StepLike[] = [{ step_type: "voice", config: { asset_id: "a2" } }];
    expect(newDisabledChannelSteps(stored, sameId, new Set(["voice"]))).toEqual(sameId);
    expect(newDisabledChannelSteps(stored, noId, new Set(["voice"]))).toEqual(noId);
  });

  it("passo voice novo (sem correspondência em stored) → [passo]", () => {
    const incoming: StepLike[] = [{ step_type: "voice", config: { asset_id: "a1" } }];
    expect(newDisabledChannelSteps([], incoming, new Set(["voice"]))).toEqual(incoming);
  });

  it("passo voice removido (não está em incoming) → []", () => {
    const stored: StepLike[] = [{ id: "db-1", step_type: "voice", config: { asset_id: "a1" } }];
    expect(newDisabledChannelSteps(stored, [], new Set(["voice"]))).toEqual([]);
  });

  it("ignora passos de canal ligado", () => {
    const incoming: StepLike[] = [{ step_type: "voice", config: { asset_id: "a1" } }];
    expect(newDisabledChannelSteps([], incoming, new Set(["sms"]))).toEqual([]);
  });

  it("ignora wait/end (não mapeados em STEP_TYPE_CHANNEL)", () => {
    const incoming: StepLike[] = [{ step_type: "wait", config: { delay_seconds: 60 } }];
    expect(
      newDisabledChannelSteps([], incoming, new Set(["sms", "email", "voice", "webpush"])),
    ).toEqual([]);
  });

  it("multiconjunto: dois armazenados (com id) e três idênticos chegando → o terceiro é recusado", () => {
    const stored: StepLike[] = [
      { id: "db-1", step_type: "sms", config: { content: "Oi" } },
      { id: "db-2", step_type: "sms", config: { content: "Oi" } },
    ];
    const incoming: StepLike[] = [
      { step_type: "sms", config: { content: "Oi" } },
      { step_type: "sms", config: { content: "Oi" } },
      { step_type: "sms", config: { content: "Oi" } },
    ];
    expect(newDisabledChannelSteps(stored, incoming, new Set(["sms"]))).toEqual([incoming[2]]);
  });

  it("step_type faz parte da identidade", () => {
    const stored: StepLike[] = [{ id: "db-1", step_type: "sms", config: { content: "Oi" } }];
    const incoming: StepLike[] = [{ step_type: "email", config: { content: "Oi" } }];
    expect(newDisabledChannelSteps(stored, incoming, new Set(["email"]))).toEqual(incoming);
  });
});
