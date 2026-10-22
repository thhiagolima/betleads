import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, Building2, LockKeyhole } from "lucide-react";
import type { ReactNode } from "react";

import { BillingLock } from "@/components/billing/billing-lock";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { billingView } from "@/lib/billing/billing-view";
import { getCurrentTenantAccessStatus, type TenantAccessBilling } from "@/lib/tenants.functions";

const TENANT_VALIDATION_TIMEOUT_MS = 12_000;

/** The payment page stays usable even for a locked house (global constraint). */
export const PLANO_E_CREDITOS_PATH = "/plano-e-creditos";

/** Matches `/plano-e-creditos` and any of its sub-routes (Task 7), not other paths. */
export function isPlanoECreditosPath(pathname: string): boolean {
  return pathname === PLANO_E_CREDITOS_PATH || pathname.startsWith(`${PLANO_E_CREDITOS_PATH}/`);
}

type TenantAccessStatus = {
  blocked: boolean;
  tenant: { status: string } | null;
  billing: TenantAccessBilling | null;
};

async function validateTenantWithTimeout<T>(request: Promise<T>): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("A validação da conta demorou mais que o esperado.")),
          TENANT_VALIDATION_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Shared status query for the billing banner and the suspended/canceled and
 * billing-lock gates — same query key and a 60s `refetchInterval` so the
 * banner keeps itself current while the user stays on a page (Task 6, ruling
 * 6). The Pix modal (Task 7) invalidates this key on a successful payment.
 */
export function useTenantAccessStatus() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isTenantPage = pathname.startsWith("/tenants");
  const fetchStatus = useServerFn(getCurrentTenantAccessStatus);
  const query = useQuery({
    queryKey: ["current-tenant-access-status"],
    queryFn: () => validateTenantWithTimeout(fetchStatus() as Promise<TenantAccessStatus>),
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: false,
    enabled: !isTenantPage,
  });
  return { ...query, pathname, isTenantPage };
}

export function TenantStatusGate({ children }: { children: ReactNode }) {
  const { data, isLoading, isError, refetch, isFetching, pathname, isTenantPage } =
    useTenantAccessStatus();

  if (isTenantPage) return <>{children}</>;

  if (isLoading) {
    return (
      <Card className="mx-auto mt-16 max-w-xl border-border/60 bg-card/70">
        <CardContent className="flex items-center gap-3 p-5 text-sm text-muted-foreground">
          <div className="h-9 w-9 animate-pulse rounded-lg bg-primary/10" />
          <div>
            <p className="font-medium text-foreground">Validando sua conta</p>
            <p>Conferindo status da conta antes de abrir a operacao.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <BlockedTenantCard
        title="Não foi possível validar sua conta"
        description="A conexão com os dados da sua conta não respondeu. Aguarde alguns segundos e tente novamente."
        icon={<AlertTriangle className="h-5 w-5 text-amber-300" />}
        action={
          <Button variant="outline" disabled={isFetching} onClick={() => void refetch()}>
            Tentar novamente
          </Button>
        }
      />
    );
  }

  if (data?.blocked) {
    const statusLabel = data.tenant?.status === "canceled" ? "cancelado" : "suspenso";
    return (
      <BlockedTenantCard
        title={`Conta ${statusLabel}`}
        description="Sua conta está bloqueada. As áreas operacionais voltam a ficar disponíveis após a regularização."
        icon={<LockKeyhole className="h-5 w-5 text-rose-300" />}
        action={
          <Button asChild>
            <Link to="/tenants">Abrir minha conta</Link>
          </Button>
        }
      />
    );
  }

  // Binding constraint: /plano-e-creditos stays usable even for a locked
  // house, and billingView never produces a `lock` for the superadmin.
  if (data?.billing && !isPlanoECreditosPath(pathname)) {
    const view = billingView(data.billing);
    if (view.lock) return <BillingLock view={view.lock} />;
  }

  return <>{children}</>;
}

function BlockedTenantCard({
  title,
  description,
  icon,
  action,
}: {
  title: string;
  description: string;
  icon: ReactNode;
  action: ReactNode;
}) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Card role="alert" className="w-full max-w-xl border-border/70 bg-card/80 shadow-xl shadow-black/20">
        <CardContent className="space-y-5 p-6">
          <div className="flex items-start gap-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-muted">
              {icon}
            </div>
            <div className="min-w-0 space-y-1">
              <p className="text-lg font-semibold text-foreground">{title}</p>
              <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Building2 className="h-4 w-4" />
              Gestão da conta e auditoria continuam disponíveis.
            </div>
            {action}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
