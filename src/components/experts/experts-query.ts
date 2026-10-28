// Shared react-query keys for the Experts admin screen (Área do Expert,
// Fase 1, Task 8), so the form dialog, the invite dialog and the page all
// invalidate the same cache entries after a mutation.
export const EXPERTS_QUERY_KEY = ["experts-admin"];
export const UNASSIGNED_AFFILIATES_QUERY_KEY = ["experts-unassigned-affiliates"];
// Fase 3, Task 6: ranking (lista) do admin; a settings dialog invalida o
// prefixo "experts-ranking" inteiro depois de salvar a janela de clique, já
// que ela muda a métrica de todos os períodos em cache. O detalhe por
// expert (que vivia aqui, Task 6/8) foi substituído pelo relatório de
// rendimento (Relatório de rendimento, Task 5) —
// `/rendimento/equipe/$expertId` tem sua própria query key em
// `@/components/rendimento/credit-statement`.
export const EXPERTS_RANKING_QUERY_KEY = ["experts-ranking"];
