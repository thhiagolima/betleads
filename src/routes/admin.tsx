import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import {
  adminCreateUser,
  adminDeleteUser,
  adminGenerateLoginLink,
  adminListUsers,
  adminPlatformMetrics,
  adminSetUserActive,
  getPricing,
  setPricing,
} from "@/lib/admin.functions";
import {
  adminAdjustSmsCredits,
  adminClearTenantSmsPricing,
  adminMarkSmsCreditOrderPaid,
  adminSetSmsCreditSettings,
  adminSetTenantSmsPricing,
  adminSmsCreditConsole,
  adminUpsertSmsCreditPackage,
} from "@/lib/sms-credits.functions";
import {
  Activity,
  Ban,
  CheckCircle2,
  Copy,
  CreditCard,
  DollarSign,
  LogIn,
  Package as PackageIcon,
  Plus,
  Receipt,
  Settings2,
  ShieldCheck,
  Trash2,
  Users,
  Wallet,
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
            <CreditCard className="h-4 w-4" /> Créditos SMS
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
          <SmsCreditsAdminTab />
        </TabsContent>
      </Tabs>
    </div>
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
                        <ToggleActiveButton userId={u.user_id} banned={!!banned} />
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

function CreateUserDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const createFn = useServerFn(adminCreateUser);
  const mut = useMutation({
    mutationFn: () => createFn({ data: { email, password, display_name: displayName } }),
    onSuccess: () => {
      toast.success("Usuário criado");
      setOpen(false);
      setEmail("");
      setPassword("");
      setDisplayName("");
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
          <div>
            <Label htmlFor="dn">Nome da conta</Label>
            <Input
              id="dn"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Ex: Casa do João"
            />
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
            disabled={mut.isPending || !email || password.length < 8 || !displayName}
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

function ToggleActiveButton({ userId, banned }: { userId: string; banned: boolean }) {
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
      onClick={() => mut.mutate()}
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
type SmsCreditSettings = {
  provider_cost_per_sms: number;
  default_sale_price_per_sms: number;
  min_checkout_credits: number;
  low_balance_threshold: number;
};

type SmsCreditTenantRow = {
  tenant_id: string;
  tenant_name: string | null;
  balance_credits: number;
  lifetime_purchased_credits: number;
  lifetime_used_credits: number;
  sale_price_per_sms: number;
  provider_cost_per_sms: number;
  has_custom_pricing: boolean;
  low_balance_threshold: number;
};

type SmsCreditPackageRow = {
  id?: string;
  name: string;
  credits: number;
  bonus_credits: number;
  price_cents: number;
  is_active: boolean;
  sort_order: number;
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

function nullableNumber(value: string) {
  if (value.trim() === "") return null;
  return Number(value);
}

function orderTenantName(order: SmsCreditOrderRow) {
  const tenants = order.tenants;
  if (Array.isArray(tenants)) return tenants[0]?.nome ?? order.tenant_id.slice(0, 8);
  return tenants?.nome ?? order.tenant_id.slice(0, 8);
}

function SmsCreditsAdminTab() {
  const fn = useServerFn(adminSmsCreditConsole);
  const { data, isLoading } = useQuery({
    queryKey: ["admin", "sms-credits"],
    queryFn: () => fn(),
  });

  const settings = data?.settings as SmsCreditSettings | null | undefined;
  const overview = (data?.overview ?? []) as SmsCreditTenantRow[];
  const packages = (data?.packages ?? []) as SmsCreditPackageRow[];
  const orders = (data?.orders ?? []) as SmsCreditOrderRow[];

  if (isLoading || !settings) {
    return <Card className="h-48 animate-pulse" />;
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
        <SmsCreditSettingsCard settings={settings} />
        <SmsCreditPackagesCard packages={packages} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wallet className="h-5 w-5 text-primary" />
            Saldos por tenant
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tenant</TableHead>
                <TableHead className="text-right">Saldo</TableHead>
                <TableHead className="text-right">Usado</TableHead>
                <TableHead className="text-right">Comprado</TableHead>
                <TableHead className="text-right">Venda/SMS</TableHead>
                <TableHead className="text-right">Custo/SMS</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {overview.map((row) => (
                <TableRow key={row.tenant_id}>
                  <TableCell>
                    <div className="font-medium">{row.tenant_name ?? "Sem nome"}</div>
                    <div className="text-xs text-muted-foreground font-mono">{row.tenant_id}</div>
                    {row.has_custom_pricing && (
                      <Badge className="mt-1 bg-primary/15 text-primary">preço individual</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-semibold">
                    {Number(row.balance_credits).toLocaleString("pt-BR")}
                  </TableCell>
                  <TableCell className="text-right">
                    {Number(row.lifetime_used_credits).toLocaleString("pt-BR")}
                  </TableCell>
                  <TableCell className="text-right">
                    {Number(row.lifetime_purchased_credits).toLocaleString("pt-BR")}
                  </TableCell>
                  <TableCell className="text-right">{brl(row.sale_price_per_sms)}</TableCell>
                  <TableCell className="text-right">{brl(row.provider_cost_per_sms)}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      <AdjustCreditsDialog tenant={row} />
                      <TenantPricingDialog tenant={row} />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {overview.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                    Nenhum tenant encontrado.
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

function SmsCreditSettingsCard({ settings }: { settings: SmsCreditSettings }) {
  const qc = useQueryClient();
  const fn = useServerFn(adminSetSmsCreditSettings);
  const [form, setForm] = useState({
    provider_cost_per_sms: String(settings.provider_cost_per_sms),
    default_sale_price_per_sms: String(settings.default_sale_price_per_sms),
    min_checkout_credits: String(settings.min_checkout_credits),
    low_balance_threshold: String(settings.low_balance_threshold),
  });
  const mut = useMutation({
    mutationFn: () =>
      fn({
        data: {
          provider_cost_per_sms: Number(form.provider_cost_per_sms),
          default_sale_price_per_sms: Number(form.default_sale_price_per_sms),
          min_checkout_credits: Number(form.min_checkout_credits),
          low_balance_threshold: Number(form.low_balance_threshold),
        },
      }),
    onSuccess: () => {
      toast.success("Configuração de créditos atualizada");
      qc.invalidateQueries({ queryKey: ["admin", "sms-credits"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Settings2 className="h-5 w-5 text-primary" />
          Configuração global
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        <AdminNumberField
          label="Custo fornecedor/SMS"
          value={form.provider_cost_per_sms}
          step="0.0001"
          onChange={(v) => setForm((p) => ({ ...p, provider_cost_per_sms: v }))}
        />
        <AdminNumberField
          label="Preço padrão/SMS"
          value={form.default_sale_price_per_sms}
          step="0.0001"
          onChange={(v) => setForm((p) => ({ ...p, default_sale_price_per_sms: v }))}
        />
        <AdminNumberField
          label="Compra mínima"
          value={form.min_checkout_credits}
          step="1"
          onChange={(v) => setForm((p) => ({ ...p, min_checkout_credits: v }))}
        />
        <AdminNumberField
          label="Alerta de saldo baixo"
          value={form.low_balance_threshold}
          step="1"
          onChange={(v) => setForm((p) => ({ ...p, low_balance_threshold: v }))}
        />
        <div className="sm:col-span-2">
          <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
            {mut.isPending ? "Salvando..." : "Salvar configuração"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function AdminNumberField({
  label,
  value,
  step,
  onChange,
}: {
  label: string;
  value: string;
  step: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Input
        type="number"
        min="0"
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function SmsCreditPackagesCard({ packages }: { packages: SmsCreditPackageRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PackageIcon className="h-5 w-5 text-primary" />
          Pacotes de checkout
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {packages.map((pkg) => (
          <SmsCreditPackageForm key={pkg.id} pkg={pkg} />
        ))}
        <SmsCreditPackageForm
          pkg={{
            name: "",
            credits: 1000,
            bonus_credits: 0,
            price_cents: 0,
            is_active: true,
            sort_order: packages.length + 1,
          }}
          isNew
        />
      </CardContent>
    </Card>
  );
}

function SmsCreditPackageForm({
  pkg,
  isNew = false,
}: {
  pkg: SmsCreditPackageRow;
  isNew?: boolean;
}) {
  const qc = useQueryClient();
  const fn = useServerFn(adminUpsertSmsCreditPackage);
  const [form, setForm] = useState({
    name: pkg.name,
    credits: String(pkg.credits),
    bonus_credits: String(pkg.bonus_credits),
    price_cents: String(pkg.price_cents),
    sort_order: String(pkg.sort_order),
    is_active: pkg.is_active,
  });
  const mut = useMutation({
    mutationFn: () =>
      fn({
        data: {
          id: pkg.id ?? null,
          name: form.name,
          credits: Number(form.credits),
          bonus_credits: Number(form.bonus_credits),
          price_cents: Number(form.price_cents),
          sort_order: Number(form.sort_order),
          is_active: form.is_active,
        },
      }),
    onSuccess: () => {
      toast.success(isNew ? "Pacote criado" : "Pacote atualizado");
      qc.invalidateQueries({ queryKey: ["admin", "sms-credits"] });
      if (isNew) {
        setForm({
          name: "",
          credits: "1000",
          bonus_credits: "0",
          price_cents: "0",
          sort_order: "1",
          is_active: true,
        });
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="grid gap-2 rounded-lg border border-border/60 p-3 md:grid-cols-[1.2fr_0.7fr_0.7fr_0.8fr_0.55fr_auto]">
      <Input
        placeholder="Nome"
        value={form.name}
        onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
      />
      <Input
        type="number"
        min="1"
        value={form.credits}
        onChange={(e) => setForm((p) => ({ ...p, credits: e.target.value }))}
      />
      <Input
        type="number"
        min="0"
        value={form.bonus_credits}
        onChange={(e) => setForm((p) => ({ ...p, bonus_credits: e.target.value }))}
      />
      <Input
        type="number"
        min="0"
        value={form.price_cents}
        onChange={(e) => setForm((p) => ({ ...p, price_cents: e.target.value }))}
      />
      <Input
        type="number"
        min="0"
        value={form.sort_order}
        onChange={(e) => setForm((p) => ({ ...p, sort_order: e.target.value }))}
      />
      <Button size="sm" onClick={() => mut.mutate()} disabled={mut.isPending || !form.name}>
        {isNew ? "Criar" : "Salvar"}
      </Button>
      <div className="text-xs text-muted-foreground md:col-span-6">
        {Number(form.credits).toLocaleString("pt-BR")} +{" "}
        {Number(form.bonus_credits).toLocaleString("pt-BR")} créditos por{" "}
        {centsAdmin(form.price_cents)}.
      </div>
    </div>
  );
}

function AdjustCreditsDialog({ tenant }: { tenant: SmsCreditTenantRow }) {
  const qc = useQueryClient();
  const fn = useServerFn(adminAdjustSmsCredits);
  const [open, setOpen] = useState(false);
  const [delta, setDelta] = useState("1000");
  const [reason, setReason] = useState("Ajuste manual pelo superadmin");
  const mut = useMutation({
    mutationFn: () =>
      fn({
        data: {
          tenantId: tenant.tenant_id,
          delta: Number(delta),
          reason,
        },
      }),
    onSuccess: () => {
      toast.success("Saldo ajustado");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["admin", "sms-credits"] });
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
          <DialogTitle>Ajustar saldo SMS</DialogTitle>
          <DialogDescription>
            Use valor positivo para adicionar créditos e negativo para remover. A movimentação fica
            no extrato.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Tenant</Label>
            <p className="text-sm font-medium">{tenant.tenant_name ?? tenant.tenant_id}</p>
          </div>
          <div className="space-y-2">
            <Label>Delta de créditos</Label>
            <Input
              type="number"
              step="1"
              value={delta}
              onChange={(e) => setDelta(e.target.value)}
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
            disabled={mut.isPending || !Number(delta) || reason.length < 3}
            onClick={() => mut.mutate()}
          >
            Confirmar ajuste
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TenantPricingDialog({ tenant }: { tenant: SmsCreditTenantRow }) {
  const qc = useQueryClient();
  const setFn = useServerFn(adminSetTenantSmsPricing);
  const clearFn = useServerFn(adminClearTenantSmsPricing);
  const [open, setOpen] = useState(false);
  const [sale, setSale] = useState(String(tenant.sale_price_per_sms));
  const [cost, setCost] = useState(String(tenant.provider_cost_per_sms));
  const save = useMutation({
    mutationFn: () =>
      setFn({
        data: {
          tenantId: tenant.tenant_id,
          sale_price_per_sms: nullableNumber(sale),
          provider_cost_per_sms: nullableNumber(cost),
        },
      }),
    onSuccess: () => {
      toast.success("Preço individual salvo");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["admin", "sms-credits"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const clear = useMutation({
    mutationFn: () => clearFn({ data: { tenantId: tenant.tenant_id } }),
    onSuccess: () => {
      toast.success("Preço individual removido");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["admin", "sms-credits"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Preço
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Preço individual do tenant</DialogTitle>
          <DialogDescription>
            Campos vazios voltam a usar o preço global. Use ponto como separador decimal.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Preço de venda/SMS</Label>
            <Input
              type="number"
              min="0"
              step="0.0001"
              value={sale}
              onChange={(e) => setSale(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Custo fornecedor/SMS</Label>
            <Input
              type="number"
              min="0"
              step="0.0001"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          {tenant.has_custom_pricing && (
            <Button variant="outline" disabled={clear.isPending} onClick={() => clear.mutate()}>
              Remover individual
            </Button>
          )}
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            Salvar preço
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SmsCreditOrdersCard({ orders }: { orders: SmsCreditOrderRow[] }) {
  const qc = useQueryClient();
  const fn = useServerFn(adminMarkSmsCreditOrderPaid);
  const mut = useMutation({
    mutationFn: (orderId: string) => fn({ data: { orderId, provider: "manual" } }),
    onSuccess: () => {
      toast.success("Pedido marcado como pago");
      qc.invalidateQueries({ queryKey: ["admin", "sms-credits"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Receipt className="h-5 w-5 text-primary" />
          Pedidos de créditos
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
              <TableHead className="text-right">Ações</TableHead>
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
                <TableCell className="text-right">
                  {order.status === "pending" && (
                    <Button size="sm" disabled={mut.isPending} onClick={() => mut.mutate(order.id)}>
                      Marcar pago
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {orders.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
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
    { label: "SMS enviados (30d)", value: String(m.sms_total ?? 0) },
    { label: "SMS entregues", value: String(m.sms_delivered ?? 0) },
    { label: "Ligações (30d)", value: String(m.call_total ?? 0) },
    { label: "Emails enviados (30d)", value: String(m.email_total ?? 0) },
    { label: "Emails entregues", value: String(m.email_delivered ?? 0) },
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
function PricingTab() {
  const qc = useQueryClient();
  const fn = useServerFn(getPricing);
  const { data, isLoading } = useQuery({
    queryKey: ["admin", "pricing"],
    queryFn: () => fn(),
  });
  const items = (data?.pricing ?? []) as Array<{
    channel: string;
    price_per_unit: number;
    unit_label: string;
  }>;

  return (
    <div className="space-y-3 max-w-2xl">
      <p className="text-sm text-muted-foreground">
        Defina o preço por unidade que será usado para calcular o custo estimado de cada usuário.
      </p>
      {isLoading && <Card className="h-32 animate-pulse" />}
      {items.map((it) => (
        <PricingRow
          key={it.channel}
          channel={it.channel as "sms" | "call" | "email"}
          unitLabel={it.unit_label}
          initial={Number(it.price_per_unit)}
          onSaved={() => qc.invalidateQueries({ queryKey: ["admin"] })}
        />
      ))}
    </div>
  );
}

function PricingRow({
  channel,
  unitLabel,
  initial,
  onSaved,
}: {
  channel: "sms" | "call" | "email";
  unitLabel: string;
  initial: number;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(initial.toString());
  const fn = useServerFn(setPricing);
  const mut = useMutation({
    mutationFn: () => fn({ data: { channel, price_per_unit: Number(value) } }),
    onSuccess: () => {
      toast.success("Preço atualizado");
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const labels: Record<string, string> = { sms: "SMS", call: "Ligação", email: "Email" };
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className="flex-1">
          <div className="font-medium">{labels[channel]}</div>
          <div className="text-xs text-muted-foreground">R$ por {unitLabel}</div>
        </div>
        <Input
          type="number"
          step="0.0001"
          min="0"
          className="w-32"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button onClick={() => mut.mutate()} disabled={mut.isPending || value === ""}>
          {mut.isPending ? "Salvando…" : "Salvar"}
        </Button>
      </CardContent>
    </Card>
  );
}
