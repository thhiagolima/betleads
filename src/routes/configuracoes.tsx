import { createFileRoute } from "@tanstack/react-router";
import { Shield } from "lucide-react";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { DataCard } from "@/components/ui-premium/data-card";
import { SendWindowCard } from "@/components/send-window-card";

export const Route = createFileRoute("/configuracoes")({
  component: ConfigPage,
});

function ConfigPage() {
  return (
    <Page className="max-w-5xl">
      <PageHeader subtitle="Janela de envio e papéis da equipe." />

      <SendWindowCard />

      <DataCard
        title="Papéis e permissões"
        description="A interface explica os limites de cada papel. As permissões efetivas são sempre validadas no servidor."
        icon={<Shield className="h-4 w-4" />}
      >
        <div className="grid gap-3 md:grid-cols-2">
          {[
            {
              role: "Membro",
              access: "Opera o CRM da conta selecionada.",
              limit: "Não gerencia equipe nem altera privilégios.",
            },
            {
              role: "Gestor",
              access: "Acompanha e opera o CRM da conta selecionada.",
              limit: "Não gerencia equipe nem eleva papéis.",
            },
            {
              role: "Admin da conta",
              access: "Gerencia membros e configurações permitidas da própria conta.",
              limit: "Não cria, altera ou remove outro admin; não acessa finanças globais.",
            },
            {
              role: "Superadmin global",
              access: "Administra contas, administradores, saldo, status e diagnósticos globais.",
              limit: "Acesso reservado à operação da plataforma e registrado em auditoria.",
            },
          ].map((permission) => (
            <div
              key={permission.role}
              className="rounded-lg border border-border/40 bg-background/30 p-4"
            >
              <p className="text-body font-semibold">{permission.role}</p>
              <p className="mt-1 text-body text-muted-foreground">{permission.access}</p>
              <p className="mt-2 text-meta text-muted-foreground">Limite: {permission.limit}</p>
            </div>
          ))}
        </div>
        <p className="mt-4 text-meta text-muted-foreground">
          Para administrar a equipe da conta, acesse Contas. A alteração de papel é auditada.
        </p>
      </DataCard>
    </Page>
  );
}
