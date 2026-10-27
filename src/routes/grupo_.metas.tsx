// /grupo/metas (spec §7): goals editor, one table per house.
import { createFileRoute } from "@tanstack/react-router";
import { Target } from "lucide-react";

import { PageHeader } from "@/components/ui-premium";
import { GroupGoalsEditor } from "@/components/group/group-goals-editor";
import { useActiveGroup } from "@/hooks/use-active-group";

export const Route = createFileRoute("/grupo_/metas")({ component: GrupoMetasPage });

function GrupoMetasPage() {
  const { groups, active } = useActiveGroup();

  if (!groups.length) {
    return <p className="text-sm text-muted-foreground">Você não gerencia nenhum grupo.</p>;
  }

  if (!active) {
    return <div className="h-64 animate-pulse rounded-lg border border-border/40" />;
  }

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader
        title={`Metas — ${active.nome}`}
        subtitle="Uma meta por métrica e por casa. Vale a partir da data escolhida."
        icon={<Target className="h-5 w-5 text-primary-foreground" />}
      />
      <GroupGoalsEditor groupId={active.id} />
    </div>
  );
}
