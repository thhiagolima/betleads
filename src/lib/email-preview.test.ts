import { describe, expect, it } from "vitest";

import { emailPreviewText } from "./email-preview";

describe("emailPreviewText", () => {
  it("shows the readable text of an HTML email, not its markup", () => {
    const html =
      '<!doctype html><html><head><style>body{margin:0}</style></head><body style="margin:0"><table><tr><td><h1>Olá, {nome}</h1><p>Seu bônus&nbsp;chegou &amp; vale hoje.</p></td></tr></table></body></html>';
    expect(emailPreviewText(html)).toBe("Olá, {nome} Seu bônus chegou & vale hoje.");
  });

  it("returns empty for no body and cuts long text", () => {
    expect(emailPreviewText(null)).toBe("");
    expect(emailPreviewText(`<p>${"a".repeat(300)}</p>`, 20)).toHaveLength(20);
  });
});
