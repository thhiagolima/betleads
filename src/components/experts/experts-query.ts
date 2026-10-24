// Shared react-query keys for the Experts admin screen (Área do Expert,
// Fase 1, Task 8), so the form dialog, the invite dialog and the page all
// invalidate the same cache entries after a mutation.
export const EXPERTS_QUERY_KEY = ["experts-admin"];
export const UNASSIGNED_AFFILIATES_QUERY_KEY = ["experts-unassigned-affiliates"];
