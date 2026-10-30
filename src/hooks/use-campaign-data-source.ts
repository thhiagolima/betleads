import { useServerFn } from "@tanstack/react-start";
import { useMemo } from "react";

import { useActiveTenant } from "@/hooks/use-active-tenant";
import { campaignDataSourceFor, type CampaignDataSource } from "@/lib/campaign-data-source";

/**
 * The campaign/audience data source of the active house's role (same query
 * as the shell's `useShellNav`, so no extra request). The shell only mounts
 * /campanhas and /publicos once the role is known (`shellContentState`), so
 * the source never flips from house to expert under a mounted screen.
 */
export function useCampaignDataSource(): CampaignDataSource & { isExpert: boolean } {
  const { active } = useActiveTenant();
  const source = campaignDataSourceFor(active?.role ?? null);
  const listAudiences = useServerFn(source.listAudiences);
  const saveAudience = useServerFn(source.saveAudience);
  const deleteAudience = useServerFn(source.deleteAudience);
  const listDrafts = useServerFn(source.listDrafts);
  const getDraft = useServerFn(source.getDraft);
  const saveDraft = useServerFn(source.saveDraft);
  const deleteDraft = useServerFn(source.deleteDraft);
  const submitDraft = useServerFn(source.submitDraft);
  return useMemo(
    () => ({
      kind: source.kind,
      isExpert: source.kind === "expert",
      queryKeys: source.queryKeys,
      listAudiences,
      saveAudience,
      deleteAudience,
      listDrafts,
      getDraft,
      saveDraft,
      deleteDraft,
      submitDraft,
    }),
    [
      source,
      listAudiences,
      saveAudience,
      deleteAudience,
      listDrafts,
      getDraft,
      saveDraft,
      deleteDraft,
      submitDraft,
    ],
  );
}
