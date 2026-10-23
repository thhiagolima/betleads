import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/automacoes/sms")({
  beforeLoad: () => {
    throw redirect({ to: "/automacoes" });
  },
});
