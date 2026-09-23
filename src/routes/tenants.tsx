import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Building2,
  Clock3,
  CreditCard,
  FileClock,
  Plus,
  Receipt,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  addUserToTenant,
  adminCreateTenant,
  getTenantManagementConsole,
  removeUserFromTenant,
  updateTenantSettings,
  updateTenantUserRole,
} from "@/lib/tenants.functions";
import {
  adminAdjustSmsCredits,
  adminClearTenantSmsPricing,
  adminSetTenantSmsPricing,
} from "@/lib/sms-credits.functions";
import { brl, num } from "@/lib/format";

export const Route = createFileRoute("/tenants")({
  component: TenantsPage,
});

type TenantRow = {
  id: string;
  nome: string;
  slug: string;
  status: "active" | "suspended" | "trial" | "canceled";
  plano: "starter" | "pro" | "enterprise" | "interno";
  crm_model?: "CRM_PLATAFORMA" | "CRM_EXPERT" | null;
  created_at: string;
  updated_at: string | null;
};

type TenantUser = {
  id: string;
  user_id: string;
  role: "user" | "admin" | "owner" | "member";
  created_at: string;
  email: string | null;
  last_sign_in_at: string | null;
  banned_until: string | null;
};

type TenantDetail = {
  tenant: TenantRow;
  users: TenantUser[];
  reports: {
    players_total: number;
    sms_30d: number;
    email_30d: number;
    calls_30d: number;
    webhooks_30d: number;
    meta_accounts: number;
  };
  sms: {
    summary: {
      balance_credits?: number;
      lifetime_purchased_credits?: number;
      lifetime_manual_credits?: number;
      lifetime_used_credits?: number;
      pricing?: Record<string, unknown>;
    };
    pricing: {
      sale_price_per_sms?: number;
      provider_cost_per_sms?: number;
      has_tenant_override?: boolean;
      low_balance_threshold?: number;
    };
    ledger: Array<{
      id: string;
      delta_credits: number;
      balance_after: number;
      entry_type: string;
      reason: string | null;
      created_by: string | null;
      created_at: string;
    }>;
    orders: Array<{
      id: string;
      credits: number;
      amount_cents: number;
      currency: string;
      status: string;
      checkout_provider: string;
      created_at: string;
      paid_at: string | null;
    }>;
  };
  audit: Array<{
    id: string;
    actor_user_id: string | null;
    action: string;
    entity_type: string;
    entity_id: string | null;
    before_data: unknown;
    after_data: unknown;
    metadata: unknown;
    created_at: string;
  }>;
};

type ConsoleData = {
  isSuperAdmin: boolean;
  tenants: TenantRow[];
  selectedTenantId: string | null;
  detail: TenantDetail | null;
};

const ROLE_LABEL: Record<TenantUser["role"], string> = {
  user: "admin principal",
  owner: "owner",
  admin: "admin",
  member: "membro",
};

function fmtDate(value: string | null | undefined) {
  if (!value) return "-";
  return new Date(value).toLocaleString("pt-BR");
}

function cents(value: number | null | undefined) {
  return brl((value ?? 0) / 100);
}

function statusBadge(status: TenantRow["status"]) {
  if (status === "active")
    return <Badge className="bg-emerald-500/15 text-emerald-400">ativo</Badge>;
  if (status === "trial") return <Badge className="bg-blue-500/15 text-blue-300">trial</Badge>;
  if (status === "suspended")
    return <Badge className="bg-amber-500/15 text-amber-300">suspenso</Badge>;
  return <Badge variant="destructive">cancelado</Badge>;
}

