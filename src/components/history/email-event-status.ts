import type { StatusColor } from "@/lib/history.functions";

/** Email log status → the history badge colour and a pt-BR label. */
export function emailEventStatus(status: string | null | undefined): {
  color: StatusColor;
  label: string;
} {
  switch ((status ?? "").toLowerCase()) {
    // The provider does not confirm delivery, so "delivered" also reads "Enviado".
    case "sent":
    case "delivered":
      return { color: "green", label: "Enviado" };
    case "failed":
    case "error":
    case "dlq":
      return { color: "red", label: "Falha" };
    case "bounced":
      return { color: "red", label: "Devolvido" };
    case "pending":
    case "queued":
    case "retry":
      return { color: "yellow", label: "Pendente" };
    case "sending":
    case "processing":
      return { color: "blue", label: "Enviando" };
    case "cancelled":
    case "canceled":
    case "skipped":
      return { color: "gray", label: "Cancelado" };
    default:
      return { color: "gray", label: "Outro" };
  }
}
