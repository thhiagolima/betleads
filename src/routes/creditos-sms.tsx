import { createFileRoute, redirect } from "@tanstack/react-router";

// "Saldo e consumo" was renamed and folded into "Plano e créditos" (Task 7).
// The old URL keeps working — it redirects, keeping any query string, so old
// bookmarks/links still land on the right page.
export const Route = createFileRoute("/creditos-sms")({
  beforeLoad: ({ location }) => {
    throw redirect({ to: "/plano-e-creditos", search: location.search });
  },
});
