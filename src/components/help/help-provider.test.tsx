import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined, isError: false }),
  useQueryClient: () => ({}),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@tanstack/react-router", () => ({
  useRouterState: () => "/",
  useNavigate: () => () => {},
}));
vi.mock("sonner", () => ({ toast: vi.fn() }));
vi.mock("@/lib/help-progress.functions", () => ({
  getHelpProgress: () => Promise.resolve({ progress: {} }),
  setHelpProgress: () => Promise.resolve({ ok: true }),
}));
vi.mock("@/lib/help-guides.functions", () => ({
  getGuideSignals: () => Promise.resolve({ signals: null }),
}));
vi.mock("@/components/shell/use-shell-nav", () => ({ useShellNav: () => ({ role: null }) }));

import type { HelpScreen } from "@/help/types";
import { helpRoleFor, tourFor } from "./help-provider";

describe("helpRoleFor", () => {
  it("reads super_admin as admin and no role as member", () => {
    expect(helpRoleFor("super_admin")).toBe("admin");
    expect(helpRoleFor(null)).toBe("member");
    expect(helpRoleFor("gestor")).toBe("gestor");
    expect(helpRoleFor("expert")).toBe("expert");
  });
});

describe("tourFor", () => {
  const step = (anchor: string) => ({ anchor, title: "t", body: "b" });
  const screen: HelpScreen = {
    id: "x",
    route: "/x",
    title: "X",
    purpose: "p",
    roles: ["admin"],
    sections: [],
    states: [],
    tours: { default: [step("x.a.b")], email: [step("x.email.c")] },
  };

  it("uses the tab's own tour when it has one", () => {
    expect(tourFor(screen, "email")).toEqual({ tourTab: "email", steps: [step("x.email.c")] });
  });

  it("falls back to the default tour (keyed without a tab)", () => {
    expect(tourFor(screen, "outra")).toEqual({ tourTab: null, steps: [step("x.a.b")] });
    expect(tourFor(screen, null)).toEqual({ tourTab: null, steps: [step("x.a.b")] });
    expect(tourFor({ ...screen, tours: {} }, null)).toEqual({ tourTab: null, steps: [] });
  });
});
