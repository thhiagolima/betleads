export type ConversionDispatch = {
  id: string;
  idempotency_key?: string | null;
  message_log_id?: string | null;
  send_status?: string | null;
  delivery_status?: string | null;
  channel?: string | null;
  journey_step_id?: string | null;
  journey_step_position?: number | null;
};

export function deliveryIdentity(row: ConversionDispatch) {
  if (row.message_log_id) return `log:${row.message_log_id}`;
  const key = row.idempotency_key ?? row.id;
  return `delivery:${key.replace(/:\d+$/, "")}`;
}

export function uniqueDeliveryCount(
  rows: ConversionDispatch[],
  predicate: (row: ConversionDispatch) => boolean,
) {
  return new Set(rows.filter(predicate).map(deliveryIdentity)).size;
}

export function canAccessConversionDrilldown(role: string | null, superAdmin: boolean) {
  return superAdmin || role === "admin" || role === "super_admin";
}
