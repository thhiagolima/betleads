// /grupo/pessoas (spec §4/§8): people of every house in the active group.
import { createFileRoute } from "@tanstack/react-router";
import { Users } from "lucide-react";

import { PageHeader } from "@/components/ui-premium";
import { GroupPeople } from "@/components/group/group-people";
import { useActiveGroup } from "@/hooks/use-active-group";

export const Route = createFileRoute("/grupo_/pessoas")({ component: GrupoPessoasPage });

function GrupoPessoasPage() {
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
        title={`Pessoas — ${active.nome}`}
        subtitle="Gerencie quem acessa cada casa do grupo."
        icon={<Users className="h-5 w-5 text-primary-foreground" />}
      />
      <GroupPeople groupId={active.id} />
    </div>
  );
}
