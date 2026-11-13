// The popup runtime is a plain ES5 string embedded in the house's page; the
// rule core is executed here directly, the rest is compiled for syntax.
import { describe, expect, it } from "vitest";

import { POPUP_CORE_JS, POPUP_RUNTIME_JS } from "./popup-runtime";

type Popup = Record<string, unknown> & { id: string };
type Core = {
  matchPath: (pattern: string, path: string) => boolean;
  pageAllowed: (popup: Popup, path: string) => boolean;
  isDue: (popup: Popup, now: number) => boolean;
  pick: (popups: Popup[], path: string, now: number) => Popup | null;
  markShown: (popup: Popup, now: number) => void;
  markClicked: (popup: Popup) => void;
};

function memoryStorage() {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
}

function makeCore(storage: unknown = memoryStorage(), session: unknown = memoryStorage()): Core {
  return new Function("storage", "session", `${POPUP_CORE_JS}; return betleadsPopupCore(storage, session);`)(
    storage,
    session,
  ) as Core;
}

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 13, 15, 0, 0).getTime();

function popup(over: Partial<Popup> = {}): Popup {
  return { id: "p1", paginasModo: "todas", paginas: [], frequencia: "dia", frequenciaDias: null, ...over };
}

describe("matchPath / pageAllowed", () => {
  const core = makeCore();
  it("matches exact paths ignoring trailing slash, query and hash", () => {
    expect(core.matchPath("/", "/")).toBe(true);
    expect(core.matchPath("/cassino", "/cassino/?a=1")).toBe(true);
    expect(core.matchPath("/cassino", "/cassino/slots")).toBe(false);
  });
  it("matches wildcards on the path and below", () => {
    expect(core.matchPath("/cassino/*", "/cassino")).toBe(true);
    expect(core.matchPath("/cassino/*", "/cassino/slots/x")).toBe(true);
    expect(core.matchPath("/cassino/*", "/cassinos")).toBe(false);
    expect(core.matchPath("/*", "/qualquer")).toBe(true);
  });
  it("applies incluir and excluir", () => {
    const incluir = popup({ paginasModo: "incluir", paginas: ["/"] });
    const excluir = popup({ paginasModo: "excluir", paginas: ["/deposito/*"] });
    expect(core.pageAllowed(incluir, "/")).toBe(true);
    expect(core.pageAllowed(incluir, "/cassino")).toBe(false);
    expect(core.pageAllowed(excluir, "/deposito/pix")).toBe(false);
    expect(core.pageAllowed(excluir, "/cassino")).toBe(true);
  });
});

describe("isDue", () => {
  it("sessao: once per browser session", () => {
    const storage = memoryStorage();
    const core = makeCore(storage, memoryStorage());
    const p = popup({ frequencia: "sessao" });
    expect(core.isDue(p, NOW)).toBe(true);
    core.markShown(p, NOW);
    expect(core.isDue(p, NOW + DAY * 5)).toBe(false);
    expect(makeCore(storage, memoryStorage()).isDue(p, NOW)).toBe(true);
  });

  it("dia: once per local calendar day", () => {
    const core = makeCore();
    const p = popup({ frequencia: "dia" });
    core.markShown(p, NOW);
    expect(core.isDue(p, NOW + 3_600_000)).toBe(false);
    expect(core.isDue(p, new Date(2026, 10, 14, 0, 1).getTime())).toBe(true);
  });

  it("n_dias: after N days", () => {
    const core = makeCore();
    const p = popup({ frequencia: "n_dias", frequenciaDias: 3 });
    core.markShown(p, NOW);
    expect(core.isDue(p, NOW + 2 * DAY)).toBe(false);
    expect(core.isDue(p, NOW + 3 * DAY)).toBe(true);
  });

  it("ate_clicar: once per session until the button is clicked", () => {
    const storage = memoryStorage();
    const core = makeCore(storage, memoryStorage());
    const p = popup({ frequencia: "ate_clicar" });
    core.markShown(p, NOW);
    expect(core.isDue(p, NOW)).toBe(false);
    const nextVisit = makeCore(storage, memoryStorage());
    expect(nextVisit.isDue(p, NOW + DAY)).toBe(true);
    nextVisit.markClicked(p);
    expect(makeCore(storage, memoryStorage()).isDue(p, NOW + 2 * DAY)).toBe(false);
  });

  it("survives storage that throws (private mode)", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    const core = makeCore(broken, broken);
    const p = popup();
    expect(core.isDue(p, NOW)).toBe(true);
    expect(() => core.markShown(p, NOW)).not.toThrow();
  });
});

describe("pick", () => {
  it("returns the first (highest priority) popup allowed on the page and due", () => {
    const core = makeCore();
    const home = popup({ id: "home", paginasModo: "incluir", paginas: ["/"] });
    const geral = popup({ id: "geral" });
    expect(core.pick([home, geral], "/", NOW)?.id).toBe("home");
    expect(core.pick([home, geral], "/cassino", NOW)?.id).toBe("geral");
    core.markShown(home, NOW);
    expect(core.pick([home, geral], "/", NOW)?.id).toBe("geral");
  });
});

describe("POPUP_RUNTIME_JS", () => {
  it("compiles as plain JS", () => {
    expect(() => new Function("TOKEN", "API_BASE", "PUSH_PROMPT", POPUP_RUNTIME_JS)).not.toThrow();
  });

  it("never writes house content as HTML", () => {
    expect(POPUP_RUNTIME_JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(POPUP_RUNTIME_JS).toContain("textContent");
  });
});
