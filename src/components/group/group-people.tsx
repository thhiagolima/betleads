// /grupo/pessoas (spec §4/§8): people of every house in the group, read from
// getGroupPeople. Changes reuse the house-level server fns (same rules as
// /tenants): addUserToTenant / updateTenantUserRole / removeUserFromTenant,
// plus setFinanceViewer for a gestor's "vê o financeiro" switch. Demo houses
// keep naming blocked (assertTenantNotDemo in those fns) — the raw SQL
// codes GROUP_DEMO_MISMATCH / DEMO_USER_GROUP_VIOLATION / DEMO_ACTION_BLOCKED
// are mapped to the same pt-BR demo toast here.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { DemoDisabledTooltip } from "@/components/demo-disabled-tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { requestConfirmation } from "@/components/system-dialog-host";
import { QueryErrorState } from "@/components/finance/query-error-state";
import { setFinanceViewer } from "@/lib/finance.functions";
import { getGroupPeople } from "@/lib/groups.functions";
import {
  addUserToTenant,
  removeUserFromTenant,
  updateTenantUserRole,
} from "@/lib/tenants.functions";

type Role = "admin" | "gestor" | "member";
type Member = {
  membership_id: string;
  user_id: string;
  email: string | null;
  role: Role;
  canViewFinance: boolean;
};
type TenantGroupHouse = { id: string; nome: string; is_demo: boolean; members: Member[] };

const DEMO_ACTION_PT = "Ação indisponível na demonstração";
const DEMO_ERROR_CODES = [
  "GROUP_DEMO_MISMATCH",
  "DEMO_USER_GROUP_VIOLATION",
  "DEMO_ACTION_BLOCKED",
];

function groupActionErrorText(error: Error) {
  const message = error.message || "";
  if (DEMO_ERROR_CODES.some((code) => message.includes(code))) return DEMO_ACTION_PT;
  return message || "Não foi possível completar a ação.";
}

export function GroupPeople({ groupId }: { groupId: string }) {
  const getPeople = useServerFn(getGroupPeople);
  const query = useQuery({
    queryKey: ["group-people", groupId],
    queryFn: () => getPeople({ data: { groupId } }),
  });

  if (query.isLoading) {
    return <div className="h-64 animate-pulse rounded-lg border border-border/40" />;
  }

  if (query.isError || !query.data) {
    return (
      <QueryErrorState
        title="Não foi possível carregar as pessoas do grupo."
        retrying={query.isFetching}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const tenants = query.data.tenants as TenantGroupHouse[];
  if (!tenants.length) {
    return <p className="text-sm text-muted-foreground">Nenhuma casa neste grupo ainda.</p>;
  }

  return (
    <div className="space-y-6">
      {tenants.map((tenant) => (
        <TenantPeopleCard key={tenant.id} groupId={groupId} tenant={tenant} />
      ))}
    </div>
  );
}

// Card per person on phones; a 4-column table-like row from md up.
const PEOPLE_GRID =
  "md:grid md:grid-cols-[minmax(0,1.6fr)_9rem_8rem_4rem] md:items-center md:gap-3";

function TenantPeopleCard({ groupId, tenant }: { groupId: string; tenant: TenantGroupHouse }) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["group-people", groupId] });

  return (
    <div className="space-y-3 rounded-lg border border-border/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="min-w-0 text-sm font-semibold">{tenant.nome}</h3>
        <AddPersonDialog tenantId={tenant.id} isDemo={tenant.is_demo} onAdded={invalidate} />
      </div>
      <div
        aria-hidden="true"
        className={`hidden border-b border-border/40 pb-2 text-meta font-medium text-muted-foreground ${PEOPLE_GRID}`}
      >
        <span>Usuário</span>
        <span>Papel</span>
        <span>Vê o financeiro</span>
        <span className="text-right">Ações</span>
      </div>
      <ul className="divide-y divide-border/40">
        {tenant.members.map((member) => (
          <li
            key={member.membership_id}
            className={`flex flex-col gap-2 py-3 md:py-2 ${PEOPLE_GRID}`}
          >
            <div className="flex min-w-0 items-center justify-between gap-2 md:contents">
              <span className="min-w-0 break-all text-sm">{member.email ?? member.user_id}</span>
              <div className="md:hidden">
                <RemovePersonButton
                  tenantId={tenant.id}
                  member={member}
                  isDemo={tenant.is_demo}
                  onRemoved={invalidate}
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 md:contents">
              <div className="flex items-center gap-2">
                <span className="text-meta text-muted-foreground md:sr-only">Papel</span>
                <RoleSelect
                  tenantId={tenant.id}
                  member={member}
                  isDemo={tenant.is_demo}
                  onChanged={invalidate}
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-meta text-muted-foreground md:sr-only">Vê o financeiro</span>
                {member.role === "gestor" ? (
                  <FinanceViewerSwitch
                    tenantId={tenant.id}
                    member={member}
                    isDemo={tenant.is_demo}
                    onChanged={invalidate}
                  />
                ) : (
                  <span className="text-meta text-muted-foreground">—</span>
                )}
              </div>
            </div>
            <div className="hidden text-right md:block">
              <RemovePersonButton
                tenantId={tenant.id}
                member={member}
                isDemo={tenant.is_demo}
                onRemoved={invalidate}
              />
            </div>
          </li>
        ))}
        {!tenant.members.length && (
          <li className="py-6 text-center text-sm text-muted-foreground">
            Nenhuma pessoa nesta casa.
          </li>
        )}
      </ul>
    </div>
  );
}

