import { describe, expect, it, vi } from "vitest";
import {
  deadLeadActionLabel,
  deadLeadRevivedReasonLabel,
  maskDeadLeadEmail,
  normalizeBackfillResult,
  parseDeadLeadThreshold,
  runBackfillRounds,
  sanitizeDeadLeadSearch,
} from "./dead-leads.shared";

describe("dead leads helpers", () => {
  it("labels the last action in Portuguese and says when the lead never acted", () => {
    expect(deadLeadActionLabel("deposito")).toBe("Depósito");
    expect(deadLeadActionLabel("ftd")).toBe("1º depósito");
    expect(deadLeadActionLabel("login")).toBe("Login");
    expect(deadLeadActionLabel("jogo")).toBe("Jogo");
    expect(deadLeadActionLabel("clique")).toBe("Clique em link");
    expect(deadLeadActionLabel(null)).toBe("Nunca agiu");
    expect(deadLeadActionLabel("outro")).toBe("outro");
  });

  it("labels the revive reason", () => {
    expect(deadLeadRevivedReasonLabel("activity")).toBe("voltou a agir");
    expect(deadLeadRevivedReasonLabel("manual")).toBe("reativado manualmente");
    expect(deadLeadRevivedReasonLabel(null)).toBeNull();
  });

  it("parses the threshold within 2..50, blank = default 5", () => {
    expect(parseDeadLeadThreshold("")).toBe(5);
    expect(parseDeadLeadThreshold(" 7 ")).toBe(7);
    expect(parseDeadLeadThreshold("2")).toBe(2);
    expect(parseDeadLeadThreshold("50")).toBe(50);
    expect(parseDeadLeadThreshold("1")).toBeNull();
    expect(parseDeadLeadThreshold("51")).toBeNull();
    expect(parseDeadLeadThreshold("4.5")).toBeNull();
    expect(parseDeadLeadThreshold("abc")).toBeNull();
  });

  it("normalizes the backfill jsonb", () => {
    expect(normalizeBackfillResult({ evaluated: "10", marked: 3, remaining: true })).toEqual({
      evaluated: 10,
      marked: 3,
      remaining: true,
    });
    expect(normalizeBackfillResult(null)).toEqual({ evaluated: 0, marked: 0, remaining: false });
  });

  it("loops the backfill while there is something remaining and accumulates the marked leads", async () => {
    const step = vi
      .fn()
      .mockResolvedValueOnce({ evaluated: 2000, marked: 10, remaining: true })
      .mockResolvedValueOnce({ evaluated: 500, marked: 2, remaining: false });
    const progress = vi.fn();
    const result = await runBackfillRounds(step, progress);
    expect(step).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ rounds: 2, evaluated: 500, marked: 12, complete: true });
  });

  it("stops at the round cap and when a round marks nobody", async () => {
    const endless = vi.fn().mockResolvedValue({ evaluated: 1, marked: 1, remaining: true });
    expect(await runBackfillRounds(endless, undefined, 3)).toEqual({
      rounds: 3,
      evaluated: 1,
      marked: 3,
      complete: false,
    });
    const stuck = vi.fn().mockResolvedValue({ evaluated: 0, marked: 0, remaining: true });
    const result = await runBackfillRounds(stuck);
    expect(stuck).toHaveBeenCalledTimes(1);
    expect(result.complete).toBe(false);
  });

  it("sanitizes the search for PostgREST or()", () => {
    expect(sanitizeDeadLeadSearch(" (11) 9,8*7% ")).toBe("11  9 8 7");
    expect(sanitizeDeadLeadSearch(null)).toBe("");
  });

  it("masks e-mails", () => {
    expect(maskDeadLeadEmail("joao@gmail.com")).toBe("j•••@gmail.com");
    expect(maskDeadLeadEmail("")).toBeNull();
    expect(maskDeadLeadEmail("semarroba")).toBe("•••");
  });
});
