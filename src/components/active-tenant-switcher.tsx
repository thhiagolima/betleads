import { useEffect, useState } from "react";
import { Building2, ChevronDown } from "lucide-react";

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
import { useActiveTenant, type TenantOption } from "@/hooks/use-active-tenant";
import { cn } from "@/lib/utils";

const roleLabel: Record<TenantOption["role"], string> = {
  admin: "Admin",
  gestor: "Gestor",
  member: "Membro",
  super_admin: "Super admin",
  expert: "Expert",
};

/**
 * The only place the active house is chosen. Switching reloads the page on
 * purpose: it is the safest way to drop every cached query and realtime
 * channel of the previous house.
 */
export function ActiveTenantSwitcher({ compact = false }: { compact?: boolean }) {
  const { data, tenants, active, isLoading } = useActiveTenant();
  const [pendingTenantId, setPendingTenantId] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    if (data?.activeTenantId && !window.localStorage.getItem("betleads:active-tenant")) {
      window.localStorage.setItem("betleads:active-tenant", data.activeTenantId);
    }
  }, [data?.activeTenantId]);

  const pending = tenants.find((tenant) => tenant.id === pendingTenantId) ?? null;

  if (isLoading || !active) return null;

  const label = (
    <>
      <Building2 className="size-4 shrink-0 text-primary" aria-hidden="true" />
      <span className={cn("truncate font-medium", compact ? "max-w-[120px]" : "max-w-[180px]")}>
        {active.nome}
      </span>
      {!compact && (
        <span className="rounded-md bg-secondary px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
          {roleLabel[active.role]}
        </span>
      )}
    </>
  );

  if (tenants.length < 2) {
    return (
      <div
        className="flex h-9 min-w-0 items-center gap-2 rounded-[10px] border border-border bg-card px-3 text-[13px]"
        aria-label={`Casa: ${active.nome}`}
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

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Trocar de casa — atual: ${active.nome}`}
            className="flex h-9 min-w-0 items-center gap-2 rounded-[10px] border border-border bg-card px-3 text-[13px] outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
          >
            {label}
            <ChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
            Suas casas
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {tenants.map((tenant) => (
            <DropdownMenuItem
              key={tenant.id}
              disabled={tenant.id === active.id}
              onSelect={() => setPendingTenantId(tenant.id)}
              className="flex items-center justify-between gap-2"
            >
              <span className="truncate">{tenant.nome}</span>
              <span className="text-xs text-muted-foreground">
                {tenant.id === active.id ? "Atual" : roleLabel[tenant.role]}
              </span>
            </DropdownMenuItem>
          ))}
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
              Você está saindo de <strong>{active.nome}</strong> e entrando em{" "}
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
