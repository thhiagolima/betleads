// /grupo/metas (spec §7): goals editor, one table per house.
import { createFileRoute } from "@tanstack/react-router";

import { Page, PageHeader } from "@/components/ui-premium";
import { GroupGoalsEditor } from "@/components/group/group-goals-editor";
import { useActiveGroup } from "@/hooks/use-active-group";

export const Route = createFileRoute("/grupo_/metas")({ component: GrupoMetasPage });

function GrupoMetasPage() {
  const { groups, active } = useActiveGroup();

  if (!groups.length) {
    return (
      <Page className="max-w-5xl">
        <PageHeader title="Metas" />
        <p className="text-sm text-muted-foreground">Você não gerencia nenhum grupo.</p>
      </Page>
    );
  }

  if (!active) {
    return <div className="h-64 animate-pulse rounded-lg border border-border/40" />;
  }

  return (
    <Page className="max-w-5xl">
      <PageHeader
        title={`Metas — ${active.nome}`}
        subtitle="Uma meta por métrica e por casa. Vale a partir da data escolhida."
      />
      <GroupGoalsEditor groupId={active.id} />
    </Page>
  );
}
