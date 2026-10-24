import { useEffect, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Building2, ChevronDown, Users2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useActiveGroup } from "@/hooks/use-active-group";
import { useActiveTenant, type TenantOption } from "@/hooks/use-active-tenant";
import { isGroupPath } from "@/lib/navigation";
import { cn } from "@/lib/utils";

const roleLabel: Record<TenantOption["role"], string> = {
  admin: "Admin",
  gestor: "Gestor",
  member: "Membro",
  super_admin: "Super admin",
};

/**
 * The only place the active house — or group (Task 7, spec §4) — is chosen.
 * Switching house reloads the page on purpose: it is the safest way to drop
 * every cached query and realtime channel of the previous house. Switching
 * group is a plain client navigation to `/grupo`: there is no per-group
 * cache to drop, and `betleads:active-tenant` must stay untouched.
 */
export function ActiveTenantSwitcher({ compact = false }: { compact?: boolean }) {
  const { data, tenants, active, isLoading } = useActiveTenant();
  const { groups, active: activeGroup, setActive: setActiveGroup } = useActiveGroup();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const onGroupRoute = isGroupPath(pathname);
  const [pendingTenantId, setPendingTenantId] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    if (data?.activeTenantId && !window.localStorage.getItem("betleads:active-tenant")) {
      window.localStorage.setItem("betleads:active-tenant", data.activeTenantId);
    }
  }, [data?.activeTenantId]);

  const pending = tenants.find((tenant) => tenant.id === pendingTenantId) ?? null;

  if (isLoading || (!active && !groups.length)) return null;

  const currentLabel = onGroupRoute
    ? (activeGroup?.nome ?? active?.nome ?? "")
    : (active?.nome ?? activeGroup?.nome ?? "");

  const label = (
    <>
      {onGroupRoute ? (
        <Users2 className="size-4 shrink-0 text-primary" aria-hidden="true" />
      ) : (
        <Building2 className="size-4 shrink-0 text-primary" aria-hidden="true" />
      )}
      <span className={cn("truncate font-medium", compact ? "max-w-[120px]" : "max-w-[180px]")}>
        {currentLabel}
      </span>
      {!compact && !onGroupRoute && active && (
        <span className="rounded-md bg-secondary px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
          {roleLabel[active.role]}
        </span>
      )}
    </>
  );

  if (tenants.length + groups.length < 2) {
    return (
      <div
        className="flex h-9 min-w-0 items-center gap-2 rounded-[10px] border border-border bg-card px-3 text-[13px]"
        aria-label={onGroupRoute ? `Grupo: ${currentLabel}` : `Casa: ${currentLabel}`}
      >
        {label}
      </div>
    );
  }

  function confirmChange() {
    if (!pending) return;
    setSwitching(true);
    window.localStorage.setItem("betleads:active-tenant", pending.id);
    if (window.location.pathname.startsWith("/campanhas/")) {
      window.location.replace("/campanhas");
      return;
    }
    window.location.reload();
  }

  function selectGroup(groupId: string) {
    setActiveGroup(groupId);
    navigate({ to: "/grupo" });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={
              onGroupRoute
                ? `Trocar de grupo — atual: ${currentLabel}`
                : `Trocar de casa — atual: ${currentLabel}`
            }
            className="flex h-9 min-w-0 items-center gap-2 rounded-[10px] border border-border bg-card px-3 text-[13px] outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
          >
            {label}
            <ChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          {groups.length > 0 && (
            <>
              <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
                Grupos
              </DropdownMenuLabel>
              {groups.map((group) => (
                <DropdownMenuItem
                  key={group.id}
                  disabled={onGroupRoute && group.id === activeGroup?.id}
                  onSelect={() => selectGroup(group.id)}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="truncate">{group.nome}</span>
                  <span className="text-xs text-muted-foreground">
                    {onGroupRoute && group.id === activeGroup?.id ? "Atual" : "Grupo"}
                  </span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
            Suas casas
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {tenants.map((tenant) => (
            <DropdownMenuItem
              key={tenant.id}
              disabled={!onGroupRoute && tenant.id === active?.id}
              onSelect={() => setPendingTenantId(tenant.id)}
              className="flex items-center justify-between gap-2"
            >
              <span className="truncate">{tenant.nome}</span>
              <span className="text-xs text-muted-foreground">
                {!onGroupRoute && tenant.id === active?.id ? "Atual" : roleLabel[tenant.role]}
              </span>
            </DropdownMenuItem>
          ))}
          {!tenants.length && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">Nenhuma casa.</div>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={!!pending}
        onOpenChange={(open) => !open && !switching && setPendingTenantId(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Trocar de casa?</DialogTitle>
            <DialogDescription>
              Você está saindo de <strong>{active?.nome}</strong> e entrando em{" "}
              <strong>{pending?.nome}</strong>. Todos os dados e as próximas ações passam a ser da
              nova casa.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={switching} onClick={() => setPendingTenantId(null)}>
              Cancelar
            </Button>
            <Button disabled={switching} onClick={confirmChange}>
              {switching ? `Entrando em ${pending?.nome}…` : "Confirmar troca"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
