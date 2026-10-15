export type ConversionDispatch = {
  id: string;
  tracked_link_id?: string | null;
  tracking_token?: string | null;
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

export type JourneyStepRef = {
  id: string;
  position: number;
  step_type?: string | null;
  is_enabled?: boolean | null;
};

const isEnabledStep = (step: JourneyStepRef) => step.is_enabled !== false;
const isCommunicationStep = (step: JourneyStepRef) =>
  isEnabledStep(step) && !["wait", "end"].includes(String(step.step_type ?? ""));

export type ConversionAttributionRow = {
  link_dispatch_id?: string | null;
  tracking_token?: string | null;
  event_type?: string | null;
  classification?: string | null;
  monetary_value?: number | string | null;
};

export type JourneyStepConversion = {
  stepId: string;
  stepPosition: number;
  sent: number;
  delivered: number;
  clicked: number;
  deposits: number;
  recovered: number;
};

export type JourneyStepConversionResult = {
  steps: JourneyStepConversion[];
  /** Direct deposits whose dispatch could not be tied to a current step. */
  unassigned: { deposits: number; recovered: number };
};

/**
 * Maps tracked dispatches and direct attributions to journey steps. A dispatch
 * belongs to the step in `journey_step_id`; when that id no longer exists
 * (step recreated by an edit) it falls back to `journey_step_position`. An
 * attribution follows its dispatch (by id, then tracking token). Anything that
 * cannot be placed is reported as `unassigned`, so header totals always equal
 * the sum of the steps plus the unassigned line.
 */
export function buildJourneyStepConversions(input: {
  steps: JourneyStepRef[];
  dispatches: ConversionDispatch[];
  attributions: ConversionAttributionRow[];
  confirmedDispatchIds: ReadonlySet<string>;
}): JourneyStepConversionResult {
  const communicationSteps = input.steps.filter(isCommunicationStep);
  const stepsById = new Map(communicationSteps.map((step) => [String(step.id), step]));
  const stepsByPosition = new Map<number, JourneyStepRef>(
    communicationSteps.map((step) => [Number(step.position), step]),
  );
  const resolveStep = (row: ConversionDispatch | undefined) => {
    if (!row) return undefined;
    if (row.journey_step_id) {
      const byId = stepsById.get(String(row.journey_step_id));
      if (byId) return byId;
    }
    if (row.journey_step_position !== null && row.journey_step_position !== undefined) {
      const position = Number(row.journey_step_position);
      if (Number.isFinite(position)) return stepsByPosition.get(position);
    }
    return undefined;
  };

  const rowsByStep = new Map<string, ConversionDispatch[]>();
  const dispatchById = new Map<string, ConversionDispatch>();
  const dispatchByToken = new Map<string, ConversionDispatch>();
  for (const row of input.dispatches) {
    dispatchById.set(String(row.id), row);
    if (row.tracking_token) dispatchByToken.set(String(row.tracking_token), row);
    const step = resolveStep(row);
    if (!step) continue;
    const group = rowsByStep.get(String(step.id)) ?? [];
    group.push(row);
    rowsByStep.set(String(step.id), group);
  }

  const depositsByStep = new Map<string, { deposits: number; recovered: number }>();
  const unassigned = { deposits: 0, recovered: 0 };
  for (const item of input.attributions) {
    if (item.classification !== "direct" || item.event_type !== "deposit_approved") continue;
    const dispatch =
      (item.link_dispatch_id ? dispatchById.get(String(item.link_dispatch_id)) : undefined) ??
      (item.tracking_token ? dispatchByToken.get(String(item.tracking_token)) : undefined);
    const step = resolveStep(dispatch);
    const value = Number(item.monetary_value ?? 0) || 0;
    let target = unassigned;
    if (step) {
      const key = String(step.id);
      target = depositsByStep.get(key) ?? { deposits: 0, recovered: 0 };
      depositsByStep.set(key, target);
    }
    target.deposits += 1;
    target.recovered += value;
  }

  const steps = communicationSteps.map((step) => {
    const rows = rowsByStep.get(String(step.id)) ?? [];
    const money = depositsByStep.get(String(step.id)) ?? { deposits: 0, recovered: 0 };
    return {
      stepId: String(step.id),
      stepPosition: Number(step.position),
      sent: uniqueDeliveryCount(rows, (row) => row.send_status === "sent"),
      delivered: uniqueDeliveryCount(rows, (row) => row.delivery_status === "delivered"),
      clicked: uniqueDeliveryCount(rows, (row) => input.confirmedDispatchIds.has(String(row.id))),
      deposits: money.deposits,
      recovered: money.recovered,
    };
  });
  return { steps, unassigned };
}

/**
 * Enrollments "at" a communication step: the step owns its own position and
 * every non-communication position (waits) since the previous communication
 * step. Returns inclusive [from, to] position ranges keyed by step id.
 */
export function journeyStepPositionRanges(steps: JourneyStepRef[]) {
  const ordered = steps
    .filter(isEnabledStep)
    .sort((a, b) => Number(a.position) - Number(b.position));
  const ranges: Array<{ stepId: string; from: number; to: number }> = [];
  let from = Math.min(0, ...ordered.map((step) => Number(step.position)));
  for (const step of ordered) {
    if (!isCommunicationStep(step)) continue;
    const position = Number(step.position);
    ranges.push({ stepId: String(step.id), from, to: position });
    from = position + 1;
  }
  return ranges;
}
