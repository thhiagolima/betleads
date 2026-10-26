import { createFileRoute, redirect } from "@tanstack/react-router";

// Configuração do Short.io moved to Integrações → Links curtos (/webhooks#links).
export const Route = createFileRoute("/links/configuracoes")({
  beforeLoad: () => {
    throw redirect({ to: "/webhooks", hash: "links" });
  },
});
