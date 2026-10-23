import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/automacoes/whatsapp")({
  beforeLoad: () => {
    throw redirect({ to: "/automacoes" });
  },
});
