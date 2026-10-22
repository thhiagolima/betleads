import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { BILLING_ITEM_LABEL } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { useIsSuperAdmin } from "@/hooks/use-is-super-admin";
import { requestConfirmation } from "@/components/system-dialog-host";
import {
  adminCreateUser,
  adminDeleteUser,
  adminAssignUserToTenant,
  adminGenerateLoginLink,
  adminGetUserAccesses,
  adminListUsers,
  adminRemoveUserFromTenant,
  adminPlatformMetrics,
  adminSetUserActive,
  adminGetSmsProviderConfig,
  getPricing,
  setPricing,
} from "@/lib/admin.functions";
import {
  adminClearTenantPrice,
  adminSetTenantPrice,
  getTenantEffectivePrice,
} from "@/lib/billing/billing.functions";
import { adminAdjustSmsCredits, adminSmsCreditConsole } from "@/lib/sms-credits.functions";
import { BillingDashboardPanel } from "@/components/billing/admin/billing-dashboard-panel";
import {
  BILLING_DASHBOARD_QUERY_KEY,
  BillingTenantListCard,
} from "@/components/billing/admin/billing-tenant-list";
import { BillingCsvDownloadCard } from "@/components/billing/admin/billing-csv-download";
import { PixFeeFormCard } from "@/components/billing/admin/pix-fee-form";
import {
  Activity,
  Ban,
  CheckCircle2,
  Copy,
  CreditCard,
  DollarSign,
  Landmark,
  LogIn,
  Plus,
  Receipt,
  Settings2,
  ShieldCheck,
  Trash2,
  Users,
  Wallet,
  RadioTower,
} from "lucide-react";

export const Route = createFileRoute("/admin")({
  component: AdminPage,
});

type UserRow = {
  user_id: string;
  email: string | null;
  created_at: string | null;
  last_sign_in_at: string | null;
  banned_until: string | null;
  tenant_id: string | null;
  tenant_nome: string | null;
  role: string | null;
  sms_count: number;
  sms_cost: number;
  call_minutes: number;
  call_cost: number;
  email_count: number;
  email_cost: number;
  total_cost: number;
};

function brl(n: number | string | null | undefined) {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return v.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
  });
}

function fmtDate(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleString("pt-BR");
}

