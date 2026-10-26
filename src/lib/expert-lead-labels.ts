// Rótulos da Área do Expert usados no cliente e no servidor (puro, sem I/O).

export const CONTATO_RESULTADOS = [
  "chamei",
  "respondeu",
  "prometeu_depositar",
  "sem_interesse",
] as const;

export type ContatoResultado = (typeof CONTATO_RESULTADOS)[number];

export const CONTATO_LABEL: Record<ContatoResultado, string> = {
  chamei: "Chamei",
  respondeu: "Respondeu",
  prometeu_depositar: "Prometeu depositar",
  sem_interesse: "Sem interesse",
};
