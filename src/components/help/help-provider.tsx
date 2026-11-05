// HelpProvider (brief, Task 4): resolves the current screen's help article,
// auto-starts its tour on a first visit, records tour results and owns the
// help panel. Everything heavy stays lazy (constraints.md "Carregamento"):
// articles via HELP_SCREEN_LOADERS' `import()`, the panel via React.lazy,
// and tour-runner.ts (driver.js) via `import()` only.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import { useShellNav } from "@/components/shell/use-shell-nav";
import { GUIDES, type GuideStep } from "@/help/guides";
import { HELP_SCREEN_LOADERS } from "@/help/registry";
import { effectiveTab, resolveHelpScreen } from "@/help/resolve";
import type { SearchEntry } from "@/help/search";
import {
  effectiveOverlayForAutoStart,
  isAutoStartSuppressed,
  nextAutoStartSuppression,
  pickHelpTarget,
  screenTourKey,
  shouldAutoStart,
  startAutoStartSuppression,
  tourFor,
  type AutoStartSuppression,
  type HelpTarget,
} from "@/help/tour-logic";
import type { HelpRole, HelpScreen, TourStep } from "@/help/types";
import {
  AUTO_TOURS_OFF_KEY,
  type HelpProgressMap,
  type HelpProgressStatus,
} from "@/lib/help-progress";
import { getHelpProgress, setHelpProgress } from "@/lib/help-progress.functions";
import { getGuideSignals } from "@/lib/help-guides.functions";
import type { ShellRole } from "@/lib/navigation";
import type { HelpPanelFocus } from "./help-panel";
import { GuideList, type GuideListFocus } from "./guide-list";

const HelpPanel = lazy(() => import("./help-panel").then((m) => ({ default: m.HelpPanel })));

// Memoized so "is driver.js loaded yet?" is known: stopping a tour on route
// change must not pull the chunk in when no tour ever ran.
let tourRunner: Promise<typeof import("@/help/tour-runner")> | null = null;
const loadTourRunner = () => (tourRunner ??= import("@/help/tour-runner"));

export const HELP_PROGRESS_QUERY_KEY = ["help-progress"] as const;

/** Delay between a screen's article loading and the auto-start check. */
const AUTO_START_DELAY_MS = 600;
/** Lets the Sheet's close animation finish before highlighting the page. */
const PANEL_CLOSE_MS = 350;

export type HelpContextValue = {
  /** Opens the panel; `sectionId` scrolls to that article section, or
   * "glossary:<termId>" to that glossary term. */
  openPanel: (sectionId?: string) => void;
  /** Starts the current screen's tour (or that tab's). */
  startTour: (tab?: string | null) => void;
  /** Something else (onboarding, a blocking overlay) is on screen: no
   * auto-start while true. */
  setOverlayActive: (active: boolean) => void;
  /** Forces the screen the help refers to (the onboarding uses it); `null`
   * goes back to the URL. */
  setScreenOverride: (route: string | null, tab?: string | null) => void;
  progress: HelpProgressMap | null;
};

const noop = () => {};
const HelpContext = createContext<HelpContextValue>({
  openPanel: noop,
  startTour: noop,
  setOverlayActive: noop,
  setScreenOverride: noop,
  progress: null,
});

export function useHelp(): HelpContextValue {
  return useContext(HelpContext);
}

/** super_admin reads the help as admin; no role yet filters as member. */
export function helpRoleFor(role: ShellRole | null): HelpRole {
  if (role === "super_admin") return "admin";
  return role ?? "member";
}

// Re-exported for existing importers (help-provider.test.tsx) — the actual
// definition moved to tour-logic.ts so help-panel.tsx (ruling R11) can use
// it too without a circular import between the two help/* components.
export { tourFor };

function isDialogOpen(): boolean {
  return !!document.querySelector(
    '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
  );
}

type Target = HelpTarget;

