import { Link, createFileRoute } from "@tanstack/react-router";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { DataCard } from "@/components/ui-premium/data-card";
import { SendWindowCard } from "@/components/send-window-card";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/configuracoes")({
  component: ConfigPage,
});

function ConfigPage() {
  return (
    <Page className="max-w-5xl">
      <PageHeader subtitle="Horário em que a casa pode enviar mensagens." />

      <SendWindowCard />

      <DataCard
        title="Equipe e permissões"
        description="Quem acessa a casa e o que cada pessoa pode fazer fica em Conta e equipe."
        actions={
          <Button asChild size="sm" variant="outline">
            <Link to="/tenants">Abrir Conta e equipe</Link>
          </Button>
        }
      />
    </Page>
  );
}
