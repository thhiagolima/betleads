// The help side panel (brief, Task 4): search, "Nesta tela" (the current
// screen's article), guides, glossary and the auto-tour switch. Loaded only
// through `React.lazy` from HelpProvider, so neither this file nor the
// glossary enters the initial bundle (constraints.md "Carregamento").
//
// `HelpPanelView` is presentational (no Sheet/portal) so it renders with
// `renderToStaticMarkup` in tests; `HelpPanel` wraps it in the Sheet and
// owns the panel-local state (query, expanded article, scroll target).
import { BookOpen, Play, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { GLOSSARY } from "@/help/glossary";
import { loadAllHelpScreens } from "@/help/registry";
import {
  buildSearchIndex,
  canOpenRoute,
  roleCanSee,
  searchHelp,
  STATES_SECTION_ID,
  type SearchEntry,
} from "@/help/search";
import type { GlossaryTerm, HelpRole, HelpScreen } from "@/help/types";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

/** DOM ids the panel scrolls to. */
export const sectionDomId = (id: string) => `help-section-${id}`;
export const termDomId = (id: string) => `help-term-${id}`;

/** `openPanel` target for a glossary term: "glossary:<termId>". */
export const GLOSSARY_TARGET_PREFIX = "glossary:";

export type HelpPanelViewProps = {
  screen: HelpScreen | null;
  role: HelpRole;
  /** Rendered under "Guias passo a passo" (the guides list ships in Task 6). */
  guidesSlot?: ReactNode;
  glossary: GlossaryTerm[];
  query: string;
  results: SearchEntry[];
  autoToursOff: boolean;
  /** "Ver todos os botões e campos" expanded. */
  articleOpen: boolean;
  /** Glossary term opened and highlighted (openPanel("glossary:<id>")). */
  highlightTermId: string | null;
  onQueryChange: (query: string) => void;
  onSelectResult: (entry: SearchEntry) => void;
  onStartTour: () => void;
  onToggleArticle: () => void;
  onShowAnchor: (anchor: string) => void;
  onAutoToursOffChange: (off: boolean) => void;
};

function Heading({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-primary">
      {children}
    </h3>
  );
}

function resultLabel(entry: SearchEntry, currentRoute: string | null): string {
  if (entry.kind === "term") return "Glossário";
  if (entry.kind === "guide") return "Guia";
  if (entry.route && entry.route !== currentRoute) return entry.screenTitle ?? "Outra tela";
  return "Nesta tela";
}

function SearchResults({
  results,
  currentRoute,
  onSelect,
}: {
  results: SearchEntry[];
  currentRoute: string | null;
  onSelect: (entry: SearchEntry) => void;
}) {
  if (results.length === 0) {
    return <p className="text-sm text-muted-foreground">Nada encontrado. Tente outra palavra.</p>;
  }
  return (
    <div>
      <p className="mb-2 text-xs text-muted-foreground">
        {results.length === 1 ? "1 resultado" : `${results.length} resultados`}
      </p>
      <ul className="space-y-1">
        {results.map((entry, i) => (
          <li key={`${entry.kind}:${entry.sectionId ?? entry.termId ?? entry.guideId ?? ""}:${i}`}>
            <button
              type="button"
              onClick={() => onSelect(entry)}
              className="w-full rounded-lg px-3 py-2 text-left transition-colors hover:bg-foreground/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="block text-[11px] text-muted-foreground">
                {resultLabel(entry, currentRoute)}
              </span>
              <span className="block text-sm font-medium">{entry.title}</span>
              <span className="line-clamp-2 block text-xs text-muted-foreground">{entry.text}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Article({
  screen,
  role,
  onShowAnchor,
}: {
  screen: HelpScreen;
  role: HelpRole;
  onShowAnchor: (anchor: string) => void;
}) {
  const sections = screen.sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => roleCanSee(item.roles, role)),
    }))
    .filter((section) => section.items.length > 0 || section.intro);

  return (
    <div className="mt-4 space-y-5">
      {sections.map((section) => (
        <section key={section.id} id={sectionDomId(section.id)} className="scroll-mt-4">
          <h4 className="text-sm font-semibold">{section.title}</h4>
          {section.intro ? (
            <p className="mt-1 text-[13px] text-muted-foreground">{section.intro}</p>
          ) : null}
          <ul className="mt-2 space-y-2.5">
            {section.items.map((item, i) => (
              <li key={`${item.anchor ?? item.label}:${i}`} className="text-[13px]">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-medium">{item.label}</span>
                  {item.anchor ? (
                    <button
                      type="button"
                      onClick={() => onShowAnchor(item.anchor as string)}
                      className="shrink-0 text-xs text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      mostrar na tela
                    </button>
                  ) : null}
                </div>
                <p className="text-muted-foreground">{item.what}</p>
                {item.when ? (
                  <p className="text-muted-foreground">
                    <span className="text-foreground/80">Quando usar: </span>
                    {item.when}
                  </p>
                ) : null}
                {item.notes ? (
                  <p className="text-muted-foreground">
                    <span className="text-foreground/80">Atenção: </span>
                    {item.notes}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {screen.states.length > 0 ? (
        <section id={sectionDomId(STATES_SECTION_ID)} className="scroll-mt-4">
          <h4 className="text-sm font-semibold">Situações que podem aparecer</h4>
          <ul className="mt-2 space-y-2.5">
            {screen.states.map((state) => (
              <li key={state.id} className="text-[13px]">
                <span className="font-medium">{state.title}</span>
                <p className="text-muted-foreground">{state.what}</p>
                {state.action ? (
                  <p className="text-muted-foreground">
                    <span className="text-foreground/80">O que fazer: </span>
                    {state.action}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export function HelpPanelView(props: HelpPanelViewProps) {
  const { screen, role, glossary, query, results, highlightTermId } = props;
  const searching = query.trim().length >= 2;
  const hasTour = !!screen && Object.values(screen.tours).some((steps) => steps.length > 0);

  return (
    <div className="space-y-6">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="search"
          aria-label="Buscar na ajuda"
          placeholder="Buscar na ajuda…"
          value={query}
          onChange={(e) => props.onQueryChange(e.target.value)}
          className="pl-9"
        />
      </div>

      {searching ? (
        <SearchResults
          results={results}
          currentRoute={screen?.route ?? null}
          onSelect={props.onSelectResult}
        />
      ) : (
        <>
          <section aria-label="Nesta tela">
            <Heading>Nesta tela</Heading>
            {screen ? (
              <>
                <p className="text-[15px] font-semibold">{screen.title}</p>
                <p className="mt-1 text-[13px] text-muted-foreground">{screen.purpose}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {hasTour ? (
                    <button
                      type="button"
                      onClick={props.onStartTour}
                      className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary/15 px-3 text-[13px] font-medium text-primary transition-colors hover:bg-primary/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Play className="size-4" aria-hidden="true" />
                      Fazer o tour desta tela
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={props.onToggleArticle}
                    aria-expanded={props.articleOpen}
                    className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-[13px] font-medium transition-colors hover:bg-foreground/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <BookOpen className="size-4" aria-hidden="true" />
                    Ver todos os botões e campos
                  </button>
                </div>
                {props.articleOpen ? (
                  <Article screen={screen} role={role} onShowAnchor={props.onShowAnchor} />
                ) : null}
              </>
            ) : (
              <p className="text-[13px] text-muted-foreground">
                Esta tela ainda não tem ajuda detalhada. Os guias e o glossário abaixo valem para o
                CRM todo.
              </p>
            )}
          </section>

          <section aria-label="Guias passo a passo">
            <Heading>Guias passo a passo</Heading>
            {props.guidesSlot ?? (
              <p className="text-[13px] text-muted-foreground">Os guias chegam em breve.</p>
            )}
          </section>

          <section aria-label="Glossário">
            <Heading>Glossário</Heading>
            <div className="divide-y divide-border/60">
              {glossary.map((term) => (
                <details
                  key={term.id}
                  id={termDomId(term.id)}
                  open={highlightTermId === term.id}
                  className={cn(
                    "scroll-mt-4 py-2 text-[13px]",
                    highlightTermId === term.id && "rounded-md bg-primary/10 px-2",
                  )}
                >
                  <summary className="cursor-pointer font-medium">{term.term}</summary>
                  <p className="mt-1 text-muted-foreground">{term.short}</p>
                  {term.long ? <p className="mt-1 text-muted-foreground">{term.long}</p> : null}
                </details>
              ))}
            </div>
          </section>
        </>
      )}

      <label className="flex items-center justify-between gap-3 border-t border-border/60 pt-4 text-[13px]">
        <span>Não mostrar tours automaticamente</span>
        <Switch checked={props.autoToursOff} onCheckedChange={props.onAutoToursOffChange} />
      </label>
    </div>
  );
}

/** `route` set: the target lives on that screen, applied once it loads. */
export type HelpPanelFocus = { target?: string; nonce: number; route?: string };

export type HelpPanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  screen: HelpScreen | null;
  role: HelpRole;
  /** The current tab (URL hash without "#"), or null. */
  currentTab: string | null;
  /** Where `openPanel(sectionId)` asked to go: a section id or
   * "glossary:<termId>". `nonce` changes on every call so the same target
   * can be requested twice. */
  focus: HelpPanelFocus | null;
  autoToursOff: boolean;
  onAutoToursOffChange: (off: boolean) => void;
  onStartTour: () => void;
  onShowAnchor: (anchor: string) => void;
  /** A search result from another screen: navigate there (the provider then
   * sends a `focus` with that `route`). */
  onOpenElsewhere: (entry: SearchEntry) => void;
  guidesSlot?: ReactNode;
};

/** Scrolls to `domId` once it is in the DOM (the Sheet's portal mounts a
 * moment after `open` flips). Returns a cleanup. */
function scrollWhenMounted(domId: string): () => void {
  let tries = 0;
  let timer: ReturnType<typeof setTimeout>;
  const attempt = () => {
    const el = document.getElementById(domId);
    if (el) {
      el.scrollIntoView({ block: "start", behavior: "smooth" });
      return;
    }
    if (++tries < 12) timer = setTimeout(attempt, 50);
  };
  timer = setTimeout(attempt, 50);
  return () => clearTimeout(timer);
}

export function HelpPanel(props: HelpPanelProps) {
  const { open, screen, role, currentTab, focus } = props;
  const isMobile = useIsMobile();
  const [query, setQuery] = useState("");
  const [articleOpen, setArticleOpen] = useState(false);
  const [highlightTermId, setHighlightTermId] = useState<string | null>(null);
  const [scrollTarget, setScrollTarget] = useState<{ domId: string; nonce: number } | null>(null);

  // Search covers every article (spec §4.4): loaded once, lazily, on the
  // first query of 2+ characters.
  const [allScreens, setAllScreens] = useState<HelpScreen[] | null>(null);
  const searching = query.trim().length >= 2;
  useEffect(() => {
    if (!searching || allScreens) return;
    let cancelled = false;
    void loadAllHelpScreens().then((screens) => {
      if (!cancelled) setAllScreens(screens);
    });
    return () => {
      cancelled = true;
    };
  }, [searching, allScreens]);

  const currentRoute = screen?.route ?? null;
  const index = useMemo(
    () => buildSearchIndex([...(screen ? [screen] : []), ...(allScreens ?? [])], role, GLOSSARY),
    [screen, allScreens, role],
  );
  const results = useMemo(
    () =>
      searchHelp(index, query, currentRoute).filter(
        (e) => !e.route || e.route === currentRoute || canOpenRoute(e.route),
      ),
    [index, query, currentRoute],
  );

  const applyFocus = (f: HelpPanelFocus) => {
    setQuery("");
    if (!f.target) return;
    if (f.target.startsWith(GLOSSARY_TARGET_PREFIX)) {
      const termId = f.target.slice(GLOSSARY_TARGET_PREFIX.length);
      setHighlightTermId(termId);
      setScrollTarget({ domId: termDomId(termId), nonce: f.nonce });
    } else {
      setArticleOpen(true);
      setScrollTarget({ domId: sectionDomId(f.target), nonce: f.nonce });
    }
  };

  // A focus for another screen waits here until that screen's article loads.
  const pendingFocus = useRef<HelpPanelFocus | null>(null);

  // A different screen starts collapsed, unless a pending focus targets it.
  // (Declared before the focus effect so, on mount, a focus isn't undone.)
  useEffect(() => {
    const pending = pendingFocus.current;
    if (pending && pending.route === currentRoute) {
      pendingFocus.current = null;
      applyFocus(pending);
    } else {
      setArticleOpen(false);
    }
  }, [currentRoute]);

  // openPanel(sectionId) / openPanel("glossary:<termId>") / a result elsewhere.
  useEffect(() => {
    if (!focus) return;
    if (focus.route && focus.route !== currentRoute) {
      pendingFocus.current = focus;
      setQuery("");
      return;
    }
    applyFocus(focus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  useEffect(() => {
    if (!open || !scrollTarget) return;
    return scrollWhenMounted(scrollTarget.domId);
  }, [open, scrollTarget]);

  const select = (entry: SearchEntry) => {
    if (entry.kind === "item" && entry.route && entry.route !== currentRoute) {
      props.onOpenElsewhere(entry);
      return;
    }
    setQuery("");
    if (entry.kind === "term" && entry.termId) {
      setHighlightTermId(entry.termId);
      setScrollTarget({ domId: termDomId(entry.termId), nonce: Date.now() });
    } else if (entry.kind === "item" && entry.sectionId) {
      setArticleOpen(true);
      setScrollTarget({ domId: sectionDomId(entry.sectionId), nonce: Date.now() });
    }
  };

  const toggleArticle = () => {
    const next = !articleOpen;
    setArticleOpen(next);
    if (!next || !screen || !currentTab) return;
    // Screens with tabs open on the first section of the current tab.
    const section = screen.sections.find((s) => s.tab === currentTab);
    if (section) setScrollTarget({ domId: sectionDomId(section.id), nonce: Date.now() });
  };

  return (
    <Sheet open={open} onOpenChange={props.onOpenChange}>
      <SheetContent
        side={isMobile ? "bottom" : "right"}
        className={cn(
          "flex flex-col gap-0 overflow-y-auto p-0",
          isMobile ? "h-[85dvh] rounded-t-2xl" : "w-full sm:max-w-[480px]",
        )}
      >
        <SheetHeader className="border-b border-border/60 px-5 py-4 text-left">
          <SheetTitle>Ajuda</SheetTitle>
          <SheetDescription className="sr-only">
            Ajuda da tela atual, guias passo a passo e glossário.
          </SheetDescription>
        </SheetHeader>
        <div className="px-5 py-5">
          <HelpPanelView
            screen={screen}
            role={role}
            guidesSlot={props.guidesSlot}
            glossary={GLOSSARY}
            query={query}
            results={results}
            autoToursOff={props.autoToursOff}
            articleOpen={articleOpen}
            highlightTermId={highlightTermId}
            onQueryChange={setQuery}
            onSelectResult={select}
            onStartTour={props.onStartTour}
            onToggleArticle={toggleArticle}
            onShowAnchor={props.onShowAnchor}
            onAutoToursOffChange={props.onAutoToursOffChange}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
