import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/automacoes/ligacoes")({
  beforeLoad: () => {
    throw redirect({ to: "/automacoes" });
  },
});
