import { describe, expect, it } from "vitest";

import {
  BALANCE_STALE_AFTER_MS,
  balanceBanner,
  computeBalanceStatus,
  parseShortcodeBalance,
  type BalanceCheckRow,
} from "./sms-balance";

// Resposta real do painel (rs=atualiza_box_shortcode), 21/11/2026.
const PANEL_BODY =
  "+:var res = '<h4 class=\\\"widgettitle nomargin\\\">SMS SHORTCODE</h4>\\r\\n\t\t\t<div class=\\\"widgetcontent bordered\\\">\\r\\n\t\t\t\t\t<small><strong>SALDO DISPONÍVEL: -27 SMS(s) </strong> (-0.00082789173383446% DA SUA FRANQUIA)</small>'; res;";

describe("parseShortcodeBalance", () => {
  it("lê o saldo negativo da resposta real", () => {
    expect(parseShortcodeBalance(PANEL_BODY)).toBe(-27);
  });

  it("lê milhar com ponto e acento perdido na decodificação", () => {
    expect(parseShortcodeBalance("SALDO DISPON�VEL: 12.345 SMS(s)")).toBe(12345);
    expect(parseShortcodeBalance("SALDO DISPONÍVEL: 0 SMS(s)")).toBe(0);
  });

  it("devolve null sem o texto do saldo (ex.: página de login)", () => {
    expect(parseShortcodeBalance("<form id=\"loginform\">")).toBeNull();
  });
});

const NOW = new Date("2026-11-21T21:30:00Z");
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
const ok = (minutesAgo: number, sms: number): BalanceCheckRow => ({
  checked_at: at(minutesAgo),
  result: "ok",
  shortcode_sms: sms,
  error: null,
});
const fail = (minutesAgo: number): BalanceCheckRow => ({
  checked_at: at(minutesAgo),
  result: "login_failed",
  shortcode_sms: null,
  error: "O painel recusou o login.",
});

describe("computeBalanceStatus", () => {
  it("saldo acima do limite não avisa", () => {
    const status = computeBalanceStatus([ok(5, 5000)], 1000, NOW);
    expect(status.level).toBe("ok");
    expect(balanceBanner(status)).toBeNull();
  });

  it("no limite ou abaixo avisa saldo acabando", () => {
    const status = computeBalanceStatus([ok(5, 1000)], 1000, NOW);
    expect(status.level).toBe("low");
    expect(balanceBanner(status)).toBe("low");
  });

  it("zerado ou negativo: sem saldo desde a primeira leitura zerada da sequência", () => {
    const status = computeBalanceStatus([ok(5, -27), ok(20, 0), ok(35, 800), ok(50, 4000)], 1000, NOW);
    expect(status.level).toBe("empty");
    expect(status.balance).toBe(-27);
    expect(status.emptySince).toBe(at(20));
    expect(balanceBanner(status)).toBe("empty");
  });

  it("uma falha isolada mantém o último saldo lido", () => {
    const status = computeBalanceStatus([fail(2), ok(17, 500)], 1000, NOW);
    expect(status.level).toBe("low");
    expect(status.lastError).toBe("O painel recusou o login.");
    expect(status.unreadable).toBe(false);
  });

  it("leitura velha não vale; falhas seguidas acusam que não dá para ler", () => {
    const staleMin = BALANCE_STALE_AFTER_MS / 60_000;
    const status = computeBalanceStatus(
      [fail(2), fail(17), fail(32), ok(staleMin + 5, 500)],
      1000,
      NOW,
    );
    expect(status.level).toBe("unknown");
    expect(status.balance).toBeNull();
    expect(status.unreadable).toBe(true);
    expect(balanceBanner(status)).toBe("unreadable");
  });

  it("sem leitura nenhuma (cron parado) acusa que não dá para ler", () => {
    const status = computeBalanceStatus([], 20000, NOW);
    expect(status.unreadable).toBe(true);
    expect(balanceBanner(status)).toBe("unreadable");
  });

  it("última leitura boa mas velha (cron parado) também acusa e diz desde quando", () => {
    const staleMin = BALANCE_STALE_AFTER_MS / 60_000;
    const status = computeBalanceStatus([ok(staleMin + 60, 71482)], 20000, NOW);
    expect(status.level).toBe("unknown");
    expect(status.lastReadAt).toBe(at(staleMin + 60));
    expect(balanceBanner(status)).toBe("unreadable");
  });
});
