import { createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { useActiveTenant } from "@/hooks/use-active-tenant";
import { Building2, Plus, Save, Search, Settings2, Trash2, UserPlus, Wallet } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { IconButton } from "@/components/ui/icon-button";
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
import { adminAdjustSmsCredits } from "@/lib/sms-credits.functions";
import { adminClearTenantPrice, adminSetTenantPrice } from "@/lib/billing/billing.functions";
import {
  BillingTenantCobrancaCard,
  billingHistoryQueryKey,
} from "@/components/billing/admin/billing-tenant-list";
import { BillingHistoryCard } from "@/components/billing/admin/billing-history";
import {
  type BillingItem,
  CurrentPricesCard,
  MonthUsageCard,
  type WalletMonthUsageRow,
  type WalletPriceRow,
} from "@/components/billing/wallet-usage-panels";
import {
  billingItemLabel,
  brl,
  brlUnitPrice,
  ledgerAmountTone,
  num,
  walletEntryTypeLabel,
} from "@/lib/format";
import { requestConfirmation } from "@/components/system-dialog-host";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { MetricCard } from "@/components/ui-premium/metric-card";
import { DataCard } from "@/components/ui-premium/data-card";
import { EmptyState } from "@/components/ui-premium/empty-state";
import { PageTabs } from "@/components/ui-premium/page-tabs";
import { DemoDisabledTooltip } from "@/components/demo-disabled-tooltip";
import { useIsDemoTenant } from "@/hooks/use-is-demo-tenant";

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
  is_demo?: boolean | null;
};

type TenantUser = {
  id: string;
  user_id: string;
  role: "admin" | "gestor" | "member";
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
      balance?: number;
      lifetime_purchased?: number;
      lifetime_used?: number;
      exempt?: boolean;
      month_usage?: WalletMonthUsageRow[];
      prices?: Partial<Record<BillingItem, WalletPriceRow>>;
    };
    pricing: {
      item: "sms";
      unit_price?: number;
      /** Only present for the super admin (stripped on the server otherwise). */
      provider_unit_cost?: number | null;
      free_monthly_units?: number;
      exempt?: boolean;
      has_tenant_override?: boolean;
    };
    ledger: Array<{
      id: string;
      entry_type: string;
      item: string | null;
      units: number | null;
      unit_price: number | null;
      amount: number;
      balance_after: number;
      reference_type: string | null;
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
  canManage?: boolean;
  tenants: TenantRow[];
  selectedTenantId: string | null;
  detail: TenantDetail | null;
};

const ROLE_LABEL: Record<TenantUser["role"], string> = {
  admin: "admin",
  gestor: "gestor",
  member: "membro",
};

function fmtDate(value: string | null | undefined) {
  if (!value) return "-";
  return new Date(value).toLocaleString("pt-BR");
}

function cents(value: number | null | undefined) {
  return brl((value ?? 0) / 100);
}

const STATUS_LABEL: Record<TenantRow["status"], string> = {
  active: "Ativa",
  trial: "Teste",
  suspended: "Suspensa",
  canceled: "Cancelada",
};

const PLANO_LABEL: Record<TenantRow["plano"], string> = {
  starter: "Starter",
  pro: "Pro",
  enterprise: "Enterprise",
  interno: "Interno",
};

const ORDER_STATUS_LABEL: Record<string, string> = {
  paid: "Pago",
  pending: "Pendente",
  open: "Em aberto",
  processing: "Processando",
  canceled: "Cancelado",
  cancelled: "Cancelado",
  failed: "Falhou",
  expired: "Expirado",
  refunded: "Reembolsado",
};

