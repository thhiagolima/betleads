// Consultas do admin sobre as campanhas e o uso dos experts (Área do Expert
// §8), compartilhadas pela tela Experts, pela aba "Campanhas" do expert e
// pela fila de aprovação.
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import {
  EXPERT_CAMPAIGNS_ADMIN_QUERY_KEY,
  EXPERT_USAGE_ADMIN_QUERY_KEY,
} from "@/components/experts/experts-query";
import { listExpertCampaignsForAdmin } from "@/lib/expert-campaigns.functions";
import { listExpertUsageForAdmin } from "@/lib/expert-campaigns-admin.functions";

/** Campanhas de um expert, ou só as pendentes da casa (`pendingOnly`). */
export function useExpertCampaignsAdmin(filter: {
  expertId?: string | null;
  pendingOnly?: boolean;
}) {
  const listFn = useServerFn(listExpertCampaignsForAdmin);
  const expertId = filter.expertId ?? null;
  const status = filter.pendingOnly ? "aguardando_aprovacao" : null;
  return useQuery({
    queryKey: [...EXPERT_CAMPAIGNS_ADMIN_QUERY_KEY, expertId, status],
    queryFn: () => listFn({ data: { expertId, status } }),
  });
}

/** Uso do mês × teto (e pendentes) de todos os experts ou de um só. */
export function useExpertUsageAdmin(expertId?: string | null, opts: { enabled?: boolean } = {}) {
  const usageFn = useServerFn(listExpertUsageForAdmin);
  return useQuery({
    queryKey: [...EXPERT_USAGE_ADMIN_QUERY_KEY, expertId ?? null],
    queryFn: () => usageFn({ data: { expertId: expertId ?? null } }),
    enabled: opts.enabled ?? true,
  });
}
