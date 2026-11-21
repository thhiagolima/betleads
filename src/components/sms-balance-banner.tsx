import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle } from "lucide-react";

import { formatDateTime } from "@/components/integrations/meta/meta-format";
import { balanceBanner } from "@/lib/sms-balance";
import { getSmsBalanceBanner } from "@/lib/sms-balance.functions";

export const SMS_BALANCE_BANNER_KEY = ["sms-balance-banner"] as const;

const sms = (value: number) => `${value.toLocaleString("pt-BR")} SMS`;

/**
 * Barra com o saldo da conta Short Brasil padrão, lido do painel a cada 15
 * min. Aparece para o super admin e para os usuários escolhidos por ele no
 * admin (Canais); para os outros o servidor devolve null.
 */
export function SmsBalanceBanner() {
  const fetchBanner = useServerFn(getSmsBalanceBanner);
  const { data } = useQuery({
    queryKey: SMS_BALANCE_BANNER_KEY,
    queryFn: () => fetchBanner(),
    refetchInterval: 120_000,
    staleTime: 60_000,
  });
  if (!data) return null;
  const { status, isSuperAdmin } = data;
  const kind = balanceBanner(status);
  if (!kind) return null;

  const readAt = status.balanceAt ? ` (lido em ${formatDateTime(status.balanceAt)})` : "";
  const details = isSuperAdmin ? (
    <>
      {" "}
      <Link to="/admin" hash="canais" className="text-primary hover:underline">
        Ver leituras
      </Link>
    </>
  ) : null;

  if (kind === "unreadable") {
    if (!isSuperAdmin) return null;
    return (
      <div className="mt-3">
        <div
          role="status"
          className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-body"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div className="leading-snug">
            <p className="font-medium text-warning">Não estou conseguindo ler o saldo da Short Brasil</p>
            <p className="text-meta text-foreground/80">
              As últimas leituras do painel falharam{status.lastError ? `: ${status.lastError}` : "."}{" "}
              O aviso de saldo baixo fica parado até voltar a ler.{details}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const empty = kind === "empty";
  return (
    <div className="mt-3">
      <div
        role="alert"
        className={
          empty
            ? "flex items-start gap-3 rounded-lg border border-danger/40 bg-danger/10 p-3 text-body"
            : "flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-body"
        }
      >
        <AlertTriangle className={`mt-0.5 h-4 w-4 shrink-0 ${empty ? "text-danger" : "text-warning"}`} />
        <div className="leading-snug">
          <p className={`font-medium ${empty ? "text-danger" : "text-warning"}`}>
            {empty
              ? `Short Brasil sem saldo: nenhum SMS está saindo${status.emptySince ? ` desde ${formatDateTime(status.emptySince)}` : ""}`
              : `Saldo de SMS acabando: restam ${sms(status.balance ?? 0)} na Short Brasil`}
          </p>
          <p className="text-meta text-foreground/80">
            {empty
              ? `Saldo da conta: ${sms(status.balance ?? 0)}${readAt}. Os SMS das casas que usam a conta padrão ficam guardados e saem quando o saldo voltar. Recarregue a conta na Short Brasil.`
              : `O aviso aparece com ${sms(status.threshold)} ou menos${readAt}. Quando zerar, nenhuma casa que usa a conta padrão envia SMS. Recarregue a conta na Short Brasil.`}
            {details}
          </p>
        </div>
      </div>
    </div>
  );
}