export function HelpProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const fetchProgress = useServerFn(getHelpProgress);
  const saveProgress = useServerFn(setHelpProgress);
  const fetchGuideSignals = useServerFn(getGuideSignals);
  const { role: shellRole, tenantId } = useShellNav();
  const role = helpRoleFor(shellRole);

  const progressQuery = useQuery({
    queryKey: HELP_PROGRESS_QUERY_KEY,
    queryFn: () => fetchProgress(),
    retry: 1,
    staleTime: Infinity,
  });
  const progress: HelpProgressMap | null = progressQuery.isError
    ? null
    : (progressQuery.data?.progress ?? null);

  // --- Panel state ---
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelMounted, setPanelMounted] = useState(false);

  // Guides' progress counts (Task 6): failure or "not loaded yet" both mean
  // "render the guides with no counts" (brief, Step 3). Only fetched once the
  // panel has been opened (it runs several DB queries; nothing else reads
  // it), and per house, so switching houses doesn't show the other's counts.
  const guideSignalsQuery = useQuery({
    queryKey: ["help-guide-signals", tenantId ?? null],
    queryFn: () => fetchGuideSignals(),
    enabled: panelMounted,
    retry: 1,
    staleTime: 60_000,
  });
  const guideSignals = guideSignalsQuery.isError ? null : (guideSignalsQuery.data?.signals ?? null);

  // --- Location: pathname + hash (tabs live in the hash; PageTabs navigate
  // through the router, but a plain `hashchange` is also honoured). ---
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const routerHash = useRouterState({ select: (s) => s.location.hash });
  const [hash, setHash] = useState("");
  useEffect(() => {
    setHash(window.location.hash);
  }, [pathname, routerHash]);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const urlTarget: Target | null = useMemo(
    () => resolveHelpScreen(pathname, hash),
    [pathname, hash],
  );
  // The onboarding wizard's override (`setScreenOverride`), which it clears
  // itself based on wizard state...
  const [override, setOverride] = useState<Target | null>(null);
  // ...and "Sobre o CRM" (ruling R4), kept apart so closing it restores the
  // wizard's override instead of dropping it.
  const [shellOverride, setShellOverride] = useState<Target | null>(null);
  const target: Target | null = useMemo(
    () => pickHelpTarget(shellOverride, override, urlTarget),
    [shellOverride, override, urlTarget],
  );

  // "Sobre o CRM" overrides the screen without navigating anywhere, so
  // nothing else would drop it: it goes away when the panel closes or the
  // location (path or tab) changes, and the help is back on the page's own
  // article (or the wizard's).
  useEffect(() => {
    setShellOverride(null);
  }, [pathname, hash]);
  useEffect(() => {
    if (!panelOpen) setShellOverride(null);
  }, [panelOpen]);

  // --- Article loading ---
  const [screen, setScreen] = useState<HelpScreen | null>(null);
  const targetRoute = target?.route ?? null;
  useEffect(() => {
    let cancelled = false;
    const loader = targetRoute ? HELP_SCREEN_LOADERS[targetRoute] : undefined;
    if (!loader) {
      setScreen(null);
      return;
    }
    loader()
      .then((mod) => {
        if (!cancelled) setScreen(mod.default);
      })
      .catch(() => {
        if (!cancelled) setScreen(null);
      });
    return () => {
      cancelled = true;
    };
  }, [targetRoute]);
  const currentScreen = screen && screen.route === targetRoute ? screen : null;
  // The tab actually showing: without a hash, the screen's `defaultTab` — so
  // the landing URL gets the same tour (and progress key) as its "#aba".
  const currentTab = currentScreen
    ? effectiveTab(currentScreen, target?.tab ?? null)
    : (target?.tab ?? null);

  // --- Panel focus/overlay ---
  const [focus, setFocus] = useState<HelpPanelFocus | null>(null);
  const [overlayActive, setOverlayActive] = useState(false);

  const openPanel = useCallback((sectionId?: string) => {
    setPanelMounted(true);
    setPanelOpen(true);
    if (sectionId) setFocus({ target: sectionId, nonce: Date.now() });
  }, []);

  // --- Progress writes (optimistic) ---
  const writeProgress = useCallback(
    (key: string, status: HelpProgressStatus | null) => {
      queryClient.setQueryData<{ progress: HelpProgressMap }>(HELP_PROGRESS_QUERY_KEY, (old) => {
        if (!old) return old;
        const next = { ...old.progress };
        if (status === null) delete next[key];
        else next[key] = status;
        return { progress: next };
      });
      saveProgress({ data: { key, status } }).catch(() => {
        void queryClient.invalidateQueries({ queryKey: HELP_PROGRESS_QUERY_KEY });
      });
    },
    [queryClient, saveProgress],
  );

  // --- Tours ---
  const runSteps = useCallback(
    (key: string, steps: TourStep[]) => {
      if (steps.length === 0) return;
      void loadTourRunner().then(({ runTour, stopActiveTour }) => {
        runTour(steps, {
          onFinish: (result) => writeProgress(key, result),
          onLearnMore: (step) => {
            stopActiveTour({ record: true });
            openPanel(step.articleSection);
          },
        });
      });
    },
    [openPanel, writeProgress],
  );

  const startTour = useCallback(
    (tab?: string | null) => {
      if (!currentScreen) return;
      const { tourTab, steps } = tourFor(currentScreen, tab === undefined ? currentTab : tab);
      setPanelOpen(false);
      // Wait for the panel (if open) to close so its overlay isn't in the way.
      const key = screenTourKey(currentScreen, tourTab);
      window.setTimeout(() => runSteps(key, steps), PANEL_CLOSE_MS);
    },
    [currentScreen, currentTab, runSteps],
  );

  // Auto-start is evaluated once per tour key per visit of a route.
  const autoChecked = useRef(new Set<string>());

  // A highlight ("mostrar na tela", a guide's "Ir para esta etapa") on a
  // screen: that visit's auto-start must not replace it (tour-logic.ts).
  // Declared before the auto-start effect so it's updated first.
  const suppression = useRef<AutoStartSuppression | null>(null);
  useEffect(() => {
    suppression.current = nextAutoStartSuppression(suppression.current, urlTarget, Date.now());
  }, [urlTarget]);
  const suppressAutoStartAt = useCallback(
    (destination: Target | null) => {
      suppression.current = destination
        ? startAutoStartSuppression(destination, urlTarget, Date.now())
        : null;
    },
    [urlTarget],
  );

  // Any running tour/highlight stops when the route changes.
  useEffect(() => {
    autoChecked.current.clear();
    return () => {
      void tourRunner?.then(({ stopActiveTour }) => stopActiveTour());
    };
  }, [pathname]);

  const progressReady = progress !== null;
  useEffect(() => {
    if (!currentScreen || !progressReady) return;
    const { tourTab, steps } = tourFor(currentScreen, currentTab);
    const key = screenTourKey(currentScreen, tourTab);
    if (autoChecked.current.has(key)) return;
    if (isAutoStartSuppressed(suppression.current, urlTarget)) {
      autoChecked.current.add(key);
      return;
    }
    const timer = window.setTimeout(() => {
      autoChecked.current.add(key);
      if (isAutoStartSuppressed(suppression.current, urlTarget)) return;
      const latest = queryClient.getQueryData<{ progress: HelpProgressMap }>(
        HELP_PROGRESS_QUERY_KEY,
      );
      const ok = shouldAutoStart({
        key,
        progress: latest?.progress ?? null,
        dialogOpen: isDialogOpen(),
        overlayActive: effectiveOverlayForAutoStart({
          overlayActive,
          panelOpen,
          isOverrideScreen: (shellOverride ?? override) !== null,
        }),
        hasSteps: steps.length > 0,
      });
      if (ok) runSteps(key, steps);
    }, AUTO_START_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [
    currentScreen,
    currentTab,
    progressReady,
    overlayActive,
    panelOpen,
    override,
    shellOverride,
    urlTarget,
    queryClient,
    runSteps,
  ]);

  const setScreenOverride = useCallback((route: string | null, tab?: string | null) => {
    setOverride((prev) => {
      const next = route ? { route, tab: tab ?? null } : null;
      // Defense in depth: bail out when nothing actually changed, so a
      // caller that re-applies the same override every render (or every
      // effect run) doesn't force a new object identity — and therefore a
      // re-render of every consumer of `target`/`currentScreen` — for
      // nothing.
      if (prev === next) return prev;
      if (prev === null || next === null) return next;
      if (prev.route === next.route && prev.tab === next.tab) return prev;
      return next;
    });
  }, []);

  // A search result on another screen: go there (with its tab) and keep the
  // panel open on that section once the article loads. A virtual screen
  // (today just "shell", ruling R4 — "onboarding" is never offered by
  // search, see search.ts' canOpenRoute) has no route to navigate to: it is
  // shown in-panel via `setScreenOverride` instead.
  const navigate = useNavigate();
  const openElsewhere = useCallback(
    (entry: SearchEntry) => {
      if (!entry.route) return;
      // Leaving "Sobre o CRM" for a real screen: drop it first — when the
      // destination is the URL already showing, nothing changes location and
      // the shell article (with the focus still pending) would stay.
      if (entry.route.startsWith("/")) setShellOverride(null);
      if (!entry.route.startsWith("/")) {
        setShellOverride({ route: entry.route, tab: entry.tab ?? null });
      } else {
        const href = entry.tab ? `${entry.route}#${entry.tab}` : entry.route;
        void navigate({ href });
      }
      setFocus({ target: entry.sectionId, nonce: Date.now(), route: entry.route });
    },
    [navigate],
  );

  // "Sobre o CRM" (ruling R4): same mechanism as a cross-screen search
  // result landing on "shell", but triggered directly from the panel's own
  // button instead of a search pick.
  const openShellArticle = useCallback(() => {
    openElsewhere({ kind: "item", title: "", text: "", route: "shell", sectionId: "cabecalho" });
  }, [openElsewhere]);

  const closeShellArticle = useCallback(() => setShellOverride(null), []);

  const showAnchor = useCallback(
    (anchor: string) => {
      suppressAutoStartAt(urlTarget);
      setPanelOpen(false);
      window.setTimeout(() => {
        void loadTourRunner().then(({ highlightAnchor }) => {
          if (!highlightAnchor(anchor)) toast("Este elemento não está visível agora");
        });
      }, PANEL_CLOSE_MS);
    },
    [suppressAutoStartAt, urlTarget],
  );

  // A guide step's "Ir para esta etapa" (Task 6): go to its route/tab, close
  // the panel, then highlight its anchor once the screen has loaded — same
  // close-then-highlight timing as `showAnchor`, plus the navigation a guide
  // step may need (it can point at a different screen than the current one).
  const goToGuideStep = useCallback(
    (step: GuideStep) => {
      setPanelOpen(false);
      const stepHash = step.tab ? `#${step.tab}` : "";
      if (step.anchor) suppressAutoStartAt(resolveHelpScreen(step.route, stepHash));
      const href = `${step.route}${stepHash}`;
      void navigate({ href }).then(() => {
        if (!step.anchor) return;
        window.setTimeout(() => {
          void loadTourRunner().then(({ highlightAnchor }) => {
            if (!highlightAnchor(step.anchor as string)) {
              toast("Este elemento não está visível agora");
            }
          });
        }, PANEL_CLOSE_MS);
      });
    },
    [navigate, suppressAutoStartAt],
  );

  // A guide search result (Task 6): expand that guide in the GuideList
  // below, instead of navigating anywhere.
  const [guideFocus, setGuideFocus] = useState<GuideListFocus | null>(null);
  const openGuide = useCallback((guideId: string) => {
    setGuideFocus({ guideId, nonce: Date.now() });
  }, []);

  const value = useMemo<HelpContextValue>(
    () => ({ openPanel, startTour, setOverlayActive, setScreenOverride, progress }),
    [openPanel, startTour, setScreenOverride, progress],
  );

  return (
    <HelpContext.Provider value={value}>
      {children}
      {panelMounted ? (
        <Suspense fallback={null}>
          <HelpPanel
            open={panelOpen}
            onOpenChange={setPanelOpen}
            screen={currentScreen}
            role={role}
            currentTab={currentTab}
            focus={focus}
            autoToursOff={progress?.[AUTO_TOURS_OFF_KEY] === "off"}
            onAutoToursOffChange={(off) => writeProgress(AUTO_TOURS_OFF_KEY, off ? "off" : null)}
            onStartTour={() => startTour()}
            onShowAnchor={showAnchor}
            onOpenElsewhere={openElsewhere}
            onOpenShellArticle={openShellArticle}
            onCloseShellArticle={closeShellArticle}
            onOpenGuide={openGuide}
            guidesSlot={
              <GuideList
                guides={GUIDES}
                role={role}
                signals={guideSignals}
                onGoToStep={goToGuideStep}
                focus={guideFocus}
              />
            }
          />
        </Suspense>
      ) : null}
    </HelpContext.Provider>
  );
}
