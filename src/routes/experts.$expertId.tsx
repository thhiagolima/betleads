// O detalhe do expert (Área do Expert, Fase 3, Task 6/8) virou o relatório
// de rendimento da pessoa (Relatório de rendimento, Task 5):
// /rendimento/equipe/$expertId. Esta rota só redireciona para lá — o
// endereço antigo continua valendo. O cartão "Extrato de créditos" que
// vivia aqui foi extraído para `CreditStatement`
// (`@/components/rendimento/credit-statement`), reusado pela Task 7.
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/experts/$expertId")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/rendimento/equipe/$expertId", params });
  },
});
