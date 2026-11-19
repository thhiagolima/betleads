// /grupo/pessoas (spec §4/§8): people of every house in the active group.
import { createFileRoute } from "@tanstack/react-router";

import { Page, PageHeader } from "@/components/ui-premium";
import { GroupPeople } from "@/components/group/group-people";
import { useActiveGroup } from "@/hooks/use-active-group";

export const Route = createFileRoute("/grupo_/pessoas")({ component: GrupoPessoasPage });

function GrupoPessoasPage() {
  const { groups, active } = useActiveGroup();

  if (!groups.length) {
    return (
      <Page className="max-w-5xl">
        <PageHeader title="Pessoas" />
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
        title={`Pessoas — ${active.nome}`}
        subtitle="Gerencie quem acessa cada casa do grupo."
      />
      <GroupPeople groupId={active.id} />
    </Page>
  );
}
