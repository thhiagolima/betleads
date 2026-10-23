import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PageTabs } from "./page-tabs";

const items = [
  { value: "visao-geral", label: "Visão geral" },
  { value: "templates", label: "Templates" },
  { value: "historico", label: "Histórico" },
];

describe("PageTabs", () => {
  const html = renderToStaticMarkup(
    <PageTabs value="templates" onValueChange={() => {}} items={items} />,
  );

  it("renders a tablist with one tab per item", () => {
    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toContain("Visão geral");
    expect(html).toContain("Histórico");
  });

  it("marks only the active tab as selected and focusable", () => {
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-selected="true"[^>]*tabindex="0"[^>]*>Templates</i);
    expect(html.match(/tabindex="-1"/gi)).toHaveLength(2);
  });

  it("gives the active tab the secondary background and never wraps", () => {
    expect(html).toMatch(/aria-selected="true"[^>]*class="[^"]*bg-secondary/);
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("whitespace-nowrap");
  });
});
