import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle } from "lucide-react";
import { useIsSuperAdmin } from "@/hooks/use-is-super-admin";
import { getProviderAuthHealth } from "@/lib/provider-health.functions";

export function ProviderAuthBanner() {
  const { isSuperAdmin } = useIsSuperAdmin();
  const fetchHealth = useServerFn(getProviderAuthHealth);
  const { data } = useQuery({
    queryKey: ["provider-auth-health"],
    queryFn: () => fetchHealth(),
    refetchInterval: 60_000,
    enabled: isSuperAdmin,
  });
  if (!isSuperAdmin || !data?.issues?.length) return null;
  const authIssues = data.issues.filter((i) => i.kind === "auth");
  const downIssues = data.issues.filter((i) => i.kind === "provider_down");
  const channelLabel = (channel: string) =>
    channel === "sms"
      ? "SMS Short Brasil"
      : channel === "email"
        ? "E-mail Infobip"
        : channel === "call"
          ? "Voz Infobip"
          : channel.toUpperCase();
  const issueList = (issues: typeof data.issues) =>
    issues.map((i) => channelLabel(i.channel)).join(", ");
  return (
    <div className="mt-3 space-y-2">
      {authIssues.length > 0 && (
        <div className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-body">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div className="leading-snug">
            <p className="font-medium text-warning">
              Credenciais do provedor inválidas — disparos pausados ({issueList(authIssues)})
            </p>
            <p className="text-meta text-foreground/80">
              Atualize a chave de acesso do provedor no servidor (SMS:{" "}
              <code>SHORTCODE_SMS_TOKEN</code>; e-mail e voz: <code>INFOBIP_API_KEY</code>) e
              reinicie o servidor.
            </p>
          </div>
        </div>
      )}
      {downIssues.length > 0 && (
        <div className="flex items-start gap-3 rounded-lg border border-danger/40 bg-danger/10 p-3 text-body">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          <div className="leading-snug">
            <p className="font-medium text-danger">
              Provedor instável — envios aguardando ({issueList(downIssues)})
            </p>
            <p className="text-meta text-foreground/80">
              O provedor está falhando. A fila está preservada e os envios pendentes serão tentados
              de novo automaticamente quando ele voltar.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
