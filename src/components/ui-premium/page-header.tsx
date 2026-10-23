import type { ReactNode } from "react";
import { useRouterState } from "@tanstack/react-router";

import { resolveRouteMeta } from "@/lib/navigation";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  /** Defaults to the route's title in ROUTE_META, so the h1 matches the menu and breadcrumb. */
  title?: ReactNode;
  subtitle?: ReactNode;
  /** @deprecated The redesign has no decorative icon next to the title; ignored. */
  icon?: ReactNode;
  /** @deprecated Ignored together with `icon`. */
  iconClassName?: string;
  actions?: ReactNode;
  className?: string;
}

/**
 * The one page header: h1 + optional subtitle on the left, actions on the right.
 * Same type as the Início (26px bold, 13.5px muted subtitle that wraps).
 */
export function PageHeader({ title, subtitle, actions, className }: PageHeaderProps) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const resolvedTitle = title ?? resolveRouteMeta(pathname).title;
  return (
    <header
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4",
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight sm:text-title">{resolvedTitle}</h1>
        {subtitle && <p className="mt-1 text-body text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 sm:justify-end">{actions}</div>}
    </header>
  );
}

/**
 * Page body container. The shell's <main> already pads the page; pages must not
 * add their own padding on top of it.
 */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("mx-auto w-full max-w-[1600px] space-y-4 pb-4 sm:space-y-5", className)}>
      {children}
    </div>
  );
}
