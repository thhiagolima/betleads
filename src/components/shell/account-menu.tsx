import { Link } from "@tanstack/react-router";
import { LogOut } from "lucide-react";

import { useAuthSession } from "@/components/auth-gate";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { supabase } from "@/integrations/supabase/client";
import { ACCOUNT_LINKS, canSee, type ShellRole } from "@/lib/navigation";

export function AccountMenu({ role }: { role: ShellRole | null }) {
  const session = useAuthSession();
  const email = session?.user.email ?? null;
  const initials = email?.slice(0, 2).toUpperCase() ?? "BL";
  const isSuperAdmin = role === "super_admin";
  const links = ACCOUNT_LINKS.filter((item) => canSee(item, role, isSuperAdmin));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Menu da conta"
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary outline-none transition-colors hover:bg-primary/25 focus-visible:ring-2 focus-visible:ring-ring"
        >
          {initials}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="font-normal">
          <span className="block truncate text-sm font-medium">{email ?? "Conta"}</span>
          {isSuperAdmin && (
            <span className="mt-0.5 block text-xs text-muted-foreground">Super admin</span>
          )}
        </DropdownMenuLabel>
        {links.length > 0 && <DropdownMenuSeparator />}
        {links.map((item) => {
          const Icon = item.icon;
          return (
            <DropdownMenuItem key={item.to} asChild>
              <Link to={item.to} className="flex items-center gap-2">
                {Icon && <Icon className="size-4" aria-hidden="true" />}
                {item.title}
              </Link>
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => void supabase.auth.signOut()}
          className="flex items-center gap-2 text-destructive focus:text-destructive"
        >
          <LogOut className="size-4" aria-hidden="true" />
          Sair
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