const AUDIT_ACTION_LABEL: Record<string, string> = {
  "tenant.created": "Casa criada",
  "tenant.updated": "Dados da casa alterados",
  "tenant.renamed": "Casa renomeada",
  "tenant_user.added": "Pessoa adicionada à equipe",
  "tenant_user.removed": "Pessoa removida da equipe",
  "tenant_user.role_changed": "Papel alterado",
  "user_membership.removed": "Acesso removido",
  "user.created": "Login criado",
  "user.deleted": "Login excluído",
  "tenant_wallet.adjusted": "Saldo ajustado",
  "tenant_price.set": "Preço individual definido",
  "tenant_price.cleared": "Preço individual removido",
  "tenant_sms.pricing_set": "Preço de SMS definido",
  "billing.extend_due": "Vencimento prorrogado",
  "billing.set_block": "Bloqueio de cobrança alterado",
  "billing.manual_settle": "Fatura quitada manualmente",
  "billing.set_frozen": "Cobrança congelada ou retomada",
  "billing.set_cycle_day": "Dia de cobrança alterado",
  "billing.set_custom_price": "Mensalidade personalizada",
  "billing.set_continuous_discount": "Desconto contínuo alterado",
  "billing.resend_email": "E-mail de cobrança reenviado",
  "billing.low_balance_threshold.update": "Aviso de saldo baixo alterado",
  "billing.free_days": "Dias grátis concedidos",
  "billing.cancel_invoice": "Fatura cancelada",
  "sms_campaign.resumed": "Campanha de SMS retomada",
  "sms_campaign.cancelled": "Campanha de SMS cancelada",
  "webhook.credentials_rotated": "Credenciais da integração trocadas",
  "webhook.hmac_secret_provisioned": "Chave de segurança da integração criada",
  "webhook.hmac_enforcement_changed": "Verificação de segurança da integração alterada",
  "channel.stuck_reprocessed": "Envios travados reprocessados",
  "journeys.provider_outage_requeued": "Envios reenfileirados após falha do provedor",
};

const ENTITY_TYPE_LABEL: Record<string, string> = {
  tenant: "Casa",
  tenant_wallet: "Saldo",
  tenant_billing: "Cobrança",
  tenant_sms_pricing: "Preço de SMS",
  tenant_price_override: "Preço individual",
  tenant_user: "Equipe",
  user_role: "Papel",
  sms_campaign: "Campanha de SMS",
  channel_operation: "Envios",
};

