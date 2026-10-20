import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  activeNavKey,
  navLinkKey,
  type NavGroup,
  type NavLink,
  type NavSection,
} from "@/lib/navigation";
import { cn } from "@/lib/utils";

const itemBase =
  "relative flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring sb-collapsed:justify-center sb-collapsed:px-0";
const itemIdle = "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground";
const itemActive = "bg-primary/[0.12] text-foreground [&_svg]:text-primary";

/** Text hidden visually when the desktop sidebar is collapsed, kept for screen readers. */
const labelClass = "min-w-0 flex-1 truncate text-left sb-collapsed:sr-only";

function useActiveKey() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const hash = useRouterState({ select: (state) => state.location.hash });
  return activeNavKey(pathname, hash);
}

function NavLinkItem({
  item,
  activeKey,
  collapsed,
  nested = false,
  onNavigate,
}: {
  item: NavLink;
  activeKey: string | null;
  collapsed: boolean;
  nested?: boolean;
  onNavigate?: () => void;
}) {
  const active = activeKey === navLinkKey(item);
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      hash={item.hash}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      // The router would also mark parents and hash siblings as current;
      // only our single active item should be.
      activeOptions={{ exact: true, includeHash: true }}
      title={collapsed && !nested ? item.title : undefined}
      className={cn(
        itemBase,
        active ? itemActive : itemIdle,
        nested && "h-8 text-[13px] sb-collapsed:justify-start sb-collapsed:px-2.5",
      )}
    >
      {Icon && <Icon className="size-[18px] shrink-0" strokeWidth={1.75} aria-hidden="true" />}
      <span className={nested ? "min-w-0 flex-1 truncate text-left" : labelClass}>
        {item.title}
      </span>
    </Link>
  );
}

function NavGroupItem({
  group,
  activeKey,
  collapsed,
  onNavigate,
}: {
  group: NavGroup;
  activeKey: string | null;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const childActive = group.children.some((child) => activeKey === navLinkKey(child));
  const [open, setOpen] = useState(childActive);
  const [flyoutOpen, setFlyoutOpen] = useState(false);
  const listId = useId();
  const Icon = group.icon;

  useEffect(() => {
    if (childActive) setOpen(true);
  }, [childActive]);

  const trigger = (
    <button
      type="button"
      aria-expanded={collapsed ? flyoutOpen : open}
      aria-controls={collapsed ? undefined : listId}
      onClick={collapsed ? undefined : () => setOpen((value) => !value)}
      title={collapsed ? group.title : undefined}
      className={cn(itemBase, childActive ? "text-foreground [&_svg]:text-primary" : itemIdle)}
    >
      <Icon className="size-[18px] shrink-0" strokeWidth={1.75} aria-hidden="true" />
      <span className={labelClass}>{group.title}</span>
      <ChevronRight
        className={cn(
          "size-3.5 shrink-0 transition-transform sb-collapsed:hidden",
          open && "rotate-90",
        )}
        aria-hidden="true"
      />
    </button>
  );

  if (collapsed) {
    // Collapsed rail: the children open in a flyout next to the icon.
    return (
      <Popover open={flyoutOpen} onOpenChange={setFlyoutOpen}>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent side="right" align="start" sideOffset={10} className="w-56 p-1.5">
          <p className="px-2.5 pb-1.5 pt-1 text-xs font-medium text-muted-foreground">
            {group.title}
          </p>
          <div className="flex flex-col gap-0.5">
            {group.children.map((child) => (
              <NavLinkItem
                key={navLinkKey(child)}
                item={child}
                activeKey={activeKey}
                collapsed={false}
                nested
                onNavigate={() => {
                  setFlyoutOpen(false);
                  onNavigate?.();
                }}
              />
            ))}
          </div>
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <div>
      {trigger}
      {open && (
        <div
          id={listId}
          className="relative ml-[21px] mt-0.5 flex flex-col gap-0.5 pl-2.5 before:absolute before:inset-y-1 before:left-0 before:w-px before:bg-border"
        >
          {group.children.map((child) => (
            <NavLinkItem
              key={navLinkKey(child)}
              item={child}
              activeKey={activeKey}
              collapsed={false}
              nested
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function NavSections({
  sections,
  collapsed,
  onNavigate,
}: {
  sections: NavSection[];
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const activeKey = useActiveKey();
  return (
    <>
      {sections.map((section, index) => (
        <div key={section.label ?? index} role="group" aria-label={section.label}>
          {section.label && (
            <div className="px-2.5 pb-1.5 pt-4 text-[10.5px] font-semibold uppercase leading-none tracking-[0.12em] text-muted-foreground sb-collapsed:hidden">
              {section.label}
            </div>
          )}
          {section.label && (
            <div
              className="mx-3 my-2.5 hidden h-px bg-border sb-collapsed:block"
              aria-hidden="true"
            />
          )}
          <div className="flex flex-col gap-0.5">
            {section.items.map((item) =>
              item.kind === "group" ? (
                <NavGroupItem
                  key={item.title}
                  group={item}
                  activeKey={activeKey}
                  collapsed={collapsed}
                  onNavigate={onNavigate}
                />
              ) : (
                <NavLinkItem
                  key={navLinkKey(item)}
                  item={item}
                  activeKey={activeKey}
                  collapsed={collapsed}
                  onNavigate={onNavigate}
                />
              ),
            )}
          </div>
        </div>
      ))}
    </>
  );
}

export function NavLinks({
  items,
  collapsed,
  onNavigate,
}: {
  items: NavLink[];
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const activeKey = useActiveKey();
  return (
    <div className="flex flex-col gap-0.5">
      {items.map((item) => (
        <NavLinkItem
          key={navLinkKey(item)}
          item={item}
          activeKey={activeKey}
          collapsed={collapsed}
          onNavigate={onNavigate}
        />
      ))}
    </div>
  );
}
