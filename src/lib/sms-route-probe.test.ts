import { describe, expect, it } from "vitest";

import {
  DELIVERY_GRACE_MS,
  PROBE_TEMPLATES,
  STALE_AFTER_MS,
  classifyProbeSend,
  computeProbeStatus,
  newProbeCode,
  probeBanners,
  probeMessage,
  type ProbeRow,
} from "./sms-route-probe";

const NOW = new Date("2026-11-13T15:00:00.000Z");
const MIN = 60_000;

function row(minutesAgo: number, patch: Partial<ProbeRow> = {}): ProbeRow {
  return {
    round_id: `r-${minutesAgo}`,
    probe_code: `C${minutesAgo}`,
    phone: "+5511999998888",
    sent_at: new Date(NOW.getTime() - minutesAgo * MIN).toISOString(),
    result: "accepted",
    error: null,
    delivery_status: null,
    delivered_at: null,
    ...patch,
  };
}

describe("probe message", () => {
  it("varies the text and always carries the code", () => {
    const texts = PROBE_TEMPLATES.map((_, i) => probeMessage("AB12CD", i, NOW));
    expect(new Set(texts).size).toBe(PROBE_TEMPLATES.length);
    for (const text of texts) {
      expect(text).toContain("AB12CD");
      expect(text).not.toMatch(/[{}]/);
      expect(text).toMatch(/^[\x20-\x7E]+$/);
    }
  });

  it("generates 6-char codes without ambiguous characters", () => {
    const code = newProbeCode();
    expect(code).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
  });
});

describe("classifyProbeSend", () => {
  it("maps provider summaries", () => {
    expect(classifyProbeSend(true, null)).toBe("accepted");
    expect(classifyProbeSend(false, "Short Brasil: saldo insuficiente")).toBe("no_balance");
    expect(classifyProbeSend(false, "Short Brasil: erro de autenticacao")).toBe("auth_error");
    expect(classifyProbeSend(false, "Sem resposta do provedor: timeout")).toBe("error");
  });
});

describe("computeProbeStatus", () => {
  it("flags no balance since the start of the refused streak", () => {
    const status = computeProbeStatus(
      [
        row(5, { result: "no_balance" }),
        row(35, { result: "no_balance" }),
        row(65, { delivery_status: "delivered" }),
      ],
      true,
      NOW,
    );
    expect(status.balance).toBe("no_balance");
    expect(status.noBalanceSince).toBe(row(35).sent_at);
    expect(probeBanners(status)).toEqual(["no_balance"]);
  });

  it("balance back to ok after an accepted round", () => {
    const status = computeProbeStatus(
      [row(5, { delivery_status: "delivered" }), row(35, { result: "no_balance" })],
      true,
      NOW,
    );
    expect(status.balance).toBe("ok");
    expect(status.delivery).toBe("delivering");
    expect(probeBanners(status)).toEqual([]);
  });

  it("waits the grace period before judging delivery", () => {
    const fresh = computeProbeStatus([row(DELIVERY_GRACE_MS / MIN - 5)], true, NOW);
    expect(fresh.delivery).toBe("pending");
  });

  it("one undelivered probe is not enough; two in a row is", () => {
    const one = computeProbeStatus([row(35), row(65, { delivery_status: "delivered" })], true, NOW);
    expect(one.delivery).toBe("delivering");

    const two = computeProbeStatus(
      [row(35), row(65, { delivery_status: "failed" }), row(95, { delivery_status: "delivered" })],
      true,
      NOW,
    );
    expect(two.delivery).toBe("not_delivering");
    expect(two.notDeliveringSince).toBe(row(65).sent_at);
    expect(probeBanners(two)).toEqual(["not_delivering"]);
  });

  it("no banner when disabled or stale", () => {
    const refused = [row(5, { result: "no_balance" })];
    expect(probeBanners(computeProbeStatus(refused, false, NOW))).toEqual([]);
    const old = [row(STALE_AFTER_MS / MIN + 10, { result: "no_balance" })];
    const status = computeProbeStatus(old, true, NOW);
    expect(status.stale).toBe(true);
    expect(probeBanners(status)).toEqual([]);
  });

  it("reports a non-balance error of the last round", () => {
    const status = computeProbeStatus(
      [row(5, { result: "auth_error", error: "Short Brasil: erro de autenticacao" })],
      true,
      NOW,
    );
    expect(status.balance).toBe("unknown");
    expect(status.lastError).toBe("Short Brasil: erro de autenticacao");
  });
});
