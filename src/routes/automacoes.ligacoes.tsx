import { createFileRoute, redirect } from "@tanstack/react-router";

// Old "Ligações" automations page: the voice flows now live in the hub's voice tab.
export const Route = createFileRoute("/automacoes/ligacoes")({
  beforeLoad: () => {
    throw redirect({ to: "/automacoes", hash: "fluxos-de-voz" });
  },
});
