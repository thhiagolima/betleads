import { createFileRoute } from "@tanstack/react-router";

// Placeholder for Task 7 ("Pagamento, plano e créditos" page), which
// replaces /creditos-sms with the mensalidade + créditos + faturas page.
// Task 6 only needs the route to exist so BillingBanner/BillingLock can
// type-check their `/plano-e-creditos` links — this component is
// intentionally minimal and gets replaced by Task 7.
export const Route = createFileRoute("/plano-e-creditos")({
  component: PlanoECreditosPlaceholder,
});

function PlanoECreditosPlaceholder() {
  return null;
}
