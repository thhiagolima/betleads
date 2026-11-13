import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle } from "lucide-react";

import { formatDateTime } from "@/components/integrations/meta/meta-format";
import { useIsSuperAdmin } from "@/hooks/use-is-super-admin";
import { probeBanners } from "@/lib/sms-route-probe";
import { getSmsRouteProbeStatus } from "@/lib/sms-route-probe.functions";

export const SMS_ROUTE_PROBE_STATUS_KEY = ["sms-route-probe-status"] as const;

/** Barra do super admin com o resultado do SMS de controle (sonda da rota Short Brasil). */
export function SmsRouteProbeBanner() {
  const { isSuperAdmin } = useIsSuperAdmin();
  const fetchStatus = useServerFn(getSmsRouteProbeStatus);
  const { data } = useQuery({
    queryKey: SMS_ROUTE_PROBE_STATUS_KEY,
    queryFn: () => fetchStatus(),
    refetchInterval: 60_000,
    enabled: isSuperAdmin,
  });
  if (!isSuperAdmin || !data) return null;
  const banners = probeBanners(data);
  if (banners.length === 0) return null;

  return (
    <div className="mt-3 space-y-2">
      {banners.includes("no_balance") && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-danger/40 bg-danger/10 p-3 text-body"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          <div className="leading-snug">
            <p className="font-medium text-danger">
              Conta da Short Brasil sem saldo: nenhum SMS está saindo
              {data.noBalanceSince ? ` desde ${formatDateTime(data.noBalanceSince)}` : ""}
            </p>
            <p className="text-meta text-foreground/80">
              O SMS de controle enviado a cada 30 minutos foi recusado por falta de saldo. Isso
              vale para todas as casas que usam a conta padrão. Recarregue a conta na Short Brasil;
              a barra some no próximo teste aceito.{" "}
              <Link to="/admin" hash="canais" className="text-primary hover:underline">
                Ver testes
              </Link>
            </p>
          </div>
        </div>
      )}
      {banners.includes("not_delivering") && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-body"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div className="leading-snug">
            <p className="font-medium text-warning">
              Rota de SMS sem confirmação de entrega
              {data.notDeliveringSince ? ` desde ${formatDateTime(data.notDeliveringSince)}` : ""}
            </p>
            <p className="text-meta text-foreground/80">
              A Short Brasil aceitou os últimos SMS de controle, mas nenhum foi confirmado como
              entregue no celular. Os SMS das casas podem não estar chegando.{" "}
              <Link to="/admin" hash="canais" className="text-primary hover:underline">
                Ver testes
              </Link>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