function AdminPage() {
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

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <ShieldCheck className="h-6 w-6 text-primary" /> Painel Super Admin
        </h2>
        <p className="text-sm text-muted-foreground">
          Veja gastos, métricas e gerencie usuários da plataforma.
        </p>
      </div>

      <Tabs defaultValue="users" className="space-y-4">
        <TabsList>
          <TabsTrigger value="users" className="gap-2">
            <Users className="h-4 w-4" /> Usuários
          </TabsTrigger>
          <TabsTrigger value="metrics" className="gap-2">
            <Activity className="h-4 w-4" /> Métricas
          </TabsTrigger>
          <TabsTrigger value="pricing" className="gap-2">
            <DollarSign className="h-4 w-4" /> Preços
          </TabsTrigger>
          <TabsTrigger value="sms-credits" className="gap-2">
            <CreditCard className="h-4 w-4" /> Saldo
          </TabsTrigger>
          <TabsTrigger value="billing" className="gap-2">
            <Landmark className="h-4 w-4" /> Faturamento
          </TabsTrigger>
          <TabsTrigger value="integrations" className="gap-2">
            <RadioTower className="h-4 w-4" /> Integrações
          </TabsTrigger>
        </TabsList>

        <TabsContent value="users">
          <UsersTab />
        </TabsContent>
        <TabsContent value="metrics">
          <MetricsTab />
        </TabsContent>
        <TabsContent value="pricing">
          <PricingTab />
        </TabsContent>
        <TabsContent value="sms-credits">
          <BalanceAdminTab />
        </TabsContent>
        <TabsContent value="billing">
          <BillingTab />
        </TabsContent>
        <TabsContent value="integrations">
          <AdminIntegrationsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─── Aba Faturamento (Task 9) ───────────────────────────────────────────────
function BillingTab() {
  return (
    <div className="space-y-4">
      <BillingDashboardPanel queryKey={BILLING_DASHBOARD_QUERY_KEY} />
      <BillingTenantListCard />
      <div className="grid gap-4 lg:grid-cols-2">
        <BillingCsvDownloadCard />
        <PixFeeFormCard />
      </div>
    </div>
  );
}

function AdminIntegrationsTab() {
  const configFn = useServerFn(adminGetSmsProviderConfig);
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["admin", "integrations", "sms"],
    queryFn: () => configFn(),
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="flex items-center gap-2">
            <RadioTower className="h-5 w-5 text-primary" /> Provedores de canais
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Diagnóstico técnico visível exclusivamente para o super admin.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isLoading}>
          Atualizar
        </Button>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 xl:grid-cols-3">
          {(data?.channels ?? []).map((item) => (
            <div key={item.channel} className="space-y-3 rounded-lg border border-border/70 p-4">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="font-medium">{item.channel}</p>
                  <p className="text-xs text-muted-foreground">{item.provider}</p>
                </div>
                <Badge variant={item.configured ? "default" : "destructive"}>
                  {item.configured ? "configurado" : "incompleto"}
                </Badge>
              </div>
              <div className="space-y-1">
                <Label>Endpoint</Label>
                <Input readOnly value={item.endpoint} className="font-mono text-xs" />
              </div>
              <div className="space-y-1">
                <Label>Callback</Label>
                <div className="flex gap-2">
                  <Input readOnly value={item.callbackUrl} className="font-mono text-xs" />
                  <Button
                    size="icon"
                    variant="outline"
                    onClick={() => {
                      navigator.clipboard.writeText(item.callbackUrl);
                      toast.success("Callback copiado");
                    }}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Aba Usuários ────────────────────────────────────────────────────────────
function UsersTab() {
  const qc = useQueryClient();
  const listFn = useServerFn(adminListUsers);
  const { data, isLoading } = useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => listFn({ data: {} }),
  });

  const users = (data?.users ?? []) as UserRow[];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {isLoading
            ? "Carregando…"
            : `${users.length} usuário(s) — uso e custo dos últimos 30 dias.`}
        </p>
        <CreateUserDialog onCreated={() => qc.invalidateQueries({ queryKey: ["admin"] })} />
      </div>
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Usuário</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">SMS</TableHead>
                <TableHead className="text-right">Ligações (min)</TableHead>
                <TableHead className="text-right">Emails</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => {
                const banned = u.banned_until && new Date(u.banned_until) > new Date();
                return (
                  <TableRow key={u.user_id}>
                    <TableCell>
                      <div className="font-medium">{u.email ?? "—"}</div>
                      <div className="text-xs text-muted-foreground">
                        {u.tenant_nome ?? "sem conta"} · cadastrado em {fmtDate(u.created_at)}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        último login: {fmtDate(u.last_sign_in_at)}
                      </div>
                    </TableCell>
                    <TableCell>
                      {banned ? (
                        <Badge variant="destructive">Desativado</Badge>
                      ) : (
                        <Badge variant="secondary">Ativo</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div>{Number(u.sms_count)}</div>
                      <div className="text-xs text-muted-foreground">{brl(u.sms_cost)}</div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div>{Number(u.call_minutes).toFixed(1)}</div>
                      <div className="text-xs text-muted-foreground">{brl(u.call_cost)}</div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div>{Number(u.email_count)}</div>
                      <div className="text-xs text-muted-foreground">{brl(u.email_cost)}</div>
                    </TableCell>
                    <TableCell className="text-right font-semibold">{brl(u.total_cost)}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <ImpersonateButton userId={u.user_id} email={u.email ?? ""} />
                        <ManageAccessButton userId={u.user_id} email={u.email ?? ""} />
                        <ToggleActiveButton
                          userId={u.user_id}
                          email={u.email ?? ""}
                          banned={!!banned}
                        />
                        <DeleteUserButton userId={u.user_id} email={u.email ?? ""} />
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {users.length === 0 && !isLoading && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-sm text-muted-foreground py-8">
                    Nenhum usuário cadastrado ainda.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function ManageAccessButton({ userId, email }: { userId: string; email: string }) {
  const [open, setOpen] = useState(false);
  const [tenantId, setTenantId] = useState("");
  const [role, setRole] = useState<"admin" | "gestor" | "member">("member");
  const qc = useQueryClient();
  const getAccesses = useServerFn(adminGetUserAccesses);
  const assign = useServerFn(adminAssignUserToTenant);
  const remove = useServerFn(adminRemoveUserFromTenant);
  const { data, isLoading } = useQuery({
    queryKey: ["admin-user-accesses", userId],
    queryFn: () => getAccesses({ data: { user_id: userId } }),
    enabled: open,
  });
  const assignMut = useMutation({
    mutationFn: () => assign({ data: { user_id: userId, tenant_id: tenantId, role } }),
    onSuccess: () => {
      toast.success("Acesso atualizado");
      setTenantId("");
      qc.invalidateQueries({ queryKey: ["admin-user-accesses", userId] });
      qc.invalidateQueries({ queryKey: ["admin"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const removeMut = useMutation({
    mutationFn: (id: string) => remove({ data: { user_id: userId, tenant_id: id } }),
    onSuccess: () => {
      toast.success("Acesso removido");
      qc.invalidateQueries({ queryKey: ["admin-user-accesses", userId] });
      qc.invalidateQueries({ queryKey: ["admin"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const linked = new Set((data?.memberships ?? []).map((item) => item.tenant_id));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" title="Gerenciar acessos">
          <Settings2 className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Acessos de {email}</DialogTitle>
          <DialogDescription>Defina os tenants e privilégios desta conta.</DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Carregando acessos...</p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2 rounded-lg border border-border/60 p-3">
              <p className="text-sm font-medium">Adicionar tenant</p>
              <div className="grid gap-2 sm:grid-cols-[1fr_130px_auto]">
                <Select value={tenantId} onValueChange={setTenantId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Selecione um tenant" />
                  </SelectTrigger>
                  <SelectContent>
                    {(data?.tenants ?? [])
                      .filter((tenant) => !linked.has(tenant.id))
                      .map((tenant) => (
                        <SelectItem key={tenant.id} value={tenant.id}>
                          {tenant.nome}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <Select value={role} onValueChange={(value) => setRole(value as typeof role)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="member">Membro</SelectItem>
                    <SelectItem value="gestor">Gestor</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  disabled={!tenantId || assignMut.isPending}
                  onClick={() => assignMut.mutate()}
                >
                  Adicionar
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              {(data?.memberships ?? []).map((membership) => (
                <div
                  key={membership.id}
                  className="flex items-center gap-3 rounded-lg border border-border/60 p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {membership.tenant?.nome ?? membership.tenant_id}
                    </p>
                    <p className="text-xs text-muted-foreground">{membership.role}</p>
                  </div>
                  <Select
                    value={membership.role}
                    onValueChange={(value) => {
                      setTenantId(membership.tenant_id!);
                      setRole(value as typeof role);
                      assign({
                        data: {
                          user_id: userId,
                          tenant_id: membership.tenant_id!,
                          role: value as typeof role,
                        },
                      })
                        .then(() =>
                          qc.invalidateQueries({ queryKey: ["admin-user-accesses", userId] }),
                        )
                        .catch((error: Error) => toast.error(error.message));
                    }}
                  >
                    <SelectTrigger className="w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="member">Membro</SelectItem>
                      <SelectItem value="gestor">Gestor</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={membership.role === "admin" || removeMut.isPending}
                    aria-label={`Remover acesso a ${membership.tenant?.nome ?? "esta conta"}`}
                    onClick={async () => {
                      const tenantName = membership.tenant?.nome ?? "esta conta";
                      const confirmed = await requestConfirmation({
                        title: "Remover acesso à conta?",
                        description: `${email} deixa de acessar ${tenantName} imediatamente. Para devolver o acesso, será preciso adicionar o vínculo de novo.`,
                        confirmLabel: "Remover acesso",
                        destructive: true,
                      });
                      if (confirmed) removeMut.mutate(membership.tenant_id!);
                    }}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              ))}
              {!data?.memberships?.length && (
                <p className="text-sm text-muted-foreground">Sem vínculos de tenant.</p>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CreateUserDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const createFn = useServerFn(adminCreateUser);
  const mut = useMutation({
    mutationFn: () => createFn({ data: { email, password } }),
    onSuccess: () => {
      toast.success("Usuário criado");
      setOpen(false);
      setEmail("");
      setPassword("");
      onCreated();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gap-2">
          <Plus className="h-4 w-4" /> Novo usuário
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Criar novo usuário</DialogTitle>
          <DialogDescription>
            O usuário será criado com uma conta isolada própria e poderá fazer login imediatamente.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="hidden">
            <Label htmlFor="dn">Nome da conta</Label>
            <Input id="dn" value="" onChange={() => {}} placeholder="Ex: Casa do João" />
          </div>
          <div>
            <Label htmlFor="em">Email</Label>
            <Input id="em" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="pw">Senha (mín. 8 caracteres)</Label>
            <Input
              id="pw"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <Button
            disabled={mut.isPending || !email || password.length < 8}
            onClick={() => mut.mutate()}
          >
            {mut.isPending ? "Criando…" : "Criar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImpersonateButton({ userId, email }: { userId: string; email: string }) {
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const fn = useServerFn(adminGenerateLoginLink);
  const mut = useMutation({
    mutationFn: () => fn({ data: { user_id: userId } }),
    onSuccess: (r) => {
      setLink(r.action_link);
      setOpen(true);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        title="Entrar como"
        onClick={() => mut.mutate()}
        disabled={mut.isPending}
      >
        <LogIn className="h-4 w-4" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Entrar como {email}</DialogTitle>
            <DialogDescription>
              Abra este link em uma aba anônima para entrar como o usuário. O link é de uso único e
              expira em pouco tempo. Para voltar à sua conta de super admin, basta fazer logout e
              entrar novamente com sua conta.
            </DialogDescription>
          </DialogHeader>
          {link && (
            <div className="space-y-2">
              <textarea
                readOnly
                value={link}
                className="w-full h-24 text-xs p-2 rounded-md border bg-muted/30 font-mono"
              />
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="gap-2"
                  onClick={() => {
                    navigator.clipboard.writeText(link);
                    toast.success("Link copiado");
                  }}
                >
                  <Copy className="h-4 w-4" /> Copiar
                </Button>
                <Button
                  className="gap-2"
                  onClick={() => window.open(link, "_blank", "noopener,noreferrer")}
                >
                  <LogIn className="h-4 w-4" /> Abrir em nova aba
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function ToggleActiveButton({
  userId,
  email,
  banned,
}: {
  userId: string;
  email: string;
  banned: boolean;
}) {
  const qc = useQueryClient();
  const fn = useServerFn(adminSetUserActive);
  const mut = useMutation({
    mutationFn: () => fn({ data: { user_id: userId, active: banned } }),
    onSuccess: () => {
      toast.success(banned ? "Usuário reativado" : "Usuário desativado");
      qc.invalidateQueries({ queryKey: ["admin"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Button
      size="sm"
      variant="ghost"
      title={banned ? "Reativar" : "Desativar"}
      aria-label={banned ? `Reativar ${email || "usuário"}` : `Desativar ${email || "usuário"}`}
      onClick={async () => {
        if (!banned) {
          const confirmed = await requestConfirmation({
            title: `Desativar ${email || "este usuário"}?`,
            description:
              "A pessoa não consegue mais entrar no sistema, em nenhuma conta, até ser reativada. Os dados e os vínculos são mantidos.",
            confirmLabel: "Desativar usuário",
            destructive: true,
          });
          if (!confirmed) return;
        }
        mut.mutate();
      }}
      disabled={mut.isPending}
    >
      {banned ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <Ban className="h-4 w-4" />}
    </Button>
  );
}

function DeleteUserButton({ userId, email }: { userId: string; email: string }) {
  const qc = useQueryClient();
  const fn = useServerFn(adminDeleteUser);
  const mut = useMutation({
    mutationFn: () => fn({ data: { user_id: userId } }),
    onSuccess: () => {
      toast.success("Usuário excluído");
      qc.invalidateQueries({ queryKey: ["admin"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="ghost" title="Excluir">
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Excluir {email}?</AlertDialogTitle>
          <AlertDialogDescription>
            Esta ação remove o acesso desta conta permanentemente. Os dados gerados pela conta no
            sistema permanecem no histórico até você apagá-los manualmente.
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

// ─── Aba Métricas ────────────────────────────────────────────────────────────
type WalletTenantRow = {
  tenant_id: string;
  tenant_name: string | null;
  balance: number;
  lifetime_purchased: number;
  lifetime_used: number;
  exempt: boolean;
  has_custom_pricing: boolean;
};

type SmsCreditOrderRow = {
  id: string;
  tenant_id: string;
  credits: number;
  amount_cents: number;
  currency: string;
  status: string;
  checkout_provider: string;
  external_reference: string | null;
  created_at: string;
  paid_at: string | null;
  tenants?: { nome?: string | null } | Array<{ nome?: string | null }> | null;
};

function centsAdmin(value: number | string | null | undefined) {
  return brl(Number(value ?? 0) / 100);
}

function orderTenantName(order: SmsCreditOrderRow) {
  const tenants = order.tenants;
  if (Array.isArray(tenants)) return tenants[0]?.nome ?? order.tenant_id.slice(0, 8);
  return tenants?.nome ?? order.tenant_id.slice(0, 8);
}

function BalanceAdminTab() {
  const fn = useServerFn(adminSmsCreditConsole);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin", "balance"],
    queryFn: () => fn(),
  });

  const wallets = (data?.wallets ?? []) as WalletTenantRow[];
  const orders = (data?.orders ?? []) as SmsCreditOrderRow[];

  if (isLoading) {
    return <Card className="h-48 animate-pulse" />;
  }
  if (isError) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Não foi possível carregar o saldo agora.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wallet className="h-5 w-5 text-primary" />
            Saldo por casa
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Casa</TableHead>
                <TableHead className="text-right">Saldo</TableHead>
                <TableHead className="text-right">Usado</TableHead>
                <TableHead className="text-right">Comprado</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {wallets.map((row) => (
                <TableRow key={row.tenant_id}>
                  <TableCell>
                    <div className="font-medium">{row.tenant_name ?? "Sem nome"}</div>
                    <div className="text-xs text-muted-foreground font-mono">{row.tenant_id}</div>
                    <div className="mt-1 flex gap-1">
                      {row.exempt && (
                        <Badge className="bg-emerald-500/15 text-emerald-400">Isenta</Badge>
                      )}
                      {row.has_custom_pricing && (
                        <Badge className="bg-primary/15 text-primary">preço individual</Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-semibold">{brl(row.balance)}</TableCell>
                  <TableCell className="text-right">{brl(row.lifetime_used)}</TableCell>
                  <TableCell className="text-right">{brl(row.lifetime_purchased)}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      <AdjustWalletDialog tenant={row} />
                      <TenantPriceDialog tenant={row} />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {wallets.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                    Nenhuma casa encontrada.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <SmsCreditOrdersCard orders={orders} />
    </div>
  );
}

function AdjustWalletDialog({ tenant }: { tenant: WalletTenantRow }) {
  const qc = useQueryClient();
  const fn = useServerFn(adminAdjustSmsCredits);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("50");
  const [reason, setReason] = useState("Ajuste manual pelo superadmin");
  const mut = useMutation({
    mutationFn: () =>
      fn({
        data: {
          tenantId: tenant.tenant_id,
          amount: Number(amount),
          reason,
        },
      }),
    onSuccess: () => {
      toast.success("Saldo ajustado");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["admin", "balance"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Saldo
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ajustar saldo</DialogTitle>
          <DialogDescription>
            Valor em R$. Use positivo para adicionar saldo e negativo para remover. A movimentação
            fica no extrato.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Casa</Label>
            <p className="text-sm font-medium">{tenant.tenant_name ?? tenant.tenant_id}</p>
          </div>
          <div className="space-y-2">
            <Label>Valor (R$)</Label>
            <Input
              type="number"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Motivo</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <Button
            disabled={mut.isPending || !Number(amount) || reason.trim().length < 3}
            onClick={() => mut.mutate()}
          >
            Confirmar ajuste
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TenantPriceDialog({ tenant }: { tenant: WalletTenantRow }) {
  const qc = useQueryClient();
  const effectiveFn = useServerFn(getTenantEffectivePrice);
  const setFn = useServerFn(adminSetTenantPrice);
  const clearFn = useServerFn(adminClearTenantPrice);
  const [open, setOpen] = useState(false);
  const [item, setItem] = useState<"sms" | "voice_30s" | "email">("sms");
  const [unitPrice, setUnitPrice] = useState("");

  const effective = useQuery({
    queryKey: ["admin", "tenant-price", tenant.tenant_id, item],
    queryFn: () => effectiveFn({ data: { tenantId: tenant.tenant_id, item } }),
    enabled: open,
  });

  // Prefill with the item's CURRENT effective price whenever the dialog
  // opens or the selected item changes — never a literal default (a
  // previous bug always started at "0.08", which silently priced E-mail at
  // R$ 0,08 if saved without editing it first).
  useEffect(() => {
    if (!open) return;
    setUnitPrice(effective.data?.unitPrice != null ? String(effective.data.unitPrice) : "");
  }, [open, item, effective.data?.unitPrice]);

  const save = useMutation({
    mutationFn: () =>
      setFn({ data: { tenantId: tenant.tenant_id, item, unitPrice: Number(unitPrice) } }),
    onSuccess: () => {
      toast.success("Preço individual salvo");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["admin", "balance"] });
      qc.invalidateQueries({ queryKey: ["admin", "tenant-price"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const clear = useMutation({
    mutationFn: () => clearFn({ data: { tenantId: tenant.tenant_id, item } }),
    onSuccess: () => {
      toast.success("Preço individual removido");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["admin", "balance"] });
      qc.invalidateQueries({ queryKey: ["admin", "tenant-price"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const unitPriceValue = Number(unitPrice);
  const unitPriceInvalid =
    unitPrice.trim() === "" || !Number.isFinite(unitPriceValue) || unitPriceValue < 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setItem("sms");
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Preço
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Preço individual da casa</DialogTitle>
          <DialogDescription>
            Vale para um item só desta casa. Use &quot;Voltar ao padrão&quot; para remover a
            exceção e voltar ao preço global.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Item</Label>
            <Select value={item} onValueChange={(value) => setItem(value as typeof item)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sms">SMS</SelectItem>
                <SelectItem value="voice_30s">Voz</SelectItem>
                <SelectItem value="email">E-mail</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Preço unitário (R$)</Label>
            <Input
              type="number"
              min="0"
              step="0.0001"
              value={unitPrice}
              disabled={effective.isLoading}
              placeholder={effective.isLoading ? "Carregando…" : undefined}
              onChange={(e) => setUnitPrice(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          {effective.data?.hasOverride && (
            <Button variant="outline" disabled={clear.isPending} onClick={() => clear.mutate()}>
              Voltar ao padrão
            </Button>
          )}
          <Button
            disabled={save.isPending || effective.isLoading || unitPriceInvalid}
            onClick={() => save.mutate()}
          >
            Salvar preço
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SmsCreditOrdersCard({ orders }: { orders: SmsCreditOrderRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Receipt className="h-5 w-5 text-primary" />
          Pedidos antigos (somente leitura)
        </CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Pedido</TableHead>
              <TableHead>Tenant</TableHead>
              <TableHead className="text-right">Créditos</TableHead>
              <TableHead className="text-right">Valor</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Criado em</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders.map((order) => (
              <TableRow key={order.id}>
                <TableCell className="font-mono text-xs">{order.id.slice(0, 8)}</TableCell>
                <TableCell>{orderTenantName(order)}</TableCell>
                <TableCell className="text-right">
                  {Number(order.credits).toLocaleString("pt-BR")}
                </TableCell>
                <TableCell className="text-right">{centsAdmin(order.amount_cents)}</TableCell>
                <TableCell>
                  {order.status === "paid" ? (
                    <Badge className="bg-emerald-500/15 text-emerald-400">pago</Badge>
                  ) : (
                    <Badge variant="secondary">{order.status}</Badge>
                  )}
                </TableCell>
                <TableCell>{fmtDate(order.created_at)}</TableCell>
              </TableRow>
            ))}
            {orders.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                  Nenhum pedido criado.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function MetricsTab() {
  const fn = useServerFn(adminPlatformMetrics);
  const { data, isLoading } = useQuery({
    queryKey: ["admin", "metrics"],
    queryFn: () => fn({ data: {} }),
  });
  const m = (data?.metrics ?? {}) as Record<string, number>;
  const items: Array<{ label: string; value: string }> = [
    { label: "Usuários totais", value: String(m.total_users ?? 0) },
    { label: "Usuários ativos (30d)", value: String(m.active_users_30d ?? 0) },
    { label: "Tentativas de SMS (30d)", value: String(m.sms_total ?? 0) },
    // `sms_delivered` counts status in (sent, delivered, ...): accepted by the
    // provider, not confirmed delivery (the provider does not report it).
    { label: "SMS enviados (30d)", value: String(m.sms_delivered ?? 0) },
    { label: "Ligações (30d)", value: String(m.call_total ?? 0) },
    { label: "Tentativas de email (30d)", value: String(m.email_total ?? 0) },
    { label: "Emails enviados (30d)", value: String(m.email_delivered ?? 0) },
  ];
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      {isLoading
        ? Array.from({ length: 7 }).map((_, i) => <Card key={i} className="animate-pulse h-24" />)
        : items.map((it) => (
            <Card key={it.label}>
              <CardHeader className="pb-1">
                <CardTitle className="text-xs text-muted-foreground font-medium">
                  {it.label}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold tracking-tight">{it.value}</div>
              </CardContent>
            </Card>
          ))}
    </div>
  );
}

// ─── Aba Preços ──────────────────────────────────────────────────────────────
type PriceBookRow = {
  item: "sms" | "voice_30s" | "email";
  unit_price: number;
  provider_unit_cost: number | null;
  free_monthly_units: number;
};

function PricingTab() {
  const qc = useQueryClient();
  const fn = useServerFn(getPricing);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["admin", "pricing"],
    queryFn: () => fn(),
  });
  const items = (data?.pricing ?? []) as PriceBookRow[];

  if (isError) {
    return (
      <Card className="max-w-2xl">
        <CardContent className="flex flex-col items-start gap-3 py-8 text-sm text-muted-foreground">
          Não foi possível carregar os preços agora.
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            Tentar de novo
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3 max-w-2xl">
      <p className="text-sm text-muted-foreground">
        Preço padrão vigente por item. Vale para toda casa sem exceção individual (aba Saldo).
      </p>
      {isLoading && <Card className="h-32 animate-pulse" />}
      {items.map((it) => (
        <PricingRow
          key={it.item}
          row={it}
          onSaved={() => qc.invalidateQueries({ queryKey: ["admin"] })}
        />
      ))}
    </div>
  );
}

function PricingRow({ row, onSaved }: { row: PriceBookRow; onSaved: () => void }) {
  const [unitPrice, setUnitPrice] = useState(String(row.unit_price));
  const [providerCost, setProviderCost] = useState(
    row.provider_unit_cost == null ? "" : String(row.provider_unit_cost),
  );
  const [freeUnits, setFreeUnits] = useState(String(row.free_monthly_units));
  const fn = useServerFn(setPricing);
  const mut = useMutation({
    mutationFn: () =>
      fn({
        data: {
          item: row.item,
          unit_price: Number(unitPrice),
          provider_unit_cost: providerCost.trim() === "" ? null : Number(providerCost),
          free_monthly_units: Number(freeUnits),
        },
      }),
    onSuccess: () => {
      toast.success("Preço atualizado");
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Card>
      <CardContent className="grid gap-3 p-4 sm:grid-cols-[1fr_repeat(3,0.8fr)_auto] sm:items-end">
        <div className="font-medium">{BILLING_ITEM_LABEL[row.item]}</div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Preço de venda (R$)</Label>
          <Input
            type="number"
            step="0.0001"
            min="0"
            value={unitPrice}
            onChange={(e) => setUnitPrice(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Custo fornecedor (R$)</Label>
          <Input
            type="number"
            step="0.0001"
            min="0"
            value={providerCost}
            onChange={(e) => setProviderCost(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Franquia mensal</Label>
          <Input
            type="number"
            step="1"
            min="0"
            value={freeUnits}
            onChange={(e) => setFreeUnits(e.target.value)}
          />
        </div>
        <Button onClick={() => mut.mutate()} disabled={mut.isPending || unitPrice === ""}>
          {mut.isPending ? "Salvando…" : "Salvar"}
        </Button>
      </CardContent>
    </Card>
  );
}
