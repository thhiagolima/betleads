import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CampaignBlockedBadge } from "./campaign-blocked-badge";

describe("CampaignBlockedBadge", () => {
  it("renders nothing without a blocked reason", () => {
    expect(renderToStaticMarkup(<CampaignBlockedBadge reason={null} />)).toBe("");
    expect(renderToStaticMarkup(<CampaignBlockedBadge reason="" />)).toBe("");
  });

  it("shows a Bloqueada badge with the reason as tooltip", () => {
    const reason = "O remetente escolhido não está mais disponível.";
    const html = renderToStaticMarkup(<CampaignBlockedBadge reason={reason} />);
    expect(html).toContain("Bloqueada");
    expect(html).toContain(`title="${reason}"`);
    expect(html).toContain(`aria-label="Envio bloqueado: ${reason}"`);
  });
});
