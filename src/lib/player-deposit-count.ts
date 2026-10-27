// Quantidade de depósitos de um jogador (puro, client-safe). Regra única da
// ficha do jogador (player-detail.functions.ts) e da ficha do expert
// (expert-lead-sheet.functions.ts): o maior entre os depósitos aprovados
// registrados aqui e o número de depósitos importado da plataforma da casa
// (player_attributions.raw_payload.normalized.depositos, ou raw.depositos).

type ImportedRawPayload = {
  normalized?: { depositos?: unknown } | null;
  raw?: { depositos?: unknown } | null;
} | null;

export function depositCountFor(args: {
  approvedCount: number;
  importedRawPayload: unknown;
}): number {
  const payload = (
    args.importedRawPayload && typeof args.importedRawPayload === "object"
      ? args.importedRawPayload
      : null
  ) as ImportedRawPayload;
  const imported = Number(payload?.normalized?.depositos ?? payload?.raw?.depositos ?? 0);
  return Math.max(args.approvedCount, imported || 0);
}