/** Turns an internal code (snake_case / dotted) into readable text. */
function humanize(value: string) {
  const text = value.replace(/[._]+/g, " ").trim().toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function labelFrom(map: Record<string, string>, value: string | null | undefined) {
  if (!value) return "-";
  return map[value] ?? humanize(value);
}

function statusBadge(status: TenantRow["status"]) {
  const label = labelFrom(STATUS_LABEL, status).toLowerCase();
  if (status === "active") return <Badge className="bg-success/15 text-success">{label}</Badge>;
  if (status === "trial") return <Badge className="bg-info/15 text-info">{label}</Badge>;
  if (status === "suspended") return <Badge className="bg-warning/15 text-warning">{label}</Badge>;
  return <Badge variant="destructive">{label}</Badge>;
}

const WORKSPACE_TABS = [
  { value: "overview", label: "Visão geral", hash: "visao-geral" },
  { value: "users", label: "Equipe", hash: "equipe" },
  { value: "credits", label: "Saldo SMS", hash: "saldo" },
  { value: "billing", label: "Cobrança", hash: "cobranca" },
  { value: "reports", label: "Relatórios", hash: "relatorios" },
  { value: "audit", label: "Histórico", hash: "historico" },
  { value: "settings", label: "Configuração", hash: "configuracao" },
] as const;

type WorkspaceTab = (typeof WORKSPACE_TABS)[number]["value"];

function tabFromHash(hash: string): WorkspaceTab {
  const clean = hash.replace(/^#/, "");
  return WORKSPACE_TABS.find((item) => item.hash === clean)?.value ?? "overview";
}

function TenantsPage() {
  const qc = useQueryClient();
  const consoleFn = useServerFn(getTenantManagementConsole);
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  // House admins have no picker here: the page follows the house chosen in the header.
  const { active: headerTenant } = useActiveTenant();
  const requestedTenantId = selectedTenantId ?? headerTenant?.id ?? null;

  const { data, isLoading } = useQuery({
    queryKey: ["tenants-console", requestedTenantId],
    queryFn: () => consoleFn({ data: { tenantId: requestedTenantId } }),
  });

  const consoleData = data as ConsoleData | undefined;
  const isSuperAdmin = !!consoleData?.isSuperAdmin;
  const tenants = useMemo(() => consoleData?.tenants ?? [], [consoleData?.tenants]);
  const detail = consoleData?.detail ?? null;
  const activeTenantId = consoleData?.selectedTenantId ?? requestedTenantId;

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

  const workspace = detail ? (
    <TenantWorkspace
      detail={detail}
      isSuperAdmin={isSuperAdmin}
      canManage={!!consoleData?.canManage}
    />
  ) : (
    <DataCard>
      {isLoading ? (
        <div className="flex min-h-64 items-center justify-center text-body text-muted-foreground">
          Carregando...
        </div>
      ) : (
        <EmptyState
          icon={<Building2 />}
          title={isSuperAdmin ? "Nenhuma casa selecionada" : "Nenhuma casa encontrada"}
          description={
            isSuperAdmin
              ? "Escolha uma casa na lista ou crie uma nova para começar."
              : "Sua conta ainda não está ligada a nenhuma casa."
          }
        />
      )}
    </DataCard>
  );

  return (
    <Page>
      <PageHeader
        subtitle={
          isSuperAdmin
            ? "Todas as casas da plataforma: dados, equipe, saldo, cobrança e histórico."
            : "Dados da sua casa, quem faz parte da equipe, saldo e histórico de alterações."
        }
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => qc.invalidateQueries({ queryKey: ["tenants-console"] })}
            >
              Atualizar
            </Button>
            {isSuperAdmin && <CreateTenantDialog />}
          </>
        }
      />

      {isSuperAdmin ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,330px)_minmax(0,1fr)]">
          <DataCard title="Casas" className="h-fit" bodyClassName="space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-9"
                placeholder="Buscar casa"
                aria-label="Buscar casa"
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
                    aria-pressed={active}
                    className={`w-full rounded-lg border p-3 text-left transition ${
                      active
                        ? "border-primary/60 bg-primary/10"
                        : "border-border/70 bg-card hover:border-primary/30"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 truncate text-body font-semibold">{tenant.nome}</div>
                      <div className="flex shrink-0 items-center gap-1">
                        {tenant.is_demo && (
                          <Badge className="bg-violet-500/15 text-violet-300">demonstração</Badge>
                        )}
                        {statusBadge(tenant.status)}
                      </div>
                    </div>
                    <div className="mt-2 flex items-center justify-between text-meta text-muted-foreground">
                      <span>Plano {labelFrom(PLANO_LABEL, tenant.plano)}</span>
                      <span>{tenant.crm_model === "CRM_EXPERT" ? "Expert" : "Plataforma"}</span>
                    </div>
                  </button>
                );
              })}
              {!isLoading && !filteredTenants.length && (
                <div className="rounded-lg border border-dashed p-6 text-center text-body text-muted-foreground">
                  Nenhuma casa encontrada.
                </div>
              )}
            </div>
          </DataCard>

          {workspace}
        </div>
      ) : (
        workspace
      )}
    </Page>
  );
}

function TenantWorkspace({
  detail,
  isSuperAdmin,
  canManage,
}: {
  detail: TenantDetail;
  isSuperAdmin: boolean;
  canManage: boolean;
}) {
  const navigate = useNavigate();
  // Active tab lives in the URL hash (#equipe, #saldo…), pushed to the history
  // so Voltar returns to the previous tab.
  const hash = useLocation({ select: (location) => location.hash });
  const tab = tabFromHash(hash);
  const setTab = (next: WorkspaceTab) => {
    void navigate({
      to: "/tenants",
      hash: WORKSPACE_TABS.find((item) => item.value === next)?.hash ?? "visao-geral",
    });
  };

  const balance = Number(detail.sms.summary.balance ?? 0);
  const used = Number(detail.sms.summary.lifetime_used ?? 0);
  const purchased = Number(detail.sms.summary.lifetime_purchased ?? 0);

  // Summary numbers live only in this row; the tabs below don't repeat them.
  return (
    <div className="min-w-0 space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Equipe"
          value={num(detail.users.length)}
          hint={detail.users.length === 1 ? "pessoa com acesso" : "pessoas com acesso"}
        />
        <MetricCard
          label="Saldo"
          value={brl(balance)}
          hint={`${detail.sms.summary.exempt ? "Isenta · " : ""}${brl(used)} consumidos até hoje`}
        />
        <MetricCard
          label="Jogadores"
          value={num(detail.reports.players_total)}
          hint="na base da casa"
        />
        <MetricCard label="Comprado" value={brl(purchased)} hint="total desde o início" />
      </div>

      <PageTabs value={tab} onValueChange={setTab} items={WORKSPACE_TABS} label="Seções da conta" />

      <div role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === "overview" && <OverviewTab detail={detail} isSuperAdmin={isSuperAdmin} />}
        {tab === "users" && (
          <UsersTab detail={detail} isSuperAdmin={isSuperAdmin} canManage={canManage} />
        )}
        {tab === "credits" && <CreditsTab detail={detail} isSuperAdmin={isSuperAdmin} />}
        {tab === "billing" && <BillingTab detail={detail} isSuperAdmin={isSuperAdmin} />}
        {tab === "reports" && <ReportsTab detail={detail} />}
        {tab === "audit" && <AuditTab detail={detail} />}
        {tab === "settings" && <SettingsTab detail={detail} isSuperAdmin={isSuperAdmin} />}
      </div>
    </div>
  );
}

function OverviewTab({ detail, isSuperAdmin }: { detail: TenantDetail; isSuperAdmin: boolean }) {
  const tenant = detail.tenant;
  const pricing = detail.sms.pricing;
  const margin = Number(pricing.unit_price ?? 0) - Number(pricing.provider_unit_cost ?? 0);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]">
      <DataCard title="Dados da casa" bodyClassName="grid gap-4 sm:grid-cols-2">
        <Info label="Nome" value={tenant.nome} />
        <Info label="Status" value={statusBadge(tenant.status)} />
        <Info label="Plano" value={labelFrom(PLANO_LABEL, tenant.plano)} />
        <Info
          label="Modelo CRM"
          value={tenant.crm_model === "CRM_EXPERT" ? "CRM Expert" : "CRM Plataforma"}
        />
        <Info label="Criada em" value={fmtDate(tenant.created_at)} />
      </DataCard>

      <DataCard title="Saúde operacional" bodyClassName="space-y-3">
        <HealthLine label="Saldo disponível" ok={Number(detail.sms.summary.balance ?? 0) > 0} />
        <HealthLine
          label="Administrador na equipe"
          ok={detail.users.some((user) => user.role === "admin")}
        />
        <HealthLine label="Meta conectada" ok={detail.reports.meta_accounts > 0} />
        <HealthLine label="Eventos da casa chegando" ok={detail.reports.webhooks_30d > 0} />
        {isSuperAdmin && (
          <div className="rounded-lg border border-border/70 p-3 text-body">
            <div className="text-muted-foreground">Margem estimada por SMS</div>
            <div
              className={margin >= 0 ? "font-semibold text-success" : "font-semibold text-danger"}
            >
              {brlUnitPrice(margin)}
            </div>
          </div>
        )}
        {!isSuperAdmin && (
          <p className="text-meta text-muted-foreground">
            Mudanças de status, plano e valores da casa são feitas pela equipe da plataforma.
          </p>
        )}
      </DataCard>
    </div>
  );
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border/70 p-3">
      <div className="text-label text-muted-foreground">{label}</div>
      <div className="mt-1 break-words text-body font-medium">{value}</div>
    </div>
  );
}

function HealthLine({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-border/70 px-3 py-2 text-body">
      <span>{label}</span>
      <Badge className={ok ? "bg-success/15 text-success" : "bg-warning/15 text-warning"}>
        {ok ? "ok" : "atenção"}
      </Badge>
    </div>
  );
}

function UsersTab({
  detail,
  isSuperAdmin,
  canManage,
}: {
  detail: TenantDetail;
  isSuperAdmin: boolean;
  canManage: boolean;
}) {
  return (
    <DataCard
      title="Equipe"
      description="Quem tem acesso a esta casa e o que cada pessoa pode fazer."
      actions={
        canManage ? (
          <AddUserDialog tenantId={detail.tenant.id} isSuperAdmin={isSuperAdmin} />
        ) : undefined
      }
      bodyClassName="overflow-x-auto p-0 sm:p-0 pt-3 sm:pt-3"
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Pessoa</TableHead>
            <TableHead>Papel</TableHead>
            <TableHead>Último acesso</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Ações</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {detail.users.map((user) => (
            <TableRow key={user.id}>
              <TableCell className="font-medium">{user.email ?? "Sem e-mail cadastrado"}</TableCell>
              <TableCell>
                <RoleSelect
                  tenantId={detail.tenant.id}
                  user={user}
                  isSuperAdmin={isSuperAdmin}
                  canManage={canManage}
                />
              </TableCell>
              <TableCell className="whitespace-nowrap">{fmtDate(user.last_sign_in_at)}</TableCell>
              <TableCell>
                {user.banned_until && new Date(user.banned_until) > new Date() ? (
                  <Badge variant="destructive">bloqueado</Badge>
                ) : (
                  <Badge className="bg-success/15 text-success">ativo</Badge>
                )}
              </TableCell>
              <TableCell className="text-right">
                {canManage && <RemoveUserButton tenantId={detail.tenant.id} user={user} />}
              </TableCell>
            </TableRow>
          ))}
          {!detail.users.length && (
            <TableRow>
              <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                Ninguém na equipe ainda.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </DataCard>
  );
}

function AddUserDialog({ tenantId, isSuperAdmin }: { tenantId: string; isSuperAdmin: boolean }) {
  const isDemo = useIsDemoTenant(tenantId);
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
      toast.success("Pessoa adicionada à equipe");
      setOpen(false);
      setEmail("");
      setPassword("");
      qc.invalidateQueries({ queryKey: ["tenants-console"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DemoDisabledTooltip active={isDemo}>
        <DialogTrigger asChild>
          <Button className="gap-2" disabled={isDemo}>
            <UserPlus className="h-4 w-4" />
            Adicionar pessoa
          </Button>
        </DialogTrigger>
      </DemoDisabledTooltip>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Adicionar pessoa à equipe</DialogTitle>
          <DialogDescription>
            Se o e-mail ainda não tiver login, ele será criado. Sem senha, a pessoa recebe um
            convite por e-mail.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label>E-mail</Label>
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
                {isSuperAdmin && <SelectItem value="admin">Admin</SelectItem>}
                <SelectItem value="gestor">Gestor</SelectItem>
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

function RoleSelect({
  tenantId,
  user,
  isSuperAdmin,
  canManage,
}: {
  tenantId: string;
  user: TenantUser;
  isSuperAdmin: boolean;
  canManage: boolean;
}) {
  const isDemo = useIsDemoTenant(tenantId);
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
    <Select
      value={user.role}
      disabled={isDemo || !canManage || (!isSuperAdmin && user.role === "admin")}
      onValueChange={(value) => mut.mutate(value as TenantUser["role"])}
    >
      <DemoDisabledTooltip active={isDemo}>
        <SelectTrigger className="w-44">
          <SelectValue />
        </SelectTrigger>
      </DemoDisabledTooltip>
      <SelectContent>
        <SelectItem value="member">Membro</SelectItem>
        {isSuperAdmin && <SelectItem value="admin">Admin</SelectItem>}
        <SelectItem value="gestor">Gestor</SelectItem>
      </SelectContent>
    </Select>
  );
}

function RemoveUserButton({ tenantId, user }: { tenantId: string; user: TenantUser }) {
  const isDemo = useIsDemoTenant(tenantId);
  const qc = useQueryClient();
  const fn = useServerFn(removeUserFromTenant);
  const mut = useMutation({
    mutationFn: () => fn({ data: { tenantId, membershipId: user.id } }),
    onSuccess: () => {
      toast.success("Pessoa removida da equipe");
      qc.invalidateQueries({ queryKey: ["tenants-console"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const label = user.email ?? "esta pessoa";
  return (
    <DemoDisabledTooltip active={isDemo}>
      <IconButton
        label={`Remover ${label} da equipe`}
        disabled={isDemo || mut.isPending}
        icon={<Trash2 className="h-4 w-4 text-danger" />}
        onClick={async () => {
          const confirmed = await requestConfirmation({
            title: "Remover pessoa da equipe?",
            description: `${label} perde o acesso a esta casa imediatamente. O login continua existindo e a pessoa pode ser convidada de novo depois.`,
            confirmLabel: "Remover",
            destructive: true,
          });
          if (confirmed) mut.mutate();
        }}
      />
    </DemoDisabledTooltip>
  );
}

// ─── Aba Cobrança (Task 9) ───────────────────────────────────────────────────
// Super admin only: the billing admin read functions (`adminBillingTenantList`,
// `adminTenantBillingHistory`) themselves refuse a non-super-admin caller, so a
// regular tenant admin would only see load errors here — the tab shows a short
// explanatory message instead (same pattern as the Saldo tab's restricted dialogs).
function BillingTab({ detail, isSuperAdmin }: { detail: TenantDetail; isSuperAdmin: boolean }) {
  if (!isSuperAdmin) {
    return (
      <DataCard>
        <p className="py-4 text-center text-body text-muted-foreground">
          A cobrança desta casa é gerenciada pela equipe da plataforma.
        </p>
      </DataCard>
    );
  }
  return (
    <div className="space-y-4">
      <BillingTenantCobrancaCard tenantId={detail.tenant.id} />
      <BillingHistoryCard
        tenantId={detail.tenant.id}
        queryKey={billingHistoryQueryKey(detail.tenant.id)}
      />
    </div>
  );
}

function CreditsTab({ detail, isSuperAdmin }: { detail: TenantDetail; isSuperAdmin: boolean }) {
  const pricing = detail.sms.pricing;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <MetricCard
          label="Preço por SMS"
          value={brlUnitPrice(Number(pricing.unit_price ?? 0))}
          hint={
            isSuperAdmin
              ? `custo do fornecedor ${brlUnitPrice(Number(pricing.provider_unit_cost ?? 0))}`
              : undefined
          }
        />
        <DataCard bodyClassName="flex h-full flex-wrap items-center gap-2">
          {isSuperAdmin ? (
            <>
              <AdjustCreditsDialog tenant={detail.tenant} />
              <PricingDialog tenant={detail.tenant} pricing={pricing} />
            </>
          ) : (
            <p className="text-body text-muted-foreground">
              Ajustes de saldo e preço individual são feitos pela equipe da plataforma.
            </p>
          )}
        </DataCard>
      </div>

      <MonthUsageCard
        monthUsage={detail.sms.summary.month_usage ?? []}
        prices={detail.sms.summary.prices ?? {}}
      />

      <CurrentPricesCard prices={detail.sms.summary.prices ?? {}} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <DataCard title="Extrato" bodyClassName="overflow-x-auto p-0 pt-3 sm:p-0 sm:pt-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Quando</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Canal</TableHead>
                <TableHead className="text-right">Valor</TableHead>
                <TableHead className="text-right">Saldo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.sms.ledger.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="whitespace-nowrap">{fmtDate(entry.created_at)}</TableCell>
                  <TableCell>
                    <div className="font-medium">{walletEntryTypeLabel(entry.entry_type)}</div>
                    <div className="max-w-56 truncate text-meta text-muted-foreground">
                      {entry.reason ?? "-"}
                    </div>
                  </TableCell>
                  <TableCell>{billingItemLabel(entry.item)}</TableCell>
                  <TableCell
                    className={`text-right font-semibold ${ledgerAmountTone(Number(entry.amount))}`}
                  >
                    {Number(entry.amount) > 0 ? "+" : ""}
                    {brl(Number(entry.amount))}
                  </TableCell>
                  <TableCell className="text-right">{brl(Number(entry.balance_after))}</TableCell>
                </TableRow>
              ))}
              {!detail.sms.ledger.length && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    Nenhuma movimentação ainda.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </DataCard>

        <DataCard title="Pedidos de compra" bodyClassName="overflow-x-auto p-0 pt-3 sm:p-0 sm:pt-3">
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
                    <div className="font-mono text-meta">{order.id.slice(0, 8)}</div>
                    <div className="whitespace-nowrap text-meta text-muted-foreground">
                      {fmtDate(order.created_at)}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={order.status === "paid" ? "default" : "secondary"}>
                      {labelFrom(ORDER_STATUS_LABEL, order.status)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">{num(Number(order.credits))}</TableCell>
                  <TableCell className="text-right">{cents(Number(order.amount_cents))}</TableCell>
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
        </DataCard>
      </div>
    </div>
  );
}

function AdjustCreditsDialog({ tenant }: { tenant: TenantRow }) {
  const qc = useQueryClient();
  const fn = useServerFn(adminAdjustSmsCredits);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("50");
  const [reason, setReason] = useState("Ajuste manual pela área de contas");
  const mut = useMutation({
    mutationFn: () => fn({ data: { tenantId: tenant.id, amount: Number(amount), reason } }),
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
          <DialogTitle>Ajustar saldo</DialogTitle>
          <DialogDescription>
            Valor em R$. Positivo adiciona saldo; negativo remove, com registro no extrato.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label>Casa</Label>
            <Input value={tenant.nome} readOnly />
          </div>
          <div className="space-y-2">
            <Label>Valor (R$)</Label>
            <Input
              type="number"
              step="0.01"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
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
          <Button disabled={mut.isPending || !Number(amount)} onClick={() => mut.mutate()}>
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
  const setFn = useServerFn(adminSetTenantPrice);
  const clearFn = useServerFn(adminClearTenantPrice);
  const [open, setOpen] = useState(false);
  const [unitPrice, setUnitPrice] = useState(String(pricing.unit_price ?? ""));

  const save = useMutation({
    mutationFn: () =>
      setFn({
        data: {
          tenantId: tenant.id,
          item: "sms",
          unitPrice: Number(unitPrice),
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
    mutationFn: () => clearFn({ data: { tenantId: tenant.id, item: "sms" } }),
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
            Vale só para esta casa. Use &quot;Voltar ao padrão&quot; para remover a exceção.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>Preço unitário (R$)</Label>
          <Input
            type="number"
            min="0"
            step="0.0001"
            value={unitPrice}
            onChange={(event) => setUnitPrice(event.target.value)}
          />
        </div>
        <DialogFooter>
          {pricing.has_tenant_override && (
            <Button variant="outline" disabled={clear.isPending} onClick={() => clear.mutate()}>
              Voltar ao padrão
            </Button>
          )}
          <Button
            disabled={save.isPending || unitPrice.trim() === ""}
            onClick={() => save.mutate()}
          >
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReportsTab({ detail }: { detail: TenantDetail }) {
  const items = [
    { label: "SMS enviados em 30 dias", value: detail.reports.sms_30d },
    { label: "E-mails enviados em 30 dias", value: detail.reports.email_30d },
    { label: "Ligações em 30 dias", value: detail.reports.calls_30d },
    { label: "Eventos recebidos em 30 dias", value: detail.reports.webhooks_30d },
    { label: "Contas Meta conectadas", value: detail.reports.meta_accounts },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {items.map((item) => (
        <MetricCard key={item.label} label={item.label} value={num(item.value)} />
      ))}
    </div>
  );
}

function AuditTab({ detail }: { detail: TenantDetail }) {
  const emailByUserId = new Map(
    detail.users.filter((user) => user.email).map((user) => [user.user_id, user.email]),
  );
  return (
    <DataCard
      title="Histórico de alterações"
      bodyClassName="overflow-x-auto p-0 pt-3 sm:p-0 sm:pt-3"
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Quando</TableHead>
            <TableHead>Ação</TableHead>
            <TableHead>O que mudou</TableHead>
            <TableHead>Quem</TableHead>
            <TableHead>Detalhes</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {detail.audit.map((entry) => (
            <TableRow key={entry.id}>
              <TableCell className="whitespace-nowrap">{fmtDate(entry.created_at)}</TableCell>
              <TableCell>
                <Badge variant="secondary">{labelFrom(AUDIT_ACTION_LABEL, entry.action)}</Badge>
              </TableCell>
              <TableCell>{labelFrom(ENTITY_TYPE_LABEL, entry.entity_type)}</TableCell>
              <TableCell className="text-meta">
                {entry.actor_user_id
                  ? (emailByUserId.get(entry.actor_user_id) ?? "Equipe da plataforma")
                  : "Sistema"}
              </TableCell>
              <TableCell>
                <details className="max-w-xl">
                  <summary className="cursor-pointer text-primary">ver detalhes</summary>
                  <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-muted/30 p-3 text-meta">
                    {JSON.stringify(
                      {
                        antes: entry.before_data,
                        depois: entry.after_data,
                        contexto: entry.metadata,
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
    </DataCard>
  );
}

function SettingsTab({ detail, isSuperAdmin }: { detail: TenantDetail; isSuperAdmin: boolean }) {
  const isDemo = useIsDemoTenant(detail.tenant.id);
  const qc = useQueryClient();
  const fn = useServerFn(updateTenantSettings);
  const tenant = detail.tenant;
  const [form, setForm] = useState({
    nome: tenant.nome,
    status: tenant.status,
    plano: tenant.plano,
    crm_model: tenant.crm_model ?? "CRM_PLATAFORMA",
  });
  const [planReason, setPlanReason] = useState("");

  useEffect(() => {
    setForm({
      nome: tenant.nome,
      status: tenant.status,
      plano: tenant.plano,
      crm_model: tenant.crm_model ?? "CRM_PLATAFORMA",
    });
    setPlanReason("");
  }, [tenant.id, tenant.nome, tenant.status, tenant.plano, tenant.crm_model]);

  // Required (>= 5 chars) only when the plano select moves into or out of
  // 'interno' — same rule `updateTenantSettingsFor` enforces server-side.
  const planTouchesInterno =
    form.plano !== tenant.plano && (tenant.plano === "interno" || form.plano === "interno");

  const mut = useMutation({
    mutationFn: () =>
      fn({ data: { tenantId: tenant.id, ...form, planReason: planReason.trim() || undefined } }),
    onSuccess: () => {
      toast.success("Casa atualizada");
      qc.invalidateQueries({ queryKey: ["tenants-console"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <DataCard title="Configuração da casa" bodyClassName="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label>Nome</Label>
          <Input
            value={form.nome}
            onChange={(event) => setForm((prev) => ({ ...prev, nome: event.target.value }))}
          />
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
              <SelectItem value="active">Ativa</SelectItem>
              <SelectItem value="trial">Teste</SelectItem>
              <SelectItem value="suspended">Suspensa</SelectItem>
              <SelectItem value="canceled">Cancelada</SelectItem>
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
              setForm((prev) => ({
                ...prev,
                crm_model: value as NonNullable<TenantRow["crm_model"]>,
              }))
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
      {planTouchesInterno && (
        <div className="space-y-2">
          <Label>Motivo da troca de plano</Label>
          <Input
            value={planReason}
            onChange={(event) => setPlanReason(event.target.value)}
            placeholder="Por que esta casa está entrando/saindo do plano interno?"
          />
        </div>
      )}
      <DemoDisabledTooltip active={isDemo}>
        <Button
          className="gap-2"
          disabled={
            isDemo ||
            mut.isPending ||
            !form.nome.trim() ||
            (planTouchesInterno && planReason.trim().length < 5)
          }
          onClick={() => mut.mutate()}
        >
          <Save className="h-4 w-4" />
          Salvar configuração
        </Button>
      </DemoDisabledTooltip>
    </DataCard>
  );
}

function CreateTenantDialog() {
  const qc = useQueryClient();
  const fn = useServerFn(adminCreateTenant);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    nome: "",
    slug: "",
    adminEmail: "",
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
          adminEmail: form.adminEmail,
          status: form.status,
          plano: form.plano,
          crm_model: form.crm_model,
        },
      }),
    onSuccess: () => {
      toast.success("Casa criada");
      setOpen(false);
      setForm({
        nome: "",
        slug: "",
        adminEmail: "",
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
          Nova casa
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nova casa</DialogTitle>
          <DialogDescription>
            Cria uma casa separada das demais. Equipe e saldo podem ser configurados depois.
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
            <Label>Endereço curto (opcional)</Label>
            <Input
              value={form.slug}
              onChange={(event) => setForm((prev) => ({ ...prev, slug: event.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <Label>E-mail do primeiro administrador</Label>
            <Input
              type="email"
              value={form.adminEmail}
              onChange={(event) => setForm((prev) => ({ ...prev, adminEmail: event.target.value }))}
              placeholder="admin@empresa.com"
            />
            <p className="text-meta text-muted-foreground">
              A pessoa precisa já ter login no sistema.
            </p>
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
                  <SelectItem value="trial">Teste</SelectItem>
                  <SelectItem value="active">Ativa</SelectItem>
                  <SelectItem value="suspended">Suspensa</SelectItem>
                  <SelectItem value="canceled">Cancelada</SelectItem>
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
            disabled={mut.isPending || form.nome.trim().length < 2 || !form.adminEmail.trim()}
            onClick={() => mut.mutate()}
          >
            Criar casa
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