function TenantsPage() {
  const qc = useQueryClient();
  const consoleFn = useServerFn(getTenantManagementConsole);
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["tenants-console", selectedTenantId],
    queryFn: () => consoleFn({ data: { tenantId: selectedTenantId } }),
  });

  const consoleData = data as ConsoleData | undefined;
  const tenants = useMemo(() => consoleData?.tenants ?? [], [consoleData?.tenants]);
  const detail = consoleData?.detail ?? null;
  const activeTenantId = consoleData?.selectedTenantId ?? selectedTenantId;

  useEffect(() => {
    if (!selectedTenantId && consoleData?.selectedTenantId) {
      setSelectedTenantId(consoleData.selectedTenantId);
    }
  }, [consoleData?.selectedTenantId, selectedTenantId]);

  const filteredTenants = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return tenants;
    return tenants.filter(
      (tenant) =>
        tenant.nome.toLowerCase().includes(needle) ||
        tenant.slug.toLowerCase().includes(needle) ||
        tenant.id.toLowerCase().includes(needle),
    );
  }, [search, tenants]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <Building2 className="h-6 w-6" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight">Tenants</h1>
          <p className="text-muted-foreground">
            Gestão de contas, usuários, saldo, relatórios e auditoria da operação.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => qc.invalidateQueries({ queryKey: ["tenants-console"] })}
          >
            Atualizar
          </Button>
          {consoleData?.isSuperAdmin && <CreateTenantDialog />}
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[330px_1fr]">
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="h-4 w-4 text-primary" />
              Contas
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-9"
                placeholder="Buscar tenant"
              />
            </div>
            <div className="max-h-[620px] space-y-2 overflow-y-auto pr-1">
              {isLoading &&
                Array.from({ length: 4 }).map((_, index) => (
                  <div key={index} className="h-20 animate-pulse rounded-lg border bg-muted/20" />
                ))}
              {filteredTenants.map((tenant) => {
                const active = tenant.id === activeTenantId;
                return (
                  <button
                    key={tenant.id}
                    type="button"
                    onClick={() => setSelectedTenantId(tenant.id)}
                    className={`w-full rounded-lg border p-3 text-left transition ${
                      active
                        ? "border-primary/60 bg-primary/10"
                        : "border-border/70 bg-card hover:border-primary/30"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate font-semibold">{tenant.nome}</div>
                        <div className="truncate text-xs text-muted-foreground">{tenant.slug}</div>
                      </div>
                      {statusBadge(tenant.status)}
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                      <span>{tenant.plano}</span>
                      <span>{tenant.crm_model === "CRM_EXPERT" ? "Expert" : "Plataforma"}</span>
                    </div>
                  </button>
                );
              })}
              {!isLoading && !filteredTenants.length && (
                <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  Nenhum tenant encontrado.
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {detail ? (
          <TenantWorkspace detail={detail} isSuperAdmin={!!consoleData?.isSuperAdmin} />
        ) : (
          <Card className="min-h-96">
            <CardContent className="flex h-96 items-center justify-center text-muted-foreground">
              {isLoading ? "Carregando tenants..." : "Selecione ou crie um tenant para começar."}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function TenantWorkspace({
  detail,
  isSuperAdmin,
}: {
  detail: TenantDetail;
  isSuperAdmin: boolean;
}) {
  const tenant = detail.tenant;
  const balance = Number(detail.sms.summary.balance_credits ?? 0);
  const used = Number(detail.sms.summary.lifetime_used_credits ?? 0);
  const purchased = Number(detail.sms.summary.lifetime_purchased_credits ?? 0);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          icon={Users}
          label="Usuários"
          value={num(detail.users.length)}
          hint={tenant.plano}
        />
        <MetricCard
          icon={Wallet}
          label="Saldo SMS"
          value={num(balance)}
          hint={`${num(used)} créditos consumidos`}
        />
        <MetricCard
          icon={Activity}
          label="Players"
          value={num(detail.reports.players_total)}
          hint={`${num(detail.reports.webhooks_30d)} webhooks em 30 dias`}
        />
        <MetricCard
          icon={CreditCard}
          label="Comprado"
          value={num(purchased)}
          hint={statusBadge(tenant.status)}
        />
      </div>

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList className="flex h-auto flex-wrap justify-start">
          <TabsTrigger value="overview">Visão geral</TabsTrigger>
          <TabsTrigger value="users">Usuários</TabsTrigger>
          <TabsTrigger value="credits">Saldo SMS</TabsTrigger>
          <TabsTrigger value="reports">Relatórios</TabsTrigger>
          <TabsTrigger value="audit">Auditoria</TabsTrigger>
          <TabsTrigger value="settings">Configuração</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <OverviewTab detail={detail} isSuperAdmin={isSuperAdmin} />
        </TabsContent>
        <TabsContent value="users">
          <UsersTab detail={detail} />
        </TabsContent>
        <TabsContent value="credits">
          <CreditsTab detail={detail} isSuperAdmin={isSuperAdmin} />
        </TabsContent>
        <TabsContent value="reports">
          <ReportsTab detail={detail} />
        </TabsContent>
        <TabsContent value="audit">
          <AuditTab detail={detail} />
        </TabsContent>
        <TabsContent value="settings">
          <SettingsTab detail={detail} isSuperAdmin={isSuperAdmin} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Users;
  label: string;
  value: string;
  hint: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <Icon className="h-5 w-5" />
        </div>
        <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {label}
        </div>
        <div className="mt-2 text-3xl font-bold">{value}</div>
        <div className="mt-1 text-sm text-muted-foreground">{hint}</div>
      </CardContent>
    </Card>
  );
}

function OverviewTab({ detail, isSuperAdmin }: { detail: TenantDetail; isSuperAdmin: boolean }) {
  const tenant = detail.tenant;
  const pricing = detail.sms.pricing;
  const margin =
    Number(pricing.sale_price_per_sms ?? 0) - Number(pricing.provider_cost_per_sms ?? 0);

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_0.8fr]">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-primary" />
            Identidade do tenant
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Info label="Nome" value={tenant.nome} />
          <Info label="Slug" value={tenant.slug} mono />
          <Info label="Status" value={statusBadge(tenant.status)} />
          <Info label="Plano" value={tenant.plano} />
          <Info
            label="Modelo CRM"
            value={tenant.crm_model === "CRM_EXPERT" ? "CRM Expert" : "CRM Plataforma"}
          />
          <Info label="Criado em" value={fmtDate(tenant.created_at)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings2 className="h-5 w-5 text-primary" />
            Saúde operacional
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <HealthLine label="Saldo SMS" ok={Number(detail.sms.summary.balance_credits ?? 0) > 0} />
          <HealthLine label="Usuário administrador" ok={detail.users.length > 0} />
          <HealthLine label="Meta conectada" ok={detail.reports.meta_accounts > 0} />
          <HealthLine label="Webhooks chegando" ok={detail.reports.webhooks_30d > 0} />
          <div className="rounded-lg border border-border/70 p-3 text-sm">
            <div className="text-muted-foreground">Margem estimada por SMS</div>
            <div
              className={
                margin >= 0 ? "font-semibold text-emerald-400" : "font-semibold text-red-400"
              }
            >
              {brl(margin)}
            </div>
          </div>
          {!isSuperAdmin && (
            <p className="text-xs text-muted-foreground">
              Alterações financeiras e status do tenant ficam restritas ao superadmin.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Info({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border/70 p-3">
      <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
      <div className={`mt-1 break-words font-medium ${mono ? "font-mono text-xs" : ""}`}>
        {value}
      </div>
    </div>
  );
}

function HealthLine({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border/70 px-3 py-2 text-sm">
      <span>{label}</span>
      <Badge
        className={ok ? "bg-emerald-500/15 text-emerald-400" : "bg-amber-500/15 text-amber-300"}
      >
        {ok ? "ok" : "atenção"}
      </Badge>
    </div>
  );
}

function UsersTab({ detail }: { detail: TenantDetail }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-4">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5 text-primary" />
            Usuários do tenant
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Adicione operadores e mantenha papéis separados da role global de superadmin.
          </p>
        </div>
        <AddUserDialog tenantId={detail.tenant.id} />
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Usuário</TableHead>
              <TableHead>Papel</TableHead>
              <TableHead>Último login</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {detail.users.map((user) => (
              <TableRow key={user.id}>
                <TableCell>
                  <div className="font-medium">{user.email ?? user.user_id}</div>
                  <div className="font-mono text-xs text-muted-foreground">{user.user_id}</div>
                </TableCell>
                <TableCell>
                  <RoleSelect tenantId={detail.tenant.id} user={user} />
                </TableCell>
                <TableCell>{fmtDate(user.last_sign_in_at)}</TableCell>
                <TableCell>
                  {user.banned_until && new Date(user.banned_until) > new Date() ? (
                    <Badge variant="destructive">bloqueado</Badge>
                  ) : (
                    <Badge className="bg-emerald-500/15 text-emerald-400">ativo</Badge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <RemoveUserButton tenantId={detail.tenant.id} user={user} />
                </TableCell>
              </TableRow>
            ))}
            {!detail.users.length && (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  Nenhum usuário vinculado.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function AddUserDialog({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const fn = useServerFn(addUserToTenant);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<TenantUser["role"]>("member");
  const [password, setPassword] = useState("");
  const mut = useMutation({
    mutationFn: () =>
      fn({
        data: {
          tenantId,
          email,
          role,
          password: password.trim() ? password : null,
        },
      }),
    onSuccess: () => {
      toast.success("Usuário vinculado ao tenant");
      setOpen(false);
      setEmail("");
      setPassword("");
      qc.invalidateQueries({ queryKey: ["tenants-console"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gap-2">
          <UserPlus className="h-4 w-4" />
          Adicionar usuário
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Adicionar usuário ao tenant</DialogTitle>
          <DialogDescription>
            Se o email ainda não existir, uma conta será criada. Senha vazia envia convite pelo
            Supabase.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label>Email</Label>
            <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Papel</Label>
            <Select value={role} onValueChange={(value) => setRole(value as TenantUser["role"])}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">Membro</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="owner">Owner</SelectItem>
                <SelectItem value="user">Admin principal</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Senha inicial opcional</Label>
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="mínimo 8 caracteres"
            />
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

function RoleSelect({ tenantId, user }: { tenantId: string; user: TenantUser }) {
  const qc = useQueryClient();
  const fn = useServerFn(updateTenantUserRole);
  const mut = useMutation({
    mutationFn: (role: TenantUser["role"]) =>
      fn({ data: { tenantId, membershipId: user.id, role } }),
    onSuccess: () => {
      toast.success("Papel atualizado");
      qc.invalidateQueries({ queryKey: ["tenants-console"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <Select value={user.role} onValueChange={(value) => mut.mutate(value as TenantUser["role"])}>
      <SelectTrigger className="w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="member">Membro</SelectItem>
        <SelectItem value="admin">Admin</SelectItem>
        <SelectItem value="owner">Owner</SelectItem>
        <SelectItem value="user">Admin principal</SelectItem>
      </SelectContent>
    </Select>
  );
}

function RemoveUserButton({ tenantId, user }: { tenantId: string; user: TenantUser }) {
  const qc = useQueryClient();
  const fn = useServerFn(removeUserFromTenant);
  const mut = useMutation({
    mutationFn: () => fn({ data: { tenantId, membershipId: user.id } }),
    onSuccess: () => {
      toast.success("Usuário removido do tenant");
      qc.invalidateQueries({ queryKey: ["tenants-console"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <Button size="sm" variant="ghost" disabled={mut.isPending} onClick={() => mut.mutate()}>
      <Trash2 className="h-4 w-4 text-destructive" />
    </Button>
  );
}

function CreditsTab({ detail, isSuperAdmin }: { detail: TenantDetail; isSuperAdmin: boolean }) {
  const pricing = detail.sms.pricing;
  const balance = Number(detail.sms.summary.balance_credits ?? 0);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardContent className="p-5">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Saldo disponível
            </div>
            <div className="mt-2 text-4xl font-bold">{num(balance)}</div>
            <div className="mt-1 text-sm text-muted-foreground">
              {num(Number(detail.sms.summary.lifetime_used_credits ?? 0))} consumidos historicamente
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Preço venda/SMS
            </div>
            <div className="mt-2 text-3xl font-bold">
              {brl(Number(pricing.sale_price_per_sms ?? 0))}
            </div>
            <div className="mt-1 text-sm text-muted-foreground">
              custo fornecedor {brl(Number(pricing.provider_cost_per_sms ?? 0))}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex h-full items-center gap-2 p-5">
            {isSuperAdmin ? (
              <>
                <AdjustCreditsDialog tenant={detail.tenant} />
                <PricingDialog tenant={detail.tenant} pricing={pricing} />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Ajustes manuais e preço individual são restritos ao superadmin.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileClock className="h-5 w-5 text-primary" />
              Extrato de créditos
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Quando</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead className="text-right">Delta</TableHead>
                  <TableHead className="text-right">Saldo</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.sms.ledger.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell>{fmtDate(entry.created_at)}</TableCell>
                    <TableCell>
                      <div className="font-medium">{entry.entry_type}</div>
                      <div className="max-w-64 truncate text-xs text-muted-foreground">
                        {entry.reason ?? "-"}
                      </div>
                    </TableCell>
                    <TableCell
                      className={`text-right font-semibold ${
                        Number(entry.delta_credits) > 0 ? "text-emerald-400" : "text-red-300"
                      }`}
                    >
                      {Number(entry.delta_credits) > 0 ? "+" : ""}
                      {num(Number(entry.delta_credits))}
                    </TableCell>
                    <TableCell className="text-right">{num(Number(entry.balance_after))}</TableCell>
                  </TableRow>
                ))}
                {!detail.sms.ledger.length && (
                  <TableRow>
                    <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                      Nenhuma movimentação ainda.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Receipt className="h-5 w-5 text-primary" />
              Pedidos de compra
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pedido</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Créditos</TableHead>
                  <TableHead className="text-right">Valor</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.sms.orders.map((order) => (
                  <TableRow key={order.id}>
                    <TableCell>
                      <div className="font-mono text-xs">{order.id.slice(0, 8)}</div>
                      <div className="text-xs text-muted-foreground">
                        {fmtDate(order.created_at)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={order.status === "paid" ? "default" : "secondary"}>
                        {order.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{num(Number(order.credits))}</TableCell>
                    <TableCell className="text-right">
                      {cents(Number(order.amount_cents))}
                    </TableCell>
                  </TableRow>
                ))}
                {!detail.sms.orders.length && (
                  <TableRow>
                    <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                      Nenhum pedido de crédito.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function AdjustCreditsDialog({ tenant }: { tenant: TenantRow }) {
  const qc = useQueryClient();
  const fn = useServerFn(adminAdjustSmsCredits);
  const [open, setOpen] = useState(false);
  const [delta, setDelta] = useState("1000");
  const [reason, setReason] = useState("Ajuste manual via área de tenants");
  const mut = useMutation({
    mutationFn: () => fn({ data: { tenantId: tenant.id, delta: Number(delta), reason } }),
    onSuccess: () => {
      toast.success("Saldo ajustado");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["tenants-console"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gap-2">
          <Wallet className="h-4 w-4" />
          Ajustar saldo
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ajustar saldo SMS</DialogTitle>
          <DialogDescription>
            Valor positivo adiciona créditos; valor negativo remove créditos com registro no
            extrato.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label>Tenant</Label>
            <Input value={tenant.nome} readOnly />
          </div>
          <div className="space-y-2">
            <Label>Delta de créditos</Label>
            <Input type="number" value={delta} onChange={(event) => setDelta(event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Motivo</Label>
            <Input value={reason} onChange={(event) => setReason(event.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <Button disabled={mut.isPending || !Number(delta)} onClick={() => mut.mutate()}>
            Confirmar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PricingDialog({
  tenant,
  pricing,
}: {
  tenant: TenantRow;
  pricing: TenantDetail["sms"]["pricing"];
}) {
  const qc = useQueryClient();
  const setFn = useServerFn(adminSetTenantSmsPricing);
  const clearFn = useServerFn(adminClearTenantSmsPricing);
  const [open, setOpen] = useState(false);
  const [sale, setSale] = useState(String(pricing.sale_price_per_sms ?? ""));
  const [cost, setCost] = useState(String(pricing.provider_cost_per_sms ?? ""));

  const save = useMutation({
    mutationFn: () =>
      setFn({
        data: {
          tenantId: tenant.id,
          sale_price_per_sms: sale.trim() ? Number(sale) : null,
          provider_cost_per_sms: cost.trim() ? Number(cost) : null,
        },
      }),
    onSuccess: () => {
      toast.success("Preço individual salvo");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["tenants-console"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const clear = useMutation({
    mutationFn: () => clearFn({ data: { tenantId: tenant.id } }),
    onSuccess: () => {
      toast.success("Preço individual removido");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["tenants-console"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2">
          <Settings2 className="h-4 w-4" />
          Preço SMS
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Preço individual de SMS</DialogTitle>
          <DialogDescription>
            Deixe vazio para voltar a usar a configuração global.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Venda por SMS</Label>
            <Input
              type="number"
              step="0.0001"
              value={sale}
              onChange={(event) => setSale(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Custo fornecedor</Label>
            <Input
              type="number"
              step="0.0001"
              value={cost}
              onChange={(event) => setCost(event.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          {pricing.has_tenant_override && (
            <Button variant="outline" disabled={clear.isPending} onClick={() => clear.mutate()}>
              Remover individual
            </Button>
          )}
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReportsTab({ detail }: { detail: TenantDetail }) {
  const items = [
    { label: "Players totais", value: detail.reports.players_total },
    { label: "SMS enviados em 30 dias", value: detail.reports.sms_30d },
    { label: "Emails enviados em 30 dias", value: detail.reports.email_30d },
    { label: "Ligações em 30 dias", value: detail.reports.calls_30d },
    { label: "Webhooks em 30 dias", value: detail.reports.webhooks_30d },
    { label: "Contas Meta conectadas", value: detail.reports.meta_accounts },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {items.map((item) => (
        <Card key={item.label}>
          <CardContent className="p-5">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {item.label}
            </div>
            <div className="mt-2 text-3xl font-bold">{num(item.value)}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function AuditTab({ detail }: { detail: TenantDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock3 className="h-5 w-5 text-primary" />
          Histórico de alterações
        </CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Quando</TableHead>
              <TableHead>Ação</TableHead>
              <TableHead>Entidade</TableHead>
              <TableHead>Usuário</TableHead>
              <TableHead>Detalhes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {detail.audit.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell>{fmtDate(entry.created_at)}</TableCell>
                <TableCell>
                  <Badge variant="secondary">{entry.action}</Badge>
                </TableCell>
                <TableCell>
                  <div>{entry.entity_type}</div>
                  <div className="font-mono text-xs text-muted-foreground">
                    {entry.entity_id ?? "-"}
                  </div>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {entry.actor_user_id ?? "sistema"}
                </TableCell>
                <TableCell>
                  <details className="max-w-xl">
                    <summary className="cursor-pointer text-primary">ver JSON</summary>
                    <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-muted/30 p-3 text-xs">
                      {JSON.stringify(
                        {
                          before: entry.before_data,
                          after: entry.after_data,
                          metadata: entry.metadata,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                </TableCell>
              </TableRow>
            ))}
            {!detail.audit.length && (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  Nenhuma alteração administrativa registrada.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function SettingsTab({ detail, isSuperAdmin }: { detail: TenantDetail; isSuperAdmin: boolean }) {
  const qc = useQueryClient();
  const fn = useServerFn(updateTenantSettings);
  const tenant = detail.tenant;
  const [form, setForm] = useState({
    nome: tenant.nome,
    status: tenant.status,
    plano: tenant.plano,
    crm_model: tenant.crm_model ?? "CRM_PLATAFORMA",
  });

  useEffect(() => {
    setForm({
      nome: tenant.nome,
      status: tenant.status,
      plano: tenant.plano,
      crm_model: tenant.crm_model ?? "CRM_PLATAFORMA",
    });
  }, [tenant.id, tenant.nome, tenant.status, tenant.plano, tenant.crm_model]);

  const mut = useMutation({
    mutationFn: () => fn({ data: { tenantId: tenant.id, ...form } }),
    onSuccess: () => {
      toast.success("Tenant atualizado");
      qc.invalidateQueries({ queryKey: ["tenants-console"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Settings2 className="h-5 w-5 text-primary" />
          Configuração do tenant
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Nome</Label>
            <Input
              value={form.nome}
              onChange={(event) => setForm((prev) => ({ ...prev, nome: event.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <Label>Slug</Label>
            <Input value={tenant.slug} readOnly className="font-mono text-xs" />
          </div>
          <div className="space-y-2">
            <Label>Status</Label>
            <Select
              value={form.status}
              disabled={!isSuperAdmin}
              onValueChange={(value) =>
                setForm((prev) => ({ ...prev, status: value as TenantRow["status"] }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Ativo</SelectItem>
                <SelectItem value="trial">Trial</SelectItem>
                <SelectItem value="suspended">Suspenso</SelectItem>
                <SelectItem value="canceled">Cancelado</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Plano</Label>
            <Select
              value={form.plano}
              disabled={!isSuperAdmin}
              onValueChange={(value) =>
                setForm((prev) => ({ ...prev, plano: value as TenantRow["plano"] }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="starter">Starter</SelectItem>
                <SelectItem value="pro">Pro</SelectItem>
                <SelectItem value="enterprise">Enterprise</SelectItem>
                <SelectItem value="interno">Interno</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Modelo CRM</Label>
            <Select
              value={form.crm_model}
              disabled={!isSuperAdmin}
              onValueChange={(value) =>
                setForm((prev) => ({ ...prev, crm_model: value as TenantRow["crm_model"] }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="CRM_PLATAFORMA">CRM Plataforma</SelectItem>
                <SelectItem value="CRM_EXPERT">CRM Expert</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <Button
          className="gap-2"
          disabled={mut.isPending || !form.nome.trim()}
          onClick={() => mut.mutate()}
        >
          <Save className="h-4 w-4" />
          Salvar configuração
        </Button>
      </CardContent>
    </Card>
  );
}

function CreateTenantDialog() {
  const qc = useQueryClient();
  const fn = useServerFn(adminCreateTenant);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    nome: "",
    slug: "",
    status: "trial" as TenantRow["status"],
    plano: "starter" as TenantRow["plano"],
    crm_model: "CRM_PLATAFORMA" as NonNullable<TenantRow["crm_model"]>,
  });
  const mut = useMutation({
    mutationFn: () =>
      fn({
        data: {
          nome: form.nome,
          slug: form.slug || null,
          status: form.status,
          plano: form.plano,
          crm_model: form.crm_model,
        },
      }),
    onSuccess: () => {
      toast.success("Tenant criado");
      setOpen(false);
      setForm({
        nome: "",
        slug: "",
        status: "trial",
        plano: "starter",
        crm_model: "CRM_PLATAFORMA",
      });
      qc.invalidateQueries({ queryKey: ["tenants-console"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gap-2">
          <Plus className="h-4 w-4" />
          Novo tenant
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Criar tenant</DialogTitle>
          <DialogDescription>
            Cria uma conta isolada. Usuários e saldo podem ser vinculados depois.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label>Nome</Label>
            <Input
              value={form.nome}
              onChange={(event) => setForm((prev) => ({ ...prev, nome: event.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <Label>Slug opcional</Label>
            <Input
              value={form.slug}
              onChange={(event) => setForm((prev) => ({ ...prev, slug: event.target.value }))}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Status</Label>
              <Select
                value={form.status}
                onValueChange={(value) =>
                  setForm((prev) => ({ ...prev, status: value as TenantRow["status"] }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="trial">Trial</SelectItem>
                  <SelectItem value="active">Ativo</SelectItem>
                  <SelectItem value="suspended">Suspenso</SelectItem>
                  <SelectItem value="canceled">Cancelado</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Plano</Label>
              <Select
                value={form.plano}
                onValueChange={(value) =>
                  setForm((prev) => ({ ...prev, plano: value as TenantRow["plano"] }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="starter">Starter</SelectItem>
                  <SelectItem value="pro">Pro</SelectItem>
                  <SelectItem value="enterprise">Enterprise</SelectItem>
                  <SelectItem value="interno">Interno</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <Button
            disabled={mut.isPending || form.nome.trim().length < 2}
            onClick={() => mut.mutate()}
          >
            Criar tenant
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
