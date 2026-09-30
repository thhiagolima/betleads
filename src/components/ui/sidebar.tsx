"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useRender } from "@base-ui/react/use-render";
import {
  IconChevronRight,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
} from "@tabler/icons-react";

import { cn } from "@/lib/utils";

export type SidebarVariant = "default" | "collapsible" | "icon-rail" | "floating" | "resizable";

type SidebarContextValue = {
  variant: SidebarVariant;
  collapsed: boolean;
  toggleCollapsed: () => void;
  navId: string;
};

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

function useSidebarContext() {
  const context = React.useContext(SidebarContext);
  if (!context) throw new Error("Sidebar components must be used within <Sidebar>");
  return context;
}

export function useSidebar() {
  const { variant, collapsed, toggleCollapsed } = useSidebarContext();
  return { variant, collapsed, toggleCollapsed };
}

export interface SidebarProps extends Omit<React.HTMLAttributes<HTMLElement>, "onChange"> {
  variant?: SidebarVariant;
  collapsed?: boolean;
  defaultCollapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  width?: number;
  collapsedWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  children: React.ReactNode;
}

function useResizableWidth(initial: number, min: number, max: number) {
  const [width, setWidth] = React.useState(initial);
  const [dragging, setDragging] = React.useState(false);
  const drag = React.useRef<{ x: number; width: number } | null>(null);
  const clamp = React.useCallback(
    (value: number) => Math.min(max, Math.max(min, value)),
    [max, min],
  );

  const onPointerDown = React.useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { x: event.clientX, width };
      setDragging(true);
    },
    [width],
  );

  React.useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => {
      if (drag.current) setWidth(clamp(drag.current.width + event.clientX - drag.current.x));
    };
    const up = () => {
      drag.current = null;
      setDragging(false);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    return () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
    };
  }, [clamp, dragging]);

  return { width, dragging, onPointerDown };
}

export const Sidebar = React.forwardRef<HTMLElement, SidebarProps>(
  (
    {
      variant = "default",
      collapsed: controlledCollapsed,
      defaultCollapsed = false,
      onCollapsedChange,
      width = 260,
      collapsedWidth = 60,
      minWidth = 180,
      maxWidth = 400,
      className,
      children,
      style,
      ...props
    },
    ref,
  ) => {
    const id = React.useId();
    const reducedMotion = useReducedMotion();
    const [internalCollapsed, setInternalCollapsed] = React.useState(defaultCollapsed);
    const collapsible = variant === "collapsible";
    const collapsed =
      variant === "icon-rail"
        ? true
        : collapsible
          ? (controlledCollapsed ?? internalCollapsed)
          : false;
    const resize = useResizableWidth(width, minWidth, maxWidth);

    const toggleCollapsed = React.useCallback(() => {
      if (!collapsible) return;
      const next = !collapsed;
      if (controlledCollapsed === undefined) setInternalCollapsed(next);
      onCollapsedChange?.(next);
    }, [collapsed, collapsible, controlledCollapsed, onCollapsedChange]);

    const context = React.useMemo(
      () => ({ variant, collapsed, toggleCollapsed, navId: `sidebar-${id}` }),
      [collapsed, id, toggleCollapsed, variant],
    );
    const effectiveWidth = collapsed
      ? collapsedWidth
      : variant === "resizable"
        ? resize.width
        : width;

    return (
      <SidebarContext.Provider value={context}>
        <nav
          ref={ref}
          aria-label="Navegação principal"
          data-slot="sidebar"
          data-variant={variant}
          data-collapsed={collapsed}
          style={{
            ...style,
            width: effectiveWidth,
            flexShrink: 0,
            transition:
              resize.dragging || reducedMotion ? "none" : "width 240ms cubic-bezier(.23,1,.32,1)",
          }}
          className={cn(
            "relative isolate flex h-svh flex-col overflow-hidden bg-background text-foreground",
            variant === "floating"
              ? "m-3 h-[calc(100svh-1.5rem)] rounded-2xl border border-border bg-card shadow-xl"
              : "border-r border-border",
            resize.dragging && "select-none",
            className,
          )}
          {...props}
        >
          {children}
          {variant === "resizable" && (
            <div
              role="separator"
              aria-orientation="vertical"
              onPointerDown={resize.onPointerDown}
              className="absolute inset-y-0 right-0 z-20 w-1.5 cursor-col-resize after:absolute after:inset-y-0 after:right-0 after:w-0.5 hover:after:bg-border"
            />
          )}
        </nav>
      </SidebarContext.Provider>
    );
  },
);
Sidebar.displayName = "Sidebar";

function FadingLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  const { collapsed } = useSidebarContext();
  const reducedMotion = useReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {!collapsed && (
        <motion.span
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reducedMotion ? 0 : 0.12 }}
          className={className}
        >
          {children}
        </motion.span>
      )}
    </AnimatePresence>
  );
}

export const SidebarHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, children, ...props }, ref) => {
    const { collapsed } = useSidebarContext();
    return (
      <div
        ref={ref}
        data-collapsed={collapsed}
        className={cn(
          "flex h-[60px] shrink-0 items-center gap-2.5 px-[18px]",
          collapsed && "justify-center px-0",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    );
  },
);
SidebarHeader.displayName = "SidebarHeader";

export const SidebarNav = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    const { navId } = useSidebarContext();
    return (
      <div
        ref={ref}
        id={navId}
        className={cn(
          "sidebar-nav min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-2",
          className,
        )}
        {...props}
      />
    );
  },
);
SidebarNav.displayName = "SidebarNav";

export const SidebarSection = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { label?: string }
>(({ className, label, children, ...props }, ref) => (
  <section ref={ref} aria-label={label} className={cn("py-1", className)} {...props}>
    {label && (
      <div className="flex h-7 items-end px-[18px] pb-1.5">
        <FadingLabel className="whitespace-nowrap text-[10.5px] font-semibold uppercase leading-none tracking-[0.12em] text-muted-foreground">
          {label}
        </FadingLabel>
      </div>
    )}
    <div className="flex flex-col gap-0.5 px-2">{children}</div>
  </section>
));
SidebarSection.displayName = "SidebarSection";

const itemClasses =
  "group/sidebar-item relative flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2 text-[13.5px] font-medium leading-none outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40";

export interface SidebarItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: React.ReactNode;
  active?: boolean;
  badge?: React.ReactNode;
  asChild?: boolean;
}

export const SidebarItem = React.forwardRef<HTMLButtonElement, SidebarItemProps>(
  ({ icon, active = false, badge, asChild = false, className, children, ...props }, ref) => {
    const { collapsed, navId } = useSidebarContext();
    const child = asChild && React.isValidElement(children) ? children : null;
    const label = child
      ? (child as React.ReactElement<{ children?: React.ReactNode }>).props.children
      : children;
    const classes = cn(
      itemClasses,
      active
        ? "text-foreground"
        : "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground",
      className,
    );
    const content = (
      <>
        {active && (
          <motion.span
            layoutId={`${navId}-active`}
            className="pointer-events-none absolute inset-0 rounded-[10px] bg-foreground/[0.07]"
          />
        )}
        {icon && (
          <span className="relative z-10 flex size-5 shrink-0 items-center justify-center">
            {icon}
          </span>
        )}
        <FadingLabel className="relative z-10 min-w-0 flex-1 truncate text-left">
          {label}
        </FadingLabel>
        {badge && <FadingLabel className="relative z-10 shrink-0">{badge}</FadingLabel>}
      </>
    );
    const rendered = useRender({
      enabled: Boolean(child),
      ref: ref as React.Ref<HTMLElement>,
      render: child ?? undefined,
      props: {
        className: classes,
        "aria-current": active ? "page" : undefined,
        title: collapsed && typeof label === "string" ? label : undefined,
        children: content,
        ...props,
      },
    });
    if (rendered) return rendered;
    return (
      <button
        ref={ref}
        type="button"
        className={classes}
        aria-current={active ? "page" : undefined}
        {...props}
      >
        {content}
      </button>
    );
  },
);
SidebarItem.displayName = "SidebarItem";

