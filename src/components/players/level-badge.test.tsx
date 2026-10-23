import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LEVEL_LABEL, type LevelSlug } from "@/lib/player-level";

import { LevelBadge } from "./level-badge";
import { LEVEL_TONE } from "./player-tones";
import { SituationText } from "./situation-text";

describe("LevelBadge", () => {
  it("shows the pt-BR label of the level with its tone", () => {
    const html = renderToStaticMarkup(<LevelBadge level="gold" />);
    expect(html).toContain(">Ouro<");
    expect(html).toContain(LEVEL_TONE.gold.text);
    expect(html).toContain(LEVEL_TONE.gold.border);
    expect(html.startsWith("<span")).toBe(true);
  });

  it("has one distinct tone per level", () => {
    const levels = Object.keys(LEVEL_LABEL) as LevelSlug[];
    const tones = new Set(levels.map((level) => LEVEL_TONE[level].text));
    expect(tones.size).toBe(levels.length);
    for (const level of levels) {
      expect(renderToStaticMarkup(<LevelBadge level={level} />)).toContain(LEVEL_LABEL[level]);
    }
  });

  it("keeps extra classes", () => {
    expect(renderToStaticMarkup(<LevelBadge level="black" className="ml-2" />)).toContain("ml-2");
  });
});

describe("SituationText", () => {
  it("uses the shared label and tone", () => {
    const html = renderToStaticMarkup(<SituationText situation="cooling" />);
    expect(html).toContain("Esfriando");
    expect(html).toContain("text-warning");
  });
});
