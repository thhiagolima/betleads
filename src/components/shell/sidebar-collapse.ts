import { useCallback, useEffect, useState } from "react";

export const SIDEBAR_STORAGE_KEY = "betleads:sidebar-collapsed";

/**
 * Runs inline in <head>, before the first paint: applies the saved collapsed
 * state so the server-rendered sidebar already has the right width.
 */
export const SIDEBAR_BOOT_SCRIPT = `try{if(localStorage.getItem("${SIDEBAR_STORAGE_KEY}")==="true")document.documentElement.dataset.sidebar="collapsed"}catch(e){}`;

function readCollapsed() {
  return (
    typeof document !== "undefined" && document.documentElement.dataset.sidebar === "collapsed"
  );
}

/**
 * Layout follows the <html> attribute through CSS; this state is only for
 * behaviour (tooltips, the group flyout) and starts false on the server and on
 * hydration so both renders match.
 */
export function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setCollapsed(readCollapsed());
  }, []);

  const toggle = useCallback(() => {
    const next = !readCollapsed();
    if (next) document.documentElement.dataset.sidebar = "collapsed";
    else delete document.documentElement.dataset.sidebar;
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next));
    } catch {
      // Private mode: the choice just isn't remembered.
    }
    setCollapsed(next);
  }, []);

  return { collapsed, toggle };
}
