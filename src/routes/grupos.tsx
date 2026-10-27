// /grupos (spec §3): super admin screen to create, rename and delete house
// groups, manage which houses belong to each group and who manages it.
// Permissions were already covered server-side in groups.functions.ts and
// tested in Task 4; this page just renders listGroupsAdmin and wires the
// create/rename/delete/setGroupTenants/addGroupManager/removeGroupManager
// server fns.
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Network, Pencil, Plus, ShieldCheck, Trash2, UserPlus, Users } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

import { requestConfirmation } from "@/components/system-dialog-host";
import { useIsSuperAdmin } from "@/hooks/use-is-super-admin";
import { selectableTenantsForGroup, type SelectableTenant } from "@/lib/group-admin";
import {
  addGroupManager,
  createGroup,
  deleteGroup,
  listGroupsAdmin,
  removeGroupManager,
  renameGroup,
  setGroupTenants,
} from "@/lib/groups.functions";

export const Route = createFileRoute("/grupos")({
  component: GruposPage,
});

type GroupManager = { user_id: string; email: string | null };
type GroupRow = {
  id: string;
  nome: string;
  is_demo: boolean;
  tenants: SelectableTenant[];
  managers: GroupManager[];
};
type UngroupedTenant = { id: string; nome: string; is_demo: boolean };

/** Maps the server's raw error codes/messages to pt-BR toasts for this page. */
function groupAdminErrorText(error: Error): string {
  const message = error.message || "";
  if (message.includes("GROUP_DEMO_MISMATCH")) {
    return "Casa demo e casa real não podem ficar no mesmo grupo";
  }
  if (message.includes("DEMO_USER_GROUP_VIOLATION")) {
    return "Usuário de demonstração só pode gerir grupo demo";
  }
  if (message.toLowerCase().includes("foreign key")) return "Casa não encontrada";
  return message || "Não foi possível completar a ação.";
}

function GruposPage() {
  const { loading, isSuperAdmin } = useIsSuperAdmin();

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-sm text-muted-foreground">
        Verificando permissões…
      </div>
    );
  }
  if (!isSuperAdmin) {
    return (
      <Card className="max-w-md mx-auto mt-12">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <ShieldCheck className="h-5 w-5" /> Acesso restrito
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Apenas o super admin pode acessar esta página.
        </CardContent>
      </Card>
    );
  }

  return <GruposContent />;
}

function GruposContent() {
  const listFn = useServerFn(listGroupsAdmin);
  const { data, isLoading } = useQuery({
    queryKey: ["groups-admin"],
    queryFn: () => listFn(),
  });

  const groups = (data?.groups ?? []) as GroupRow[];
  const ungroupedTenants = (data?.ungroupedTenants ?? []) as UngroupedTenant[];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Network className="h-6 w-6 text-primary" /> Grupos de casas
          </h2>
          <p className="text-sm text-muted-foreground">
            Crie grupos, defina quais casas pertencem a cada um e quem os gerencia.
          </p>
        </div>
        <CreateGroupDialog />
      </div>

      {isLoading && <Card className="h-32 animate-pulse" />}

      {!isLoading && groups.length === 0 && (
        <p className="text-sm text-muted-foreground">Nenhum grupo criado ainda.</p>
      )}

      <div className="space-y-4">
        {groups.map((group) => (
          <GroupCard key={group.id} group={group} ungroupedTenants={ungroupedTenants} />
        ))}
      </div>
    </div>
  );
}

