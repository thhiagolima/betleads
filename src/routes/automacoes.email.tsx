import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/automacoes/email")({
  beforeLoad: () => {
    throw redirect({ to: "/automacoes" });
  },
});
