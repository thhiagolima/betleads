export function brl(n: number | null | undefined) {
  return (n ?? 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    // Money always has two decimals ("R$ 10.137,90", never "R$ 10.137,9").
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function num(n: number | null | undefined) {
  return (n ?? 0).toLocaleString("pt-BR");
}

export function timeAgo(date: string | Date | null | undefined) {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60) return `${diff}s atrás`;
  if (diff < 3600) return `${Math.floor(diff / 60)}min atrás`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h atrás`;
  return `${Math.floor(diff / 86400)}d atrás`;
}
