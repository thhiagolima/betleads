// The "Claude e API" menu group, shared by the desktop sidebar and the phone
// menu: "Conectar ao Claude" (/mcp) when MCP is on and the user has MCP
// access, and "API de dados" (/api-dados) when the API is on too. Standalone
// queries (not tenant-scoped), so it does not go through useShellNav.
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Bot, KeyRound } from "lucide-react";

import { getMyApiKeys } from "@/lib/api/keys.functions";
import { getMyMcpStatus } from "@/lib/mcp/mcp.functions";
import type { NavLink, NavSection } from "@/lib/navigation";

export function useClaudeApiSection(): NavSection | null {
  const mcpFn = useServerFn(getMyMcpStatus);
  const apiFn = useServerFn(getMyApiKeys);
  const { data: mcp } = useQuery({ queryKey: ["mcp", "my-status"], queryFn: () => mcpFn() });
  const { data: api } = useQuery({ queryKey: ["api", "my-keys"], queryFn: () => apiFn() });

  const items: NavLink[] = [];
  if (mcp?.enabled && mcp.level !== "none") {
    items.push({ kind: "link", title: "Conectar ao Claude", to: "/mcp", icon: Bot });
  }
  if (api?.enabled) {
    items.push({ kind: "link", title: "API de dados", to: "/api-dados", icon: KeyRound });
  }
  return items.length ? { label: "Claude e API", items } : null;
}
