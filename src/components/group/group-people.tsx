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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requestConfirmation } from "@/components/system-dialog-host";
import { setFinanceViewer } from "@/lib/finance.functions";
import { getGroupPeople } from "@/lib/groups.functions";
import { addUserToTenant, removeUserFromTenant, updateTenantUserRole } from "@/lib/tenants.functions";

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
const DEMO_ERROR_CODES = ["GROUP_DEMO_MISMATCH", "DEMO_USER_GROUP_VIOLATION", "DEMO_ACTION_BLOCKED"];

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

  if (query.isLoading || !query.data) {
    return <div className="h-64 animate-pulse rounded-lg border border-border/40" />;
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

function TenantPeopleCard({ groupId, tenant }: { groupId: string; tenant: TenantGroupHouse }) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["group-people", groupId] });

  return (
    <div className="space-y-3 rounded-lg border border-border/40 p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{tenant.nome}</h3>
        <AddPersonDialog tenantId={tenant.id} isDemo={tenant.is_demo} onAdded={invalidate} />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Usuário</TableHead>
            <TableHead>Papel</TableHead>
            <TableHead>Vê o financeiro</TableHead>
            <TableHead className="text-right">Ações</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tenant.members.map((member) => (
            <TableRow key={member.membership_id}>
              <TableCell>{member.email ?? member.user_id}</TableCell>
              <TableCell>
                <RoleSelect
                  tenantId={tenant.id}
                  member={member}
                  isDemo={tenant.is_demo}
                  onChanged={invalidate}
                />
              </TableCell>
              <TableCell>
                {member.role === "gestor" ? (
                  <FinanceViewerSwitch
                    tenantId={tenant.id}
                    member={member}
                    isDemo={tenant.is_demo}
                    onChanged={invalidate}
                  />
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="text-right">
                <RemovePersonButton
                  tenantId={tenant.id}
                  member={member}
                  isDemo={tenant.is_demo}
                  onRemoved={invalidate}
                />
              </TableCell>
            </TableRow>
          ))}
          {!tenant.members.length && (
            <TableRow>
              <TableCell colSpan={4} className="py-6 text-center text-sm text-muted-foreground">
                Nenhuma pessoa nesta casa.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
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
            <Label>Email</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Papel</Label>
            <Select value={role} onValueChange={(v) => setRole(v as Role)}>
              <SelectTrigger>
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
    mutationFn: (role: Role) => fn({ data: { tenantId, membershipId: member.membership_id, role } }),
    onSuccess: () => {
      toast.success("Papel atualizado");
      onChanged();
    },
    onError: (error: Error) => toast.error(groupActionErrorText(error)),
  });

  return (
    <DemoDisabledTooltip active={isDemo}>
      <Select value={member.role} disabled={isDemo} onValueChange={(v) => mut.mutate(v as Role)}>
        <SelectTrigger className="w-32">
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
      <Button
        size="sm"
        variant="ghost"
        disabled={isDemo || mut.isPending}
        aria-label={`Remover ${label} da casa`}
        onClick={async () => {
          const confirmed = await requestConfirmation({
            title: "Remover pessoa da casa?",
            description: `${label} perde o acesso a esta casa imediatamente.`,
            confirmLabel: "Remover",
            destructive: true,
          });
          if (confirmed) mut.mutate();
        }}
      >
        <Trash2 className="h-4 w-4 text-destructive" />
      </Button>
    </DemoDisabledTooltip>
  );
}
