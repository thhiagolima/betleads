// O detalhe do expert (Área do Expert, Fase 3, Task 6/8) virou o relatório
// de rendimento da pessoa (Relatório de rendimento, Task 5):
// /rendimento/equipe/$expertId. Esta rota só redireciona para lá — o
// endereço antigo continua valendo, inclusive /experts/$id?aba=campanhas
// (aba Campanhas, Área do Expert §8). O cartão "Extrato de créditos" que
// vivia aqui foi extraído para `CreditStatement`
// (`@/components/rendimento/credit-statement`), reusado pela Task 7.
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/experts/$expertId")({
  validateSearch: (search: Record<string, unknown>): { aba?: "campanhas" } =>
    search.aba === "campanhas" ? { aba: "campanhas" } : {},
  beforeLoad: ({ params, search }) => {
    throw redirect({ to: "/rendimento/equipe/$expertId", params, search });
  },
});
