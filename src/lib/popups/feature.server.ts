// Popups nas casas — único ponto de "esta casa pode usar popup?". Na v1 todas
// podem (sem cobrança); quando virar recurso pago na mensalidade, a regra
// entra aqui e vale para o CRM, o loader e o endpoint público de uma vez.
export async function popupsEnabledForTenant(_tenantId: string): Promise<boolean> {
  return true;
}
