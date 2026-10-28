import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { firstPendingDate, PendingBanner, tenantPendingText } from "./pending-banner";

// No jsdom: "Lançar agora" calls onLaunchPending(firstPendingDate(dates)),
// and firstPendingDate is exercised directly here.
describe("PendingBanner", () => {
  it("lists dates and calls onLaunchPending with the first one", () => {
    const dates = ["2026-10-18", "2026-10-12", "2026-10-19"];
    const html = renderToStaticMarkup(
      <PendingBanner
        scopeKind="tenant"
        tenants={[{ id: "a", nome: "Pixreals", pendingDates: dates }]}
        duplicateBetleadsCosts={0}
        onLaunchPending={() => {}}
      />,
    );

    expect(html).toContain("Faltam 3 dias de lançamento (12, 18, 19). O lucro está incompleto.");
    expect(html).toContain("Lançar agora");
    expect(firstPendingDate(dates)).toBe("2026-10-12");
    expect(firstPendingDate([])).toBeNull();
  });

  it("uses day/month when the dates span more than one month, and singular for one day", () => {
    const spanning = renderToStaticMarkup(
      <PendingBanner
        scopeKind="tenant"
        tenants={[{ id: "a", nome: "Pixreals", pendingDates: ["2026-09-30", "2026-10-01"] }]}
        duplicateBetleadsCosts={0}
      />,
    );
    expect(spanning).toContain("Faltam 2 dias de lançamento (30/09, 01/10).");
    expect(spanning).not.toContain("Lançar agora");

    const one = renderToStaticMarkup(
      <PendingBanner
        scopeKind="tenant"
        tenants={[{ id: "a", nome: "Pixreals", pendingDates: ["2026-10-07"] }]}
        duplicateBetleadsCosts={0}
      />,
    );
    expect(one).toContain("Falta 1 dia de lançamento (7). O lucro está incompleto.");
  });

  it("lists the houses with missing days in group scope", () => {
    const html = renderToStaticMarkup(
      <PendingBanner
        scopeKind="group"
        tenants={[
          { id: "a", nome: "Bravabet", pendingDates: ["2026-10-01", "2026-10-02", "2026-10-03"] },
          { id: "b", nome: "Forrandobet", pendingDates: [] },
          { id: "c", nome: "Pixreals", pendingDates: ["2026-10-05"] },
        ]}
        duplicateBetleadsCosts={0}
        onLaunchPending={() => {}}
      />,
    );

    expect(html).toContain("Casas com dias faltando: Bravabet (3), Pixreals (1)");
    expect(html).not.toContain("Forrandobet");
    expect(html).not.toContain("Lançar agora");
  });

  it("shows the duplicate warning when duplicateBetleadsCosts > 0", () => {
    const html = renderToStaticMarkup(
      <PendingBanner
        scopeKind="tenant"
        tenants={[{ id: "a", nome: "Pixreals", pendingDates: [] }]}
        duplicateBetleadsCosts={2}
      />,
    );

    expect(html).toContain(
      "Pode haver custo Betleads contado duas vezes. Revise em Outros custos.",
    );
    expect(html).not.toContain("Falta");
  });

  it("renders nothing when there is nothing pending and no duplicate", () => {
    const html = renderToStaticMarkup(
      <PendingBanner
        scopeKind="tenant"
        tenants={[{ id: "a", nome: "Pixreals", pendingDates: [] }]}
        duplicateBetleadsCosts={0}
      />,
    );

    expect(html).toBe("");
  });

  it("asks to update the month's GGR when the pending days come from its 'atualizado até'", () => {
    const html = renderToStaticMarkup(
      <PendingBanner
        scopeKind="tenant"
        tenants={[
          {
            id: "a",
            nome: "Pixreals",
            pendingDates: ["2026-10-21", "2026-10-22"],
            ggrUpdatedThrough: "2026-10-20",
          },
        ]}
        duplicateBetleadsCosts={0}
        onLaunchPending={() => {}}
      />,
    );
    expect(html).toContain("GGR atualizado até 20/10 — atualize para fechar o lucro.");
    expect(html).not.toContain("Faltam");
    expect(html).toContain("Lançar agora");

    expect(tenantPendingText(["2026-10-21"], "2026-10-20")).toBe(
      "GGR atualizado até 20/10 — atualize para fechar o lucro.",
    );
    expect(tenantPendingText(["2026-10-07"], null)).toBe(
      "Falta 1 dia de lançamento (7). O lucro está incompleto.",
    );
    expect(tenantPendingText(["2026-10-07", "2026-10-08"], undefined)).toBe(
      "Faltam 2 dias de lançamento (7, 8). O lucro está incompleto.",
    );
  });
});
