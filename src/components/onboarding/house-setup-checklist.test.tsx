import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  checklistItemLabel,
  checklistProgressLabel,
  HouseSetupChecklistView,
  type SetupChecklist,
} from "./house-setup-checklist";

function makeChecklist(): SetupChecklist {
  return {
    items: [
      { id: "house", state: "done" },
      { id: "shortener", state: "pending_dns" },
      { id: "email", state: "todo" },
    ],
    complete: false,
  };
}

describe("checklistItemLabel", () => {
  it("done and todo items read the plain label", () => {
    expect(checklistItemLabel({ id: "house", state: "done" })).toBe("URL da casa e URLs rápidas");
    expect(checklistItemLabel({ id: "email", state: "todo" })).toBe("Domínio e remetente de e-mail");
  });

  it("pending_dns items append the DNS-wait suffix", () => {
    expect(checklistItemLabel({ id: "shortener", state: "pending_dns" })).toBe(
      "Domínio do encurtador · aguardando DNS",
    );
  });
});

describe("checklistProgressLabel", () => {
  it("counts how many items are done out of the total", () => {
    expect(checklistProgressLabel(makeChecklist().items)).toBe("1 de 3");
  });
});

describe("HouseSetupChecklistView", () => {
  it("renders the progress, every item's label and a link to /configuracoes/casa", () => {
    const html = renderToStaticMarkup(<HouseSetupChecklistView checklist={makeChecklist()} />);

    expect(html).toContain("1 de 3");
    expect(html).toContain("URL da casa e URLs rápidas");
    expect(html).toContain("Domínio do encurtador · aguardando DNS");
    expect(html).toContain("Domínio e remetente de e-mail");
    expect(html).toContain('href="/configuracoes/casa"');
  });

  it("renders nothing when the checklist is complete", () => {
    const html = renderToStaticMarkup(
      <HouseSetupChecklistView checklist={{ ...makeChecklist(), complete: true }} />,
    );

    expect(html).toBe("");
  });
});
