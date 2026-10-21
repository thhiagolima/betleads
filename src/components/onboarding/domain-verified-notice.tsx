// Home banner: "Domínio x verificado — já está sendo usado nos seus envios."
// for each domain that just turned verified. Admin-only — dismissing it
// calls `markVerifiedNoticeSeen`, which is an admin-only write, so members
// (who can't dismiss it) never see it at all.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { X } from "lucide-react";

import { HOUSE_SETUP_STATUS_QUERY_KEY } from "@/components/house-config/house-config-query";
import { getHouseSetupStatus, markVerifiedNoticeSeen } from "@/lib/house-config.functions";
import { useShellNav } from "@/components/shell/use-shell-nav";

export function DomainVerifiedNotice() {
  const { role, isSuperAdmin } = useShellNav();
  const canEdit = isSuperAdmin || role === "admin";

  const qc = useQueryClient();
  const fetchStatus = useServerFn(getHouseSetupStatus);
  const markSeenFn = useServerFn(markVerifiedNoticeSeen);

  const query = useQuery({
    queryKey: HOUSE_SETUP_STATUS_QUERY_KEY,
    queryFn: () => fetchStatus(),
    enabled: canEdit,
  });

  const markSeen = useMutation({
    mutationFn: (domainIds: string[]) => markSeenFn({ data: { domainIds } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: HOUSE_SETUP_STATUS_QUERY_KEY }),
  });

  if (!canEdit) return null;

  const newlyVerified = query.data?.newlyVerified ?? [];
  if (newlyVerified.length === 0) return null;

  return (
    <div className="flex items-start gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-[13.5px] text-emerald-100">
      <ul className="flex-1 space-y-1">
        {newlyVerified.map((d) => (
          <li key={d.id}>
            Domínio {d.hostname} verificado — já está sendo usado nos seus envios.
          </li>
        ))}
      </ul>
      <button
        type="button"
        aria-label="Fechar aviso"
        className="shrink-0 rounded-md p-1 text-emerald-100/70 hover:bg-emerald-500/10 hover:text-emerald-100"
        disabled={markSeen.isPending}
        onClick={() => markSeen.mutate(newlyVerified.map((d) => d.id))}
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
