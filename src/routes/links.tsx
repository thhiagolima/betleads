import { createFileRoute, redirect } from "@tanstack/react-router";

// Links curtos moved to Integrações (/webhooks#links). /links is the parent route of
// /links/configuracoes, and a parent's beforeLoad runs for the child too, so this one
// redirect covers both paths (the child keeps its own as a safety net).
export const Route = createFileRoute("/links")({
  beforeLoad: () => {
    throw redirect({ to: "/webhooks", hash: "links" });
  },
});
