import { maskPhone } from "@/lib/campaign-recipients";

/** Display formatters shared by the campaign and journey reports (pt-BR). */
export const money = (value: number) =>
  value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
export const number = (value: number) => value.toLocaleString("pt-BR");
export const percent = (part: number, whole: number) =>
  `${((part / whole) * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
export const ratio = (value: number) =>
  value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const dateTime = (value?: string | null) =>
  value
    ? new Date(value).toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
export const day = (value?: string | null) =>
  value ? new Date(value).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) : null;

/**
 * Contact shown on screen: phones keep only the last 4 digits, e-mails keep the
 * first letter and the domain. The full contact stays in the CSV and on the
 * player's page.
 */
export function maskContact(value?: string | null) {
  const raw = String(value ?? "").trim();
  if (!raw) return "—";
  const at = raw.indexOf("@");
  if (at > 0) return `${raw[0]}•••${raw.slice(at)}`;
  return maskPhone(raw);
}
