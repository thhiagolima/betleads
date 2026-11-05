// Maintenance test (spec §6): every screen must have an article, be
// excluded, or be pending; every anchor/term is wired up in both
// directions. Reads the actual source tree with `fs`, so it keeps enforcing
// the rules as real articles/screens are added in later tasks — right now,
// with zero articles registered, everything here is vacuously true except
// the route-classification checks (rule 1 and rule 5), which already have
// real content to check against.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ROUTE_META } from "@/lib/navigation";
import {
  countRawDataTourUsages,
  extractTermIds,
  extractTourAnchorCalls,
  isTestFile,
} from "./coverage-scan";
import { ANCHORS_PENDING_ARTICLE, EXCLUDED_ROUTES, PENDING_ROUTES } from "./coverage-config";
import { GLOSSARY } from "./glossary";
import { GUIDES } from "./guides";
import { HELP_SCREEN_LOADERS } from "./registry";
import type { HelpScreen } from "./types";

const SRC_ROOT = path.resolve(__dirname, "..");
const ANCHOR_FILE = path.resolve(__dirname, "anchor.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !isTestFile(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const sourceFiles = walk(SRC_ROOT);

async function loadAllScreens(): Promise<HelpScreen[]> {
  const screens: HelpScreen[] = [];
  for (const loader of Object.values(HELP_SCREEN_LOADERS)) {
    const mod = await loader();
    screens.push(mod.default);
  }
  return screens;
}

function declaredAnchors(): Set<string> {
  const declared = new Set<string>();
  for (const file of sourceFiles) {
    for (const id of extractTourAnchorCalls(fs.readFileSync(file, "utf8"))) declared.add(id);
  }
  return declared;
}

function citedAnchors(screens: HelpScreen[]): Set<string> {
  const cited = new Set<string>(ANCHORS_PENDING_ARTICLE);
  for (const screen of screens) {
    for (const section of screen.sections) {
      for (const item of section.items) {
        if (item.anchor) cited.add(item.anchor);
      }
    }
    for (const steps of Object.values(screen.tours)) {
      for (const step of steps) cited.add(step.anchor);
    }
  }
  for (const guide of GUIDES) {
    for (const step of guide.steps) {
      if (step.anchor) cited.add(step.anchor);
    }
  }
  return cited;
}

describe("help coverage", () => {
  it('toda rota de ROUTE_META tem artigo, está excluída ou pendente', () => {
    const loaderRoutes = new Set(Object.keys(HELP_SCREEN_LOADERS));
    for (const route of Object.keys(ROUTE_META)) {
      const covered =
        loaderRoutes.has(route) ||
        EXCLUDED_ROUTES.includes(route) ||
        PENDING_ROUTES.some((pending) => pending === route || pending.startsWith(`${route}#`));
      expect(covered, `rota sem artigo, exclusão ou pendência: ${route}`).toBe(true);
    }
  });

  it('nenhuma rota está ao mesmo tempo com artigo e em PENDING/EXCLUDED', () => {
    const loaderRoutes = Object.keys(HELP_SCREEN_LOADERS);
    for (const route of loaderRoutes) {
      expect(EXCLUDED_ROUTES.includes(route), `rota com artigo também excluída: ${route}`).toBe(
        false,
      );
      expect(
        PENDING_ROUTES.includes(route),
        `rota com artigo também pendente por inteiro: ${route}`,
      ).toBe(false);
    }
    // The reverse: a plain (non "#aba") EXCLUDED/PENDING route can't be the
    // same route twice, and the two lists can't overlap on a plain route.
    const excludedSet = new Set(EXCLUDED_ROUTES);
    const plainPending = PENDING_ROUTES.filter((route) => !route.includes("#"));
    for (const route of plainPending) {
      expect(excludedSet.has(route), `rota ao mesmo tempo excluída e pendente: ${route}`).toBe(
        false,
      );
    }
  });

  it('toda âncora citada em artigo/tour/guia existe como tourAnchor("…") em src/', async () => {
    const declared = declaredAnchors();
    const screens = await loadAllScreens();
    for (const screen of screens) {
      for (const section of screen.sections) {
        for (const item of section.items) {
          if (!item.anchor) continue;
          expect(
            declared.has(item.anchor),
            `âncora citada em "${screen.id}" sem tourAnchor() em src/: ${item.anchor}`,
          ).toBe(true);
        }
      }
      for (const [tab, steps] of Object.entries(screen.tours)) {
        for (const step of steps) {
          expect(
            declared.has(step.anchor),
            `âncora do tour "${screen.id}#${tab}" sem tourAnchor() em src/: ${step.anchor}`,
          ).toBe(true);
        }
      }
    }
    for (const guide of GUIDES) {
      for (const step of guide.steps) {
        if (!step.anchor) continue;
        expect(
          declared.has(step.anchor),
          `âncora citada pelo guia "${guide.id}" sem tourAnchor() em src/: ${step.anchor}`,
        ).toBe(true);
      }
    }
  });

  it('todo tourAnchor("…") em src/ é citado por algum artigo', async () => {
    const declared = declaredAnchors();
    const screens = await loadAllScreens();
    const cited = citedAnchors(screens);
    for (const id of declared) {
      expect(cited.has(id), `tourAnchor("${id}") não citado por nenhum artigo`).toBe(true);
    }
  });

  it("proíbe data-tour cru fora de src/help/anchor.ts", () => {
    for (const file of sourceFiles) {
      if (file === ANCHOR_FILE) continue;
      const count = countRawDataTourUsages(fs.readFileSync(file, "utf8"));
      expect(count, `data-tour escrito à mão em ${path.relative(SRC_ROOT, file)}`).toBe(0);
    }
  });

  it("todo <Term id> e todo screen.terms existe no GLOSSARY", async () => {
    const glossaryIds = new Set(GLOSSARY.map((term) => term.id));
    for (const file of sourceFiles) {
      for (const id of extractTermIds(fs.readFileSync(file, "utf8"))) {
        expect(glossaryIds.has(id), `<Term id="${id}"> sem definição em GLOSSARY`).toBe(true);
      }
    }
    const screens = await loadAllScreens();
    for (const screen of screens) {
      for (const termId of screen.terms ?? []) {
        expect(glossaryIds.has(termId), `screen.terms "${termId}" sem definição em GLOSSARY`).toBe(
          true,
        );
      }
    }
  });

  it("todo passo de tour tem anchor e body não vazios; cada tour tem de 1 a 8 passos", async () => {
    const screens = await loadAllScreens();
    for (const screen of screens) {
      for (const [tab, steps] of Object.entries(screen.tours)) {
        expect(
          steps.length,
          `tour "${screen.id}#${tab}" precisa ter entre 1 e 8 passos (tem ${steps.length})`,
        ).toBeGreaterThanOrEqual(1);
        expect(steps.length).toBeLessThanOrEqual(8);
        for (const step of steps) {
          expect(step.anchor.length > 0, `tour "${screen.id}#${tab}" com anchor vazio`).toBe(true);
          expect(step.body.length > 0, `tour "${screen.id}#${tab}" com body vazio`).toBe(true);
        }
      }
    }
  });

  it("GLOSSARY não tem ids duplicados", () => {
    const ids = GLOSSARY.map((term) => term.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("toda entrada de EXCLUDED_ROUTES e PENDING_ROUTES é uma rota real de ROUTE_META", () => {
    const routeKeys = new Set(Object.keys(ROUTE_META));
    for (const route of EXCLUDED_ROUTES) {
      expect(routeKeys.has(route), `EXCLUDED_ROUTES tem rota inexistente em ROUTE_META: ${route}`).toBe(
        true,
      );
    }
    for (const pending of PENDING_ROUTES) {
      const route = pending.split("#")[0];
      expect(
        routeKeys.has(route),
        `PENDING_ROUTES tem rota inexistente em ROUTE_META: ${pending}`,
      ).toBe(true);
    }
  });
});
