import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HouseConfigReadOnlyNotice } from "./configuracoes_.casa";

describe("HouseConfigReadOnlyNotice", () => {
  it("shows the read-only notice when canEdit is false", () => {
    const html = renderToStaticMarkup(<HouseConfigReadOnlyNotice canEdit={false} />);
    expect(html).toContain("Só o administrador da casa pode alterar estas configurações.");
  });

  it("hides the notice when canEdit is true", () => {
    const html = renderToStaticMarkup(<HouseConfigReadOnlyNotice canEdit />);
    expect(html).toBe("");
  });

  it("hides the notice before the config has loaded (canEdit undefined)", () => {
    const html = renderToStaticMarkup(<HouseConfigReadOnlyNotice canEdit={undefined} />);
    expect(html).toBe("");
  });
});
