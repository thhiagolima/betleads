// Helpers of the "Claude e API" screens (/mcp and /api-dados): copy with a
// toast, and the date format of the connection and key lists.
import { toast } from "sonner";

import { copyToClipboard } from "@/lib/clipboard";

export function fmtDate(d: string | null) {
  if (!d) return "nunca";
  return new Date(d).toLocaleString("pt-BR");
}

export async function copiar(texto: string, aviso: string) {
  if (await copyToClipboard(texto)) toast.success(aviso);
  else toast.error("Não foi possível copiar. Selecione o texto e copie à mão.");
}