function CreateGroupDialog() {
  const qc = useQueryClient();
  const fn = useServerFn(createGroup);
  const [open, setOpen] = useState(false);
  const [nome, setNome] = useState("");
  const [isDemo, setIsDemo] = useState(false);
  const mut = useMutation({
    mutationFn: () => fn({ data: { nome, isDemo } }),
    onSuccess: () => {
      toast.success("Grupo criado");
      setOpen(false);
      setNome("");
      setIsDemo(false);
      qc.invalidateQueries({ queryKey: ["groups-admin"] });
    },
    onError: (error: Error) => toast.error(groupAdminErrorText(error)),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gap-2">
          <Plus className="h-4 w-4" /> Novo grupo
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Criar grupo</DialogTitle>
          <DialogDescription>
            Depois de criado, você define as casas e os gestores do grupo.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="group-nome">Nome</Label>
            <Input id="group-nome" value={nome} onChange={(e) => setNome(e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={isDemo} onCheckedChange={(checked) => setIsDemo(checked === true)} />
            Grupo de demonstração
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <Button disabled={mut.isPending || nome.trim().length < 2} onClick={() => mut.mutate()}>
            {mut.isPending ? "Criando…" : "Criar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GroupCard({
  group,
  ungroupedTenants,
}: {
  group: GroupRow;
  ungroupedTenants: UngroupedTenant[];
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="flex items-center gap-2">
          <CardTitle className="text-lg">{group.nome}</CardTitle>
          {group.is_demo && <Badge className="bg-violet-500/15 text-violet-300">demo</Badge>}
        </div>
        <div className="flex gap-2">
          <RenameGroupDialog group={group} />
          <DeleteGroupButton group={group} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-muted-foreground">Casas</p>
            <ManageTenantsDialog group={group} ungroupedTenants={ungroupedTenants} />
          </div>
          {group.tenants.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma casa neste grupo ainda.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {group.tenants.map((tenant) => (
                <Badge key={tenant.id} variant="secondary">
                  {tenant.nome}
                </Badge>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-muted-foreground">Gestores</p>
            <AddManagerDialog groupId={group.id} />
          </div>
          {group.managers.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum gestor vinculado ainda.</p>
          ) : (
            <div className="space-y-1">
              {group.managers.map((manager) => (
                <ManagerRow key={manager.user_id} groupId={group.id} manager={manager} />
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function RenameGroupDialog({ group }: { group: GroupRow }) {
  const qc = useQueryClient();
  const fn = useServerFn(renameGroup);
  const [open, setOpen] = useState(false);
  const [nome, setNome] = useState(group.nome);
  const mut = useMutation({
    mutationFn: () => fn({ data: { groupId: group.id, nome } }),
    onSuccess: () => {
      toast.success("Grupo renomeado");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["groups-admin"] });
    },
    onError: (error: Error) => toast.error(groupAdminErrorText(error)),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setNome(group.nome);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" title="Renomear" aria-label={`Renomear ${group.nome}`}>
          <Pencil className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Renomear grupo</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="rename-nome">Nome</Label>
          <Input id="rename-nome" value={nome} onChange={(e) => setNome(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <Button disabled={mut.isPending || nome.trim().length < 2} onClick={() => mut.mutate()}>
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteGroupButton({ group }: { group: GroupRow }) {
  const qc = useQueryClient();
  const fn = useServerFn(deleteGroup);
  const mut = useMutation({
    mutationFn: () => fn({ data: { groupId: group.id } }),
    onSuccess: () => {
      toast.success("Grupo excluído");
      qc.invalidateQueries({ queryKey: ["groups-admin"] });
    },
    onError: (error: Error) => toast.error(groupAdminErrorText(error)),
  });

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="ghost" title="Excluir" aria-label={`Excluir ${group.nome}`}>
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Excluir {group.nome}?</AlertDialogTitle>
          <AlertDialogDescription>
            As casas do grupo voltam a ficar sem grupo e os gestores perdem o acesso ao grupo.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => mut.mutate()}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Excluir
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ManageTenantsDialog({
  group,
  ungroupedTenants,
}: {
  group: GroupRow;
  ungroupedTenants: UngroupedTenant[];
}) {
  const qc = useQueryClient();
  const fn = useServerFn(setGroupTenants);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const candidates = selectableTenantsForGroup({
    groupIsDemo: group.is_demo,
    ungroupedTenants,
    groupTenants: group.tenants,
  });

  const mut = useMutation({
    mutationFn: () => fn({ data: { groupId: group.id, tenantIds: [...selected] } }),
    onSuccess: () => {
      toast.success("Casas do grupo atualizadas");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["groups-admin"] });
    },
    onError: (error: Error) => toast.error(groupAdminErrorText(error)),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setSelected(new Set(group.tenants.map((tenant) => tenant.id)));
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="gap-2">
          <Users className="h-4 w-4" /> Gerenciar casas
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Casas de {group.nome}</DialogTitle>
          <DialogDescription>
            {group.is_demo
              ? "Apenas casas de demonstração sem grupo aparecem aqui."
              : "Apenas casas reais sem grupo aparecem aqui."}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {candidates.length === 0 && (
            <p className="text-sm text-muted-foreground">Nenhuma casa disponível.</p>
          )}
          {candidates.map((tenant) => (
            <label key={tenant.id} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={selected.has(tenant.id)}
                onCheckedChange={(checked) => {
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (checked === true) next.add(tenant.id);
                    else next.delete(tenant.id);
                    return next;
                  });
                }}
              />
              {tenant.nome}
            </label>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <Button disabled={mut.isPending} onClick={() => mut.mutate()}>
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddManagerDialog({ groupId }: { groupId: string }) {
  const qc = useQueryClient();
  const fn = useServerFn(addGroupManager);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const mut = useMutation({
    mutationFn: () => fn({ data: { groupId, email } }),
    onSuccess: () => {
      toast.success("Gestor adicionado");
      setOpen(false);
      setEmail("");
      qc.invalidateQueries({ queryKey: ["groups-admin"] });
    },
    onError: (error: Error) => toast.error(groupAdminErrorText(error)),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="gap-2">
          <UserPlus className="h-4 w-4" /> Adicionar gestor
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Adicionar gestor do grupo</DialogTitle>
          <DialogDescription>O usuário precisa já existir na plataforma.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="manager-email">Email</Label>
          <Input
            id="manager-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
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

function ManagerRow({ groupId, manager }: { groupId: string; manager: GroupManager }) {
  const qc = useQueryClient();
  const fn = useServerFn(removeGroupManager);
  const mut = useMutation({
    mutationFn: () => fn({ data: { groupId, userId: manager.user_id } }),
    onSuccess: () => {
      toast.success("Gestor removido");
      qc.invalidateQueries({ queryKey: ["groups-admin"] });
    },
    onError: (error: Error) => toast.error(groupAdminErrorText(error)),
  });

  const label = manager.email ?? manager.user_id;
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 p-2">
      <span className="truncate text-sm">{label}</span>
      <Button
        size="sm"
        variant="ghost"
        disabled={mut.isPending}
        aria-label={`Remover ${label} como gestor`}
        onClick={async () => {
          const confirmed = await requestConfirmation({
            title: "Remover gestor do grupo?",
            description: `${label} deixa de gerenciar este grupo imediatamente.`,
            confirmLabel: "Remover",
            destructive: true,
          });
          if (confirmed) mut.mutate();
        }}
      >
        <Trash2 className="h-4 w-4 text-destructive" />
      </Button>
    </div>
  );
}
