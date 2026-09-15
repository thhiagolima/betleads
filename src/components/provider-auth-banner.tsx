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
  return (
    <div className="mx-4 mt-3 space-y-2">
      {authIssues.length > 0 && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <div className="leading-snug">
            <p className="font-medium text-amber-200">
              Token BusinessCode inválido — disparos pausados (
              {authIssues.map((i) => i.channel.toUpperCase()).join(", ")})
            </p>
            <p className="text-xs text-amber-100/80">
              A fila está preservada. Atualize o secret <code>BUSINESSCODE_SMS_TOKEN</code> /{" "}
              <code>BUSINESSCODE_EMAIL_TOKEN</code> e os envios retomam automaticamente.
            </p>
          </div>
        </div>
      )}
      {downIssues.length > 0 && (
        <div className="flex items-start gap-3 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
          <div className="leading-snug">
            <p className="font-medium text-rose-200">
              Provedor BusinessCode instável — disparos em backoff (
              {downIssues.map((i) => i.channel.toUpperCase()).join(", ")})
            </p>
            <p className="text-xs text-rose-100/80">
              O servidor da BusinessCode está respondendo erro 5xx ou HTML. A fila está
              preservada — as ligações pendentes serão retentadas automaticamente quando
              o provedor normalizar.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}