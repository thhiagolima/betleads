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
  label?: string | null;
};

const isEnabledStep = (step: JourneyStepRef) => step.is_enabled !== false;
const isCommunicationType = (step: JourneyStepRef) =>
  !["wait", "end"].includes(String(step.step_type ?? ""));
const isCommunicationStep = (step: JourneyStepRef) =>
  isEnabledStep(step) && isCommunicationType(step);

export type ConversionAttributionRow = {
  link_dispatch_id?: string | null;
  tracking_token?: string | null;
  event_type?: string | null;
  classification?: string | null;
  monetary_value?: number | string | null;
};

type ConversionCounts = {
  sent: number;
  delivered: number;
  clicked: number;
  deposits: number;
  recovered: number;
};

/** Result of one copy of a rotating SMS step (`variant` is the 0-based index). */
export type JourneyVariantConversion = ConversionCounts & { variant: number };

export type JourneyStepConversion = ConversionCounts & {
  stepId: string;
  stepPosition: number;
  label?: string | null;
  stepType?: string | null;
  /** Per-copy split; empty when the step never rotated copies. */
  variants: JourneyVariantConversion[];
  /** Sends without a recorded copy (made before the step rotated copies). */
  withoutVariant: ConversionCounts;
};

export type JourneyStepConversionResult = {
  steps: JourneyStepConversion[];
  /** Disabled steps that still own sends or deposits (history, e.g. old reminders). */
  retired: JourneyStepConversion[];
  /** Direct deposits whose dispatch could not be tied to any step. */
  unassigned: { deposits: number; recovered: number };
};

/** Execution key of a dispatch: one message may carry several links (`key:0`, `key:1`). */
export function dispatchDeliveryKey(row: ConversionDispatch) {
  return row.idempotency_key ? row.idempotency_key.replace(/:\d+$/, "") : null;
}

/**
 * Maps tracked dispatches and direct attributions to journey steps. A dispatch
 * belongs to the step in `journey_step_id` (enabled or not); when that id no
 * longer exists (step recreated by an edit) it falls back to the enabled step
 * at `journey_step_position`. An attribution follows its dispatch (by id, then
 * tracking token). Disabled steps with activity are returned as `retired`, so
 * header totals equal steps + retired + unassigned. When `variantByDelivery`
 * (execution key -> copy index) is given, each step is also split per copy.
 */
export function buildJourneyStepConversions(input: {
  steps: JourneyStepRef[];
  dispatches: ConversionDispatch[];
  attributions: ConversionAttributionRow[];
  confirmedDispatchIds: ReadonlySet<string>;
  variantByDelivery?: ReadonlyMap<string, number>;
}): JourneyStepConversionResult {
  const communicationSteps = input.steps.filter(isCommunicationType);
  const stepsById = new Map(communicationSteps.map((step) => [String(step.id), step]));
  const stepsByPosition = new Map<number, JourneyStepRef>(
    communicationSteps.filter(isEnabledStep).map((step) => [Number(step.position), step]),
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
  const variantOf = (row: ConversionDispatch | undefined) => {
    const key = row ? dispatchDeliveryKey(row) : null;
    const variant = key ? input.variantByDelivery?.get(key) : undefined;
    return Number.isInteger(variant) ? (variant as number) : null;
  };
  // Bucket key: `${stepId}` + `#${variant}` or `#none`.
  const bucketKey = (stepId: string, variant: number | null) =>
    `${stepId}#${variant === null ? "none" : variant}`;

  const rowsByBucket = new Map<string, ConversionDispatch[]>();
  const dispatchById = new Map<string, ConversionDispatch>();
  const dispatchByToken = new Map<string, ConversionDispatch>();
  for (const row of input.dispatches) {
    dispatchById.set(String(row.id), row);
    if (row.tracking_token) dispatchByToken.set(String(row.tracking_token), row);
    const step = resolveStep(row);
    if (!step) continue;
    const key = bucketKey(String(step.id), variantOf(row));
    const group = rowsByBucket.get(key) ?? [];
    group.push(row);
    rowsByBucket.set(key, group);
  }

  const moneyByBucket = new Map<string, { deposits: number; recovered: number }>();
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
      const key = bucketKey(String(step.id), variantOf(dispatch));
      target = moneyByBucket.get(key) ?? { deposits: 0, recovered: 0 };
      moneyByBucket.set(key, target);
    }
    target.deposits += 1;
    target.recovered += value;
  }

  const counts = (keys: string[]): ConversionCounts => {
    const rows = keys.flatMap((key) => rowsByBucket.get(key) ?? []);
    const money = { deposits: 0, recovered: 0 };
    for (const key of keys) {
      const item = moneyByBucket.get(key);
      money.deposits += item?.deposits ?? 0;
      money.recovered += item?.recovered ?? 0;
    }
    return {
      sent: uniqueDeliveryCount(rows, (row) => row.send_status === "sent"),
      delivered: uniqueDeliveryCount(rows, (row) => row.delivery_status === "delivered"),
      clicked: uniqueDeliveryCount(rows, (row) => input.confirmedDispatchIds.has(String(row.id))),
      ...money,
    };
  };

  const allKeys = new Set([...rowsByBucket.keys(), ...moneyByBucket.keys()]);
  const toConversion = (step: JourneyStepRef): JourneyStepConversion => {
    const stepId = String(step.id);
    const keys = [...allKeys].filter((key) => key.startsWith(`${stepId}#`));
    const variants = keys
      .map((key) => key.slice(stepId.length + 1))
      .filter((suffix) => suffix !== "none")
      .map(Number)
      .sort((a, b) => a - b)
      .map((variant) => ({ variant, ...counts([bucketKey(stepId, variant)]) }));
    return {
      stepId,
      stepPosition: Number(step.position),
      label: step.label ?? null,
      stepType: step.step_type ?? null,
      ...counts(keys),
      variants,
      withoutVariant: counts([bucketKey(stepId, null)]),
    };
  };

  const steps = communicationSteps.filter(isEnabledStep).map(toConversion);
  const retired = communicationSteps
    .filter((step) => !isEnabledStep(step))
    .sort((a, b) => Number(a.position) - Number(b.position))
    .map(toConversion)
    .filter((step) => step.sent > 0 || step.deposits > 0);
  return { steps, retired, unassigned };
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

export type CampaignFunnelAttribution = {
  player_id?: string | null;
  link_dispatch_id?: string | null;
  tracking_token?: string | null;
  event_type?: string | null;
  classification?: string | null;
  is_ftd?: boolean | null;
  player_active_at_click?: boolean | null;
};

/**
 * Funnel steps of a campaign in distinct players, like "Depositaram". A player
 * already active at the click (rule_version 3) leaves the whole funnel of that
 * SMS, not only its deposits, so login and deposit share the same base.
 */
export function campaignFunnelPlayers(attributions: CampaignFunnelAttribution[]) {
  const sms = (row: CampaignFunnelAttribution) =>
    String(row.link_dispatch_id ?? row.tracking_token ?? row.player_id);
  const direct = attributions.filter((row) => row.classification === "direct");
  const activeSms = new Set(
    direct
      .filter((row) => row.event_type === "deposit_approved" && row.player_active_at_click)
      .map(sms),
  );
  const counted = direct.filter((row) => !activeSms.has(sms(row)));
  const players = (match: (row: CampaignFunnelAttribution) => boolean) =>
    new Set(counted.filter(match).map((row) => String(row.player_id))).size;
  return {
    registered: players((row) => row.event_type === "registered"),
    loginOrGame: players((row) => row.event_type === "login" || row.event_type === "game"),
    ftd: players((row) => row.event_type === "deposit_approved" && row.is_ftd === true),
  };
}
