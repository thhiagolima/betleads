// Shared react-query keys for the Experts admin screen (Área do Expert,
// Fase 1, Task 8), so the form dialog, the invite dialog and the page all
// invalidate the same cache entries after a mutation.
export const EXPERTS_QUERY_KEY = ["experts-admin"];
export const UNASSIGNED_AFFILIATES_QUERY_KEY = ["experts-unassigned-affiliates"];
// Janela de clique da casa, só para preencher a "Regras de crédito" dialog
// nesta tela (Relatório de rendimento, Task 7) — as telas de relatório pegam
// a janela de `getExpertReport`/`getTeamReport`.
export const EXPERT_CLICK_WINDOW_QUERY_KEY = ["expert-click-window"];
// O ranking (lista) e o detalhe por expert que viviam aqui (Fase 3, Task 6/8)
// foram substituídos pelo relatório de rendimento (Relatório de rendimento,
// Tasks 5 e 7): `/rendimento/equipe` (ranking) e
// `/rendimento/equipe/$expertId` (detalhe) têm suas próprias query keys em
// `@/components/rendimento/team-ranking` e
// `@/components/rendimento/credit-statement`.