export interface SidebarNestedProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: React.ReactNode;
  label: string;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  active?: boolean;
  badge?: React.ReactNode;
}

export const SidebarNested = React.forwardRef<HTMLDivElement, SidebarNestedProps>(
  (
    {
      icon,
      label,
      open: controlledOpen,
      defaultOpen = false,
      onOpenChange,
      active,
      badge,
      children,
      ...props
    },
    ref,
  ) => {
    const { collapsed } = useSidebarContext();
    const reducedMotion = useReducedMotion();
    const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
    const open = controlledOpen ?? internalOpen;
    const toggle = () => {
      const next = !open;
      if (controlledOpen === undefined) setInternalOpen(next);
      onOpenChange?.(next);
    };
    return (
      <div ref={ref} {...props}>
        <button
          type="button"
          onClick={toggle}
          title={collapsed ? label : undefined}
          className={cn(
            itemClasses,
            active
              ? "text-foreground"
              : "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground",
          )}
        >
          {icon && (
            <span className="relative z-10 flex size-5 shrink-0 items-center justify-center">
              {icon}
            </span>
          )}
          <FadingLabel className="min-w-0 flex-1 truncate text-left">{label}</FadingLabel>
          {badge && <FadingLabel className="shrink-0">{badge}</FadingLabel>}
          <FadingLabel>
            <motion.span
              animate={{ rotate: open ? 90 : 0 }}
              transition={{ duration: reducedMotion ? 0 : 0.2 }}
              className="flex"
            >
              <IconChevronRight className="size-3.5" />
            </motion.span>
          </FadingLabel>
        </button>
        <AnimatePresence initial={false}>
          {open && !collapsed && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: reducedMotion ? 0 : 0.2 }}
              className="overflow-hidden"
            >
              <div className="relative ml-[21px] flex flex-col gap-0.5 py-1 pl-2.5 before:absolute before:inset-y-1 before:left-0 before:w-px before:bg-border">
                {children}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  },
);
SidebarNested.displayName = "SidebarNested";

export const SidebarFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    const { collapsed } = useSidebarContext();
    return (
      <div
        ref={ref}
        className={cn(
          "flex shrink-0 items-center gap-2.5 border-t border-border px-[18px] py-3",
          collapsed && "justify-center px-0",
          className,
        )}
        {...props}
      />
    );
  },
);
SidebarFooter.displayName = "SidebarFooter";

export interface SidebarToggleProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "children"
> {
  collapsed?: boolean;
  onToggle?: () => void;
  children?: React.ReactNode | ((state: { collapsed: boolean }) => React.ReactNode);
}

export const SidebarToggle = React.forwardRef<HTMLButtonElement, SidebarToggleProps>(
  ({ collapsed: collapsedProp, onToggle, children, className, ...props }, ref) => {
    const context = React.useContext(SidebarContext);
    const collapsed = context?.variant === "collapsible" ? context.collapsed : collapsedProp;
    const toggle = context?.variant === "collapsible" ? context.toggleCollapsed : onToggle;
    if (collapsed === undefined || !toggle) return null;
    return (
      <button
        ref={ref}
        type="button"
        onClick={toggle}
        aria-label={collapsed ? "Expandir menu" : "Recolher menu"}
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-[10px] text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
        {...props}
      >
        {typeof children === "function"
          ? children({ collapsed })
          : (children ??
            (collapsed ? (
              <IconLayoutSidebarLeftExpand className="size-[17px]" />
            ) : (
              <IconLayoutSidebarLeftCollapse className="size-[17px]" />
            )))}
      </button>
    );
  },
);
SidebarToggle.displayName = "SidebarToggle";