function AddPersonDialog({
  tenantId,
  isDemo,
  onAdded,
}: {
  tenantId: string;
  isDemo: boolean;
  onAdded: () => void;
}) {
  const fn = useServerFn(addUserToTenant);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const mut = useMutation({
    mutationFn: () => fn({ data: { tenantId, email, role } }),
    onSuccess: () => {
      toast.success("Pessoa adicionada");
      setOpen(false);
      setEmail("");
      onAdded();
    },
    onError: (error: Error) => toast.error(groupActionErrorText(error)),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DemoDisabledTooltip active={isDemo}>
        <DialogTrigger asChild>
          <Button size="sm" className="gap-2" disabled={isDemo}>
            <UserPlus className="h-4 w-4" />
            Adicionar pessoa
          </Button>
        </DialogTrigger>
      </DemoDisabledTooltip>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Adicionar pessoa</DialogTitle>
          <DialogDescription>
            Convida por e-mail; se já existir, só vincula com o papel escolhido.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor={`add-person-email-${tenantId}`}>Email</Label>
            <Input
              id={`add-person-email-${tenantId}`}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`add-person-role-${tenantId}`}>Papel</Label>
            <Select value={role} onValueChange={(v) => setRole(v as Role)}>
              <SelectTrigger id={`add-person-role-${tenantId}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="gestor">Gestor</SelectItem>
                <SelectItem value="member">Membro</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <Button disabled={mut.isPending || !email} onClick={() => mut.mutate()}>
            Adicionar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RoleSelect({
  tenantId,
  member,
  isDemo,
  onChanged,
}: {
  tenantId: string;
  member: Member;
  isDemo: boolean;
  onChanged: () => void;
}) {
  const fn = useServerFn(updateTenantUserRole);
  const mut = useMutation({
    mutationFn: (role: Role) =>
      fn({ data: { tenantId, membershipId: member.membership_id, role } }),
    onSuccess: () => {
      toast.success("Papel atualizado");
      onChanged();
    },
    onError: (error: Error) => toast.error(groupActionErrorText(error)),
  });

  return (
    <DemoDisabledTooltip active={isDemo}>
      <Select value={member.role} disabled={isDemo} onValueChange={(v) => mut.mutate(v as Role)}>
        <SelectTrigger className="w-32" aria-label={`Papel de ${member.email ?? "esta pessoa"}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="admin">Admin</SelectItem>
          <SelectItem value="gestor">Gestor</SelectItem>
          <SelectItem value="member">Membro</SelectItem>
        </SelectContent>
      </Select>
    </DemoDisabledTooltip>
  );
}

function FinanceViewerSwitch({
  tenantId,
  member,
  isDemo,
  onChanged,
}: {
  tenantId: string;
  member: Member;
  isDemo: boolean;
  onChanged: () => void;
}) {
  const fn = useServerFn(setFinanceViewer);
  const mut = useMutation({
    mutationFn: (canView: boolean) => fn({ data: { tenantId, userId: member.user_id, canView } }),
    onSuccess: () => onChanged(),
    onError: (error: Error) => toast.error(groupActionErrorText(error)),
  });

  return (
    <DemoDisabledTooltip active={isDemo}>
      <Switch
        aria-label={`${member.email ?? "Esta pessoa"} vê o financeiro`}
        checked={member.canViewFinance}
        disabled={isDemo || mut.isPending}
        onCheckedChange={(checked) => mut.mutate(checked)}
      />
    </DemoDisabledTooltip>
  );
}

function RemovePersonButton({
  tenantId,
  member,
  isDemo,
  onRemoved,
}: {
  tenantId: string;
  member: Member;
  isDemo: boolean;
  onRemoved: () => void;
}) {
  const fn = useServerFn(removeUserFromTenant);
  const mut = useMutation({
    mutationFn: () => fn({ data: { tenantId, membershipId: member.membership_id } }),
    onSuccess: () => {
      toast.success("Pessoa removida");
      onRemoved();
    },
    onError: (error: Error) => toast.error(groupActionErrorText(error)),
  });

  const label = member.email ?? "esta pessoa";
  return (
    <DemoDisabledTooltip active={isDemo}>
      <IconButton
        label={`Remover ${label} da casa`}
        icon={<Trash2 className="h-4 w-4 text-destructive" />}
        disabled={isDemo || mut.isPending}
        onClick={async () => {
          const confirmed = await requestConfirmation({
            title: "Remover pessoa da casa?",
            description: `${label} perde o acesso a esta casa imediatamente.`,
            confirmLabel: "Remover",
            destructive: true,
          });
          if (confirmed) mut.mutate();
        }}
      />
    </DemoDisabledTooltip>
  );
}
