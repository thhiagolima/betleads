import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Building2, ChevronDown, ShieldCheck } from "lucide-react";

import { getTenantSwitcher } from "@/lib/tenants.functions";
import { Badge } from "@/components/ui/badge";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type TenantOption = {
  id: string;
  nome: string;
  slug: string;
  role: "admin" | "gestor" | "member" | "super_admin";
};

const roleLabel: Record<TenantOption["role"], string> = {
  admin: "Admin",
  gestor: "Gestor",
  member: "Membro",
  super_admin: "Super admin",
};

export function ActiveTenantSwitcher() {
  const getSwitcher = useServerFn(getTenantSwitcher);
  const { data, isLoading } = useQuery({
    queryKey: ["active-tenant-switcher"],
    queryFn: () => getSwitcher(),
    staleTime: 60_000,
  });
  const [pendingTenantId, setPendingTenantId] = useState<string | null>(null);

  useEffect(() => {
    if (data?.activeTenantId && !window.localStorage.getItem("betleads:active-tenant")) {
      window.localStorage.setItem("betleads:active-tenant", data.activeTenantId);
    }
  }, [data?.activeTenantId]);

  const tenants = (data?.tenants ?? []) as TenantOption[];
  const active = tenants.find((tenant) => tenant.id === data?.activeTenantId) ?? null;
  const pending = tenants.find((tenant) => tenant.id === pendingTenantId) ?? null;

  if (isLoading || !active || tenants.length < 2) {
    return active ? <ActiveTenantBadge tenant={active} /> : null;
  }
  const activeTenantId = active.id;

  function requestChange(nextTenantId: string) {
    if (nextTenantId !== activeTenantId) setPendingTenantId(nextTenantId);
  }

  function confirmChange() {
    if (!pending) return;
    window.localStorage.setItem("betleads:active-tenant", pending.id);
    window.location.reload();
  }

  return (
    <>
      <Select value={active.id} onValueChange={requestChange}>
        <SelectTrigger className="h-9 min-w-[210px] border-primary/30 bg-primary/5 text-left">
          <Building2 className="mr-2 h-4 w-4 shrink-0 text-primary" />
          <SelectValue />
          <ChevronDown className="ml-auto h-4 w-4 opacity-60" />
        </SelectTrigger>
        <SelectContent align="end">
          {tenants.map((tenant) => (
            <SelectItem key={tenant.id} value={tenant.id}>
              <span className="flex items-center gap-2">
                <span>{tenant.nome}</span>
                <span className="text-xs text-muted-foreground">{roleLabel[tenant.role]}</span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Dialog open={!!pending} onOpenChange={(open) => !open && setPendingTenantId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Trocar tenant ativo?</DialogTitle>
            <DialogDescription>
              Você está saindo de <strong>{active.nome}</strong> e entrando em{" "}
              <strong>{pending?.nome}</strong>. Todos os dados e as próximas ações passarão a usar o
              novo tenant.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingTenantId(null)}>
              Cancelar
            </Button>
            <Button onClick={confirmChange}>Confirmar troca</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ActiveTenantBadge({ tenant }: { tenant: TenantOption }) {
  return (
    <div className="hidden items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs sm:flex">
      <Building2 className="h-4 w-4 text-primary" />
      <span className="max-w-40 truncate font-medium">{tenant.nome}</span>
      <Badge variant="secondary" className="gap-1 text-[10px]">
        {tenant.role === "admin" && <ShieldCheck className="h-3 w-3" />}
        {roleLabel[tenant.role]}
      </Badge>
    </div>
  );
}
