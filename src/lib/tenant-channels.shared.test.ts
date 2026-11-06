// newDisabledChannelSteps (Task 7): diff puro usado por saveJourney e
// setJourneyStatus para recusar só passos novos/alterados de canal
// desligado, mantendo salvável uma jornada antiga que já tinha o passo.
import { describe, expect, it } from "vitest";
import { newDisabledChannelSteps, type StepLike } from "./tenant-channels.shared";

const voiceStep = (over: Partial<StepLike> = {}): StepLike => ({
  id: "step-1",
  step_type: "voice",
  config: { asset_id: "a1" },
  ...over,
});

describe("newDisabledChannelSteps", () => {
  it("passo voice antigo inalterado (mesmo id e config) → []", () => {
    const stored = [voiceStep()];
    const incoming = [voiceStep()];
    expect(newDisabledChannelSteps(stored, incoming, new Set(["voice"]))).toEqual([]);
  });

  it("mesmo passo (mesmo id) com texto alterado → [passo]", () => {
    const stored = [voiceStep({ config: { asset_id: "a1" } })];
    const incoming = [voiceStep({ config: { asset_id: "a2" } })];
    expect(newDisabledChannelSteps(stored, incoming, new Set(["voice"]))).toEqual([
      incoming[0],
    ]);
  });

  it("passo voice novo (sem correspondência em stored) → [passo]", () => {
    const stored: StepLike[] = [];
    const incoming = [voiceStep({ id: null })];
    expect(newDisabledChannelSteps(stored, incoming, new Set(["voice"]))).toEqual([
      incoming[0],
    ]);
  });

  it("passo voice removido (não está em incoming) → []", () => {
    const stored = [voiceStep()];
    const incoming: StepLike[] = [];
    expect(newDisabledChannelSteps(stored, incoming, new Set(["voice"]))).toEqual([]);
  });

  it("ignora passos de canal ligado", () => {
    const stored: StepLike[] = [];
    const incoming = [voiceStep({ id: null })];
    expect(newDisabledChannelSteps(stored, incoming, new Set(["sms"]))).toEqual([]);
  });

  it("ignora wait/end (não mapeados em STEP_TYPE_CHANNEL)", () => {
    const incoming: StepLike[] = [{ step_type: "wait", config: { delay_seconds: 60 } }];
    expect(
      newDisabledChannelSteps([], incoming, new Set(["sms", "email", "voice", "webpush"])),
    ).toEqual([]);
  });

  it("sem id dos dois lados: casa por step_type+config como multiconjunto", () => {
    const stepA: StepLike = { step_type: "sms", config: { content: "Oi" } };
    const stepB: StepLike = { step_type: "sms", config: { content: "Oi" } };
    const stepC: StepLike = { step_type: "sms", config: { content: "Oi" } };
    // Dois passos idênticos armazenados, três chegando: dois casam, o
    // terceiro (sem par restante) é flagueado.
    const result = newDisabledChannelSteps([stepA, stepB], [stepA, stepB, stepC], new Set(["sms"]));
    expect(result).toEqual([stepC]);
  });
});
