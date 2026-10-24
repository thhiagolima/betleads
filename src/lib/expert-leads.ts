// Parte pura (sem I/O) da Área do Expert: tipos e cálculos usados pela
// listagem de leads do expert (src/lib/expert-leads.functions.ts).

export type ExpertLeadRow = {
  id: string;
  nome: string;
  telefone: string | null;
  totalDepositado: number;
  ultimoDeposito: string | null;
  diasSemDepositar: number | null;
  risco: string;
  vip: boolean;
};

/**
 * Dias inteiros desde o último depósito, arredondado para baixo (3 dias e 5
 * horas atrás -> 3; no mesmo dia -> 0). `null` sem depósito.
 */
export function diasSemDepositar(ultimoDeposito: string | null, now: Date): number | null {
  if (!ultimoDeposito) return null;
  const elapsedMs = now.getTime() - new Date(ultimoDeposito).getTime();
  return Math.floor(elapsedMs / 86_400_000);
}
