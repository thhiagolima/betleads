// Campo de valor em reais digitado no formato brasileiro ("1.500,00").
// Usado pelo teto mensal do expert (expert-form-dialog.tsx).

/**
 * Lê um valor em R$ digitado pelo usuário.
 * - `null`: campo vazio.
 * - `NaN`: valor inválido.
 * Aceita "1.500,00", "1500,5", "1500", "1.500" (milhar), "1500.50" (ponto
 * decimal, como colado de planilha) e o prefixo "R$". Até 2 casas decimais.
 */
export function parseBrlInput(raw: string): number | null {
  // `\s` também cobre o espaço não separável do toLocaleString.
  const text = raw.replace(/R\$/gi, "").replace(/\s/g, "");
  if (!text) return null;
  let normalized: string;
  if (text.includes(",")) {
    // Vírgula decimal: pontos só como separador de milhar, em grupos de 3.
    if (!/^\d{1,3}(\.\d{3})*(,\d{0,2})?$|^\d+(,\d{0,2})?$/.test(text)) return Number.NaN;
    normalized = text.replace(/\./g, "").replace(",", ".");
  } else if (/^\d{1,3}(\.\d{3})+$/.test(text)) {
    normalized = text.replace(/\./g, "");
  } else if (/^\d+(\.\d{0,2})?$/.test(text)) {
    normalized = text;
  } else {
    return Number.NaN;
  }
  const value = Number(normalized.replace(/\.$/, ""));
  return Number.isFinite(value) ? value : Number.NaN;
}

/** Valor para preencher o campo: 1500 → "1.500,00". */
export function formatBrlInput(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "";
  return value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
