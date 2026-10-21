import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { EmailDomainNotVerifiedError, resolveSender, sendInfobipEmail } from "./email-send.server";
import { callInfobipVoice, normalizeE164BR } from "./infobip-voice.server";
import { sendSmsInternal } from "./sms.functions";
import { buildPlayerVariables, renderTemplate } from "./template-vars.server";
import { detectTriggersForPlayer } from "./triggers.server";
import { evaluateVoiceContactPolicy, isChannelRevoked } from "./consent.server";
import { startJobRun, type JobRunHandle } from "./observability/job-monitor.server";
import { resolveJourneyWorkerScope } from "./journey-worker-scope";
import { channelBudget, type Admission } from "./rate-limit/channel-budget.server";
import { captureServerException } from "./observability/sentry.server";
import {
  createClaimingSource,
  createTimeBudget,
  runBoundedPool,
  sleep,
  startLeaseKeeper,
  type ClaimingSource,
  type LeaseKeeper,
  type TimeBudget,
} from "./rate-limit/pool";
import {
  MAX_NO_COST_DEFERS,
  ProviderSendError,
  classifyProviderFailure,
} from "./rate-limit/provider-errors.server";
import {
  BREAKER_CACHE_MS,
  acquireSmsSendGate,
  breakerRetryAt,
  cachedSmsBreaker,
  readSmsBreaker,
  releaseSmsProbe,
  type SmsSendGate,
} from "./sms-provider-breaker.server";
import { resolveDispatchWorkerConfig } from "./rate-limit/worker-config";
import { brtDayStart } from "./tz";
import { listDemoTenantIds } from "./tenant-access.server";
import {
  audienceMatches,
  inactivityBandConfig,
  journeyEntryKey,
  nextJourneyWindowOpen,
  pickSmsVariant,
  pixExpiryHours,
  qualifiesForInactivity,
  smsVariants,
  triggerOccurrence,
} from "./journey-policy";

export { nextJourneyWindowOpen } from "./journey-policy";

type JourneyRow = {
  id: string;
  status: string;
  tenant_id?: string;
  trigger_type?: string;
  trigger_config?: Record<string, unknown>;
  exit_rules: Record<string, boolean>;
  entry_rules: Record<string, unknown>;
  daily_limit: number;
  cooldown_hours: number;
};
type EnrollmentRow = {
  id: string;
  tenant_id: string;
  journey_id: string;
  player_id: string | null;
  current_position: number;
  entered_at: string;
  attempts: number;
  loop_iteration: number;
  entry_key?: string;
  is_holdout?: boolean;
};
type StepRow = {
  id: string;
  position: number;
  step_type: "wait" | "sms" | "email" | "voice" | "condition" | "split" | "update_player" | "end";
  config: Record<string, unknown>;
};

type PlayerActivity = {
  ftd_em: string | null;
  ultimo_jogo: string | null;
};

// The generated client types are updated after the migration is deployed. This
// narrow escape hatch keeps the dispatcher deployable during that transition.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any;

type EventTriggerMatch = { matches: boolean; occurrence: string };

/** Event triggers optionally use `start_after`; without it, backfill is allowed. */
export async function matchFinancialTrigger(
  journey: { tenant_id: string; trigger_type: string; trigger_config: Record<string, unknown> },
  player: Record<string, unknown>,
): Promise<EventTriggerMatch | null> {
  const startAfter = String(journey.trigger_config?.start_after ?? "");
  const parsedStartAt = Date.parse(startAfter);
  const startAt = Number.isFinite(parsedStartAt) ? parsedStartAt : null;
  if (
    ![
      "cadastrados_sem_deposito",
      "pix_gerado_nao_pago",
      "primeiro_deposito",
      "saque_pago",
    ].includes(journey.trigger_type)
  )
    return null;
  if (journey.trigger_type === "cadastrados_sem_deposito") {
    const createdAt = String(player.created_at ?? "");
    const occurredAt = Date.parse(createdAt);
    return {
      matches:
        !player.ftd_em && Number.isFinite(occurredAt) && (startAt == null || occurredAt >= startAt),
      occurrence: createdAt || "missing_registration",
    };
  }

  if (journey.trigger_type === "primeiro_deposito") {
    const firstDepositAt = String(player.ftd_em ?? "");
    const occurredAt = Date.parse(firstDepositAt);
    return {
      matches: Number.isFinite(occurredAt) && (startAt == null || occurredAt >= startAt),
      occurrence: firstDepositAt || "missing_first_deposit",
    };
  }

  const table = journey.trigger_type === "saque_pago" ? "withdrawals" : "deposits";
  let query = db
    .from(table)
    .select("id,created_at,updated_at,metodo,status")
    .eq("tenant_id", journey.tenant_id)
    .eq("player_id", player.id)
    .order("created_at", { ascending: false })
    .limit(1);
  if (startAt != null) query = query.gte("created_at", new Date(startAt).toISOString());
  // D-6: a pending PIX older than the expiry no longer keeps the player in the journey.
  const expiryHours =
    journey.trigger_type === "pix_gerado_nao_pago" ? pixExpiryHours(journey.trigger_config) : null;
  if (expiryHours != null)
    query = query.gte("created_at", new Date(Date.now() - expiryHours * 3600_000).toISOString());
  query =
    journey.trigger_type === "saque_pago"
      ? query.eq("status", "aprovado")
      : query.eq("status", "pendente").ilike("metodo", "%pix%");
  const { data, error } = await query.maybeSingle();
  if (error || !data) return { matches: false, occurrence: "none" };
  return { matches: true, occurrence: String(data.id) };
}

async function event(
  enrollment: EnrollmentRow,
  type: string,
  detail: Record<string, unknown> = {},
) {
  await db.from("journey_events").insert({
    tenant_id: enrollment.tenant_id,
    journey_id: enrollment.journey_id,
    enrollment_id: enrollment.id,
    event_type: type,
    detail,
  });
}

/**
 * Writes the item's next state and gives up the claim. Fenced on claimed_by:
 * if this worker's lease expired and another worker took the item over, the
 * write is dropped (and counted) instead of clobbering the new owner's state.
 */
async function release(
  enrollment: EnrollmentRow,
  ctx: DispatchContext,
  patch: Record<string, unknown>,
) {
  const { data, error } = await db
    .from("journey_enrollments")
    .update({ ...patch, claimed_at: null, claimed_by: null, lease_expires_at: null })
    .eq("id", enrollment.id)
    .eq("claimed_by", ctx.workerId)
    .select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) {
    ctx.counters.leaseLost++;
    console.warn("[journey dispatcher] lease lost; state write dropped", {
      enrollmentId: enrollment.id,
      workerId: ctx.workerId,
    });
  }
}

async function shouldExit(
  enrollment: EnrollmentRow,
  rules: Record<string, boolean>,
  inactivityField = "ultimo_deposito",
): Promise<string | null> {
  if (!enrollment.player_id) return null;
  const { data: player } = await supabaseAdmin
    .from("players")
    .select("ultimo_login,ultimo_jogo,ultimo_deposito,ftd_em")
    .eq("id", enrollment.player_id)
    .maybeSingle();
  if (!player) return null;
  const activity = player as unknown as PlayerActivity;
  const enteredAt = new Date(enrollment.entered_at).getTime();
  const afterEntry = (value: string | null | undefined) =>
    value && new Date(value).getTime() > enteredAt;
  if (rules.deposit && afterEntry(player.ultimo_deposito)) return "deposit";
  if (rules.first_deposit && afterEntry(activity.ftd_em)) return "first_deposit";
  if (rules.login && (afterEntry(player.ultimo_login) || afterEntry(activity.ultimo_jogo)))
    return "login";
  if (rules.voltou_jogar && afterEntry(activity.ultimo_jogo)) return "voltou_jogar";
  // Category switch between inactivity journeys (Esfriando → Dormindo → 30
  // dias): leave this journey once the player crossed the next one's threshold.
  // Measured on the same field the journey's entry uses (S-05).
  const overHours = Number((rules as Record<string, unknown>).inactivity_over_hours);
  const lastActivity = (player as Record<string, unknown>)[
    ["ultimo_login", "ultimo_jogo", "ultimo_deposito"].includes(inactivityField)
      ? inactivityField
      : "ultimo_deposito"
  ];
  if (Number.isFinite(overHours) && overHours > 0 && typeof lastActivity === "string") {
    const idleMs = Date.now() - new Date(lastActivity).getTime();
    if (idleMs >= overHours * 3600_000) return "inactivity_threshold";
  }
  return null;
}

function inactivityField(journey: JourneyRow) {
  return journey.trigger_type === "inactivity"
    ? String(journey.trigger_config?.field ?? "ultimo_deposito")
    : "ultimo_deposito";
}

/** Variation indexes this player already received today from this journey (D-8). */
async function variantsUsedToday(enrollment: EnrollmentRow): Promise<number[]> {
  // Only a preference (avoid repeating a text): a failed lookup must never
  // block the send itself.
  try {
    const dayStart = brtDayStart(new Date()).toISOString();
    const { data, error } = await db
      .from("journey_step_executions")
      .select("provider_response,journey_enrollments!inner(player_id)")
      .eq("tenant_id", enrollment.tenant_id)
      .eq("journey_id", enrollment.journey_id)
      .eq("journey_enrollments.player_id", enrollment.player_id)
      .in("status", ["sent", "delivered"])
      .gte("created_at", dayStart);
    if (error) return [];
    return ((data ?? []) as Array<{ provider_response: Record<string, unknown> | null }>)
      .map((row) => Number(row.provider_response?.variant_index))
      .filter((index) => Number.isInteger(index));
  } catch (error) {
    console.warn("[journeys] variant history lookup failed", error);
    return [];
  }
}

async function execution(enrollment: EnrollmentRow, step: StepRow, channel: string | null) {
  const { data, error } = await db
    .from("journey_step_executions")
    .insert({
      tenant_id: enrollment.tenant_id,
      journey_id: enrollment.journey_id,
      enrollment_id: enrollment.id,
      step_id: step.id,
      step_position: step.position,
      loop_iteration: Number(enrollment.loop_iteration ?? 0),
      channel,
      attempt: enrollment.attempts + 1,
      status: "claimed",
    })
    .select("id,idempotency_key")
    .single();
  if (error) throw new Error(error.message);
  return data as { id: string; idempotency_key: string };
}

async function reserveDelivery(enrollment: EnrollmentRow, step: StepRow, journey: JourneyRow) {
  const { data, error } = await db.rpc("reserve_journey_delivery_v2", {
    p_tenant_id: enrollment.tenant_id,
    p_journey_id: enrollment.journey_id,
    p_enrollment_id: enrollment.id,
    p_step_id: step.id,
    p_step_position: step.position,
    p_player_id: enrollment.player_id,
    p_channel: step.step_type,
    p_daily_limit: journey.daily_limit,
    p_cooldown_hours: journey.cooldown_hours,
  });
  if (error) throw new Error(error.message);
  return (data?.[0] ?? null) as {
    execution_id: string | null;
    idempotency_key: string | null;
    retry_at: string | null;
    blocked_reason: string | null;
  } | null;
}

/** Shortener chosen on the step; resolveShortenerDomain validates it at send time. */
function stepShortDomainId(config: Record<string, unknown>): string | null {
  return typeof config.short_domain_id === "string" && config.short_domain_id
    ? config.short_domain_id
    : null;
}

async function finishExecution(id: string, patch: Record<string, unknown>) {
  await db
    .from("journey_step_executions")
    .update({ ...patch, completed_at: new Date().toISOString() })
    .eq("id", id);
}

async function playerFor(enrollment: EnrollmentRow) {
  if (!enrollment.player_id) return null;
  const { data } = await supabaseAdmin
    .from("players")
    .select("*")
    .eq("id", enrollment.player_id)
    .maybeSingle();
  return data;
}

async function stillMatchesJourneyEntry(
  enrollment: EnrollmentRow,
  journey: JourneyRow,
): Promise<boolean> {
  const trigger = journey.trigger_type ?? "manual";
  // These triggers describe an occurrence that was already captured when the
  // enrollment was created. Cashback intentionally waits until D+1, so it
  // must not be invalidated merely because the calendar day changed.
  if (trigger === "manual" || trigger === "nivel_alterado" || trigger === "cashback_pago")
    return true;
  const player = await playerFor(enrollment);
  if (!player) return false;
  // E-06: a player who left the journey's audience (e.g. no longer active or
  // no longer VIP) stops receiving it.
  if (!audienceMatches({ entry_rules: journey.entry_rules ?? {} }, player as never)) return false;
  const triggerConfig = journey.trigger_config ?? {};
  const eventMatch = await matchFinancialTrigger(
    {
      tenant_id: enrollment.tenant_id,
      trigger_type: trigger,
      trigger_config: triggerConfig,
    },
    player as Record<string, unknown>,
  );
  if (eventMatch) return eventMatch.matches;
  return trigger === "inactivity"
    ? qualifiesForInactivity(
        player as Record<string, unknown>,
        inactivityBandConfig(triggerConfig, journey.exit_rules),
      )
    : detectTriggersForPlayer(player as never).includes(trigger as never);
}

/**
 * Time-sensitive triggers lose their meaning when delivery is very late (e.g.
 * a "PIX not paid" SMS hours after the PIX, after a provider outage).
 * `trigger_config.max_delay_minutes` overrides the default; 0 disables.
 */
const DEFAULT_MAX_DELAY_MINUTES: Record<string, number> = {
  pix_gerado_nao_pago: 120,
  saque_pago: 120,
};

export function maxSendDelayMinutes(
  triggerType: string,
  triggerConfig: Record<string, unknown> | null | undefined,
): number | null {
  const configured = Number(triggerConfig?.max_delay_minutes);
  if (triggerConfig && "max_delay_minutes" in triggerConfig && Number.isFinite(configured)) {
    return configured > 0 ? configured : null;
  }
  return DEFAULT_MAX_DELAY_MINUTES[triggerType] ?? null;
}

/**
 * How late a send step is versus its planned time (entry + the waits before
 * it). next_run_at cannot be used: deferrals (cooldown, provider breaker)
 * rewrite it. Returns null when there is no limit or the step is on time.
 */
export function staleSendLatencyMinutes(args: {
  triggerType: string;
  triggerConfig: Record<string, unknown> | null | undefined;
  enteredAt: string;
  waitSecondsBefore: number;
  loopIteration: number;
  /** Send window (entry_rules). A step planned outside it is due at the next opening. */
  entryRules?: Record<string, unknown> | null;
  now?: number;
}): number | null {
  const limit = maxSendDelayMinutes(args.triggerType, args.triggerConfig);
  if (limit == null || args.loopIteration > 0) return null;
  const entered = Date.parse(args.enteredAt);
  if (!Number.isFinite(entered)) return null;
  const rawPlanned = entered + Math.max(0, args.waitSecondsBefore) * 1000;
  // Waiting for the send window is planned, not late (e.g. a PIX at 22:30
  // whose Dia 1 goes at 08:00).
  const windowOpen = args.entryRules
    ? nextJourneyWindowOpen(args.entryRules, new Date(rawPlanned))
    : null;
  const planned = windowOpen ? Date.parse(windowOpen) : rawPlanned;
  const lateMinutes = ((args.now ?? Date.now()) - planned) / 60_000;
  return lateMinutes > limit ? Math.floor(lateMinutes) : null;
}

async function waitSecondsBeforePosition(journeyId: string, position: number) {
  const { data } = await db
    .from("journey_steps")
    .select("config")
    .eq("journey_id", journeyId)
    .eq("step_type", "wait")
    .eq("is_enabled", true)
    .lt("position", position);
  return ((data ?? []) as Array<{ config: Record<string, unknown> }>).reduce(
    (total, row) => total + Math.max(0, Number(row.config?.delay_seconds ?? 0) || 0),
    0,
  );
}

async function executeEnrollment(
  id: string,
  ctx: DispatchContext,
  preAdmitted: ChannelGate | null = null,
): Promise<void> {
  const { data: enrollmentRaw, error: enrollmentError } = await db
    .from("journey_enrollments")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (enrollmentError) throw new Error(enrollmentError.message);
  if (!enrollmentRaw) return;
  const enrollment = enrollmentRaw as EnrollmentRow;

  const { data: journeyRaw } = await db
    .from("journeys")
    .select(
      "id,status,trigger_type,trigger_config,exit_rules,entry_rules,daily_limit,cooldown_hours",
    )
    .eq("id", enrollment.journey_id)
    .maybeSingle();
  const journey = journeyRaw as JourneyRow | null;
  if (!journey || journey.status !== "active") {
    await release(enrollment, ctx, { status: "paused" });
    return;
  }
  if (!(await stillMatchesJourneyEntry(enrollment, journey))) {
    await release(enrollment, ctx, {
      status: "exited",
      exited_at: new Date().toISOString(),
      exit_reason: "entry_no_longer_matches",
    });
    await event(enrollment, "entry_eligibility_lost", { trigger: journey.trigger_type });
    return;
  }
  const nextOpen = nextJourneyWindowOpen(journey.entry_rules ?? {});
  if (nextOpen) {
    await release(enrollment, ctx, { status: "waiting", next_run_at: nextOpen });
    await event(enrollment, "deferred_outside_window", { next_run_at: nextOpen });
    return;
  }
  const exitReason = await shouldExit(
    enrollment,
    journey.exit_rules ?? {},
    inactivityField(journey),
  );
  if (exitReason) {
    await release(enrollment, ctx, {
      status: "exited",
      exited_at: new Date().toISOString(),
      exit_reason: exitReason,
    });
    await event(enrollment, "exited", { reason: exitReason });
    return;
  }
  const { data: stepRaw } = await db
    .from("journey_steps")
    .select("*")
    .eq("journey_id", enrollment.journey_id)
    .eq("position", enrollment.current_position)
    .eq("is_enabled", true)
    .maybeSingle();
  const step = stepRaw as StepRow | null;
  if (!step) {
    await release(enrollment, ctx, {
      status: "completed",
      completed_at: new Date().toISOString(),
      exit_reason: "finished",
    });
    await event(enrollment, "completed");
    return;
  }

  if (step.step_type === "wait") {
    const run = await execution(enrollment, step, null);
    const seconds = Number(step.config.delay_seconds ?? 0);
    if (!Number.isInteger(seconds) || seconds < 60) throw new Error("Passo de espera inválido");
    await finishExecution(run.id, { status: "sent", executed_at: new Date().toISOString() });
    await release(enrollment, ctx, {
      status: "waiting",
      current_position: step.position + 1,
      next_run_at: new Date(Date.now() + seconds * 1000).toISOString(),
    });
    await event(enrollment, "wait_scheduled", { seconds, step_position: step.position });
    return;
  }

  if (step.step_type === "end") {
    const run = await execution(enrollment, step, null);
    await finishExecution(run.id, { status: "sent", executed_at: new Date().toISOString() });
    const loopToPosition = Number(step.config.loop_to_position);
    if (Number.isInteger(loopToPosition) && loopToPosition >= 0 && loopToPosition < step.position) {
      const { data: loopTarget } = await db
        .from("journey_steps")
        .select("id")
        .eq("journey_id", enrollment.journey_id)
        .eq("position", loopToPosition)
        .eq("is_enabled", true)
        .maybeSingle();
      if (!loopTarget) throw new Error("Destino do loop da jornada nao encontrado");
      await release(enrollment, ctx, {
        status: "active",
        current_position: loopToPosition,
        loop_iteration: Number(enrollment.loop_iteration ?? 0) + 1,
        next_run_at: new Date().toISOString(),
        attempts: 0,
      });
      await event(enrollment, "loop_restarted", {
        step_position: step.position,
        loop_to_position: loopToPosition,
        loop_iteration: Number(enrollment.loop_iteration ?? 0) + 1,
      });
      return;
    }
    await release(enrollment, ctx, {
      status: "completed",
      completed_at: new Date().toISOString(),
      exit_reason: "end_step",
    });
    await event(enrollment, "completed", { step_position: step.position });
    return;
  }

  if (maxSendDelayMinutes(journey.trigger_type ?? "", journey.trigger_config) != null) {
    const lateMinutes = staleSendLatencyMinutes({
      triggerType: journey.trigger_type ?? "",
      triggerConfig: journey.trigger_config,
      enteredAt: enrollment.entered_at,
      waitSecondsBefore: await waitSecondsBeforePosition(enrollment.journey_id, step.position),
      loopIteration: Number(enrollment.loop_iteration ?? 0),
      entryRules: journey.entry_rules ?? {},
    });
    if (lateMinutes != null) {
      await release(enrollment, ctx, {
        status: "exited",
        exited_at: new Date().toISOString(),
        exit_reason: "stale_message",
      });
      await event(enrollment, "exited", {
        reason: "stale_message",
        step_position: step.position,
        late_minutes: lateMinutes,
      });
      return;
    }
  }

  // F3: control group players go through the journey without any message
  // (no send, no cost); waits, exits and loops still apply.
  if (enrollment.is_holdout && SEND_CHANNELS.has(step.step_type)) {
    const run = await execution(enrollment, step, step.step_type);
    await finishExecution(run.id, { status: "skipped", provider: "holdout" });
    await release(enrollment, ctx, {
      status: "active",
      current_position: step.position + 1,
      next_run_at: new Date().toISOString(),
      attempts: 0,
    });
    await event(enrollment, "step_skipped", {
      channel: step.step_type,
      step_position: step.position,
      reason: "holdout",
    });
    return;
  }

  const player = await playerFor(enrollment);
  if (!player) throw new Error("Jogador da jornada não encontrado");
  const vars = buildPlayerVariables(player);
  const channel = step.step_type;
  const consentTarget = channel === "email" ? player.email : player.telefone;
  if (
    (channel === "sms" || channel === "email") &&
    consentTarget &&
    (await isChannelRevoked(enrollment.tenant_id, channel, consentTarget))
  ) {
    await release(enrollment, ctx, {
      status: "active",
      current_position: step.position + 1,
      next_run_at: new Date().toISOString(),
      attempts: 0,
    });
    await event(enrollment, "step_skipped", {
      channel,
      step_position: step.position,
      reason: "consent_revoked",
    });
    return;
  }
  // ENV-04: provider/tenant rate limit before reserving the delivery. The
  // dispatcher normally admits the item before any pre-check (I2, see
  // admitClaimedItem); this path covers claims without a step type or a step
  // that changed channel since the claim. The caller frees a pre-admitted
  // permit unless deliverStep keeps it.
  if (preAdmitted?.channel === channel) {
    await deliverStep(enrollment, ctx, journey, step, player, vars, preAdmitted);
    return;
  }
  const admission = await channelBudget.acquire(enrollment.tenant_id, channel, {
    deadline: ctx.budget.claimDeadline,
    holder: ctx.workerId,
  });
  if (!admission.ok) {
    ctx.counters.rateLimited++;
    await release(enrollment, ctx, {
      next_run_at: new Date(Date.now() + Math.max(1_000, admission.retryAfterMs)).toISOString(),
    });
    return;
  }
  const gate: ChannelGate = { channel, admission, keepPermit: false };
  try {
    await deliverStep(enrollment, ctx, journey, step, player, vars, gate);
  } finally {
    if (!gate.keepPermit) await channelBudget.release(admission);
  }
}

/**
 * A rate-limit admission held while one item is processed. Voice keeps its
 * concurrency permit after a placed call (`keepPermit`); the Infobip event
 * callback releases it when the call ends (permit id stored in
 * call_history.provider_response.channel_permit_id), otherwise it expires
 * after concurrency_hold_seconds. Every other outcome frees it.
 */
type ChannelGate = {
  channel: string;
  admission: Extract<Admission, { ok: true }>;
  keepPermit: boolean;
};

const SEND_CHANNELS = new Set(["sms", "email", "voice"]);

/**
 * I2: admits a claimed item against the channel budget BEFORE the expensive
 * pre-checks (enrollment/journey/player/step reads). When the tenant's bucket
 * is empty the item is handed back with one fenced update and the
 * (tenant, channel) pair is excluded from this run's next claims until the
 * bucket refills, so budget-deferred items neither redo the pre-checks nor
 * fill the batch (the caller gives the claim back to the source).
 * Returns null when the item was deferred.
 */
async function admitClaimedItem(
  row: ClaimedRow,
  channel: string,
  ctx: DispatchContext,
): Promise<ChannelGate | null> {
  const key = `${row.tenant_id}:${channel}`;
  const exhaustedUntil = ctx.exhausted.get(key) ?? 0;
  let retryAfterMs: number;
  if (exhaustedUntil > Date.now()) {
    retryAfterMs = exhaustedUntil - Date.now();
  } else {
    const admission = await channelBudget.acquire(row.tenant_id, channel, {
      deadline: ctx.budget.claimDeadline,
      holder: ctx.workerId,
    });
    if (admission.ok) return { channel, admission, keepPermit: false };
    retryAfterMs = admission.retryAfterMs;
    ctx.exhausted.set(key, Date.now() + Math.max(1_000, retryAfterMs));
  }
  ctx.counters.rateLimited++;
  await release({ id: row.id } as EnrollmentRow, ctx, {
    next_run_at: new Date(Date.now() + Math.max(1_000, retryAfterMs)).toISOString(),
  });
  return null;
}

async function deliverStep(
  enrollment: EnrollmentRow,
  ctx: DispatchContext,
  journey: JourneyRow,
  step: StepRow,
  player: NonNullable<Awaited<ReturnType<typeof playerFor>>>,
  vars: ReturnType<typeof buildPlayerVariables>,
  gate: ChannelGate,
): Promise<void> {
  const channel = step.step_type;
  const reservation = await reserveDelivery(enrollment, step, journey);
  // ENV-02: this step already has a sent execution (e.g. a previous attempt
  // reached the provider but failed before advancing): move on, never resend.
  if (reservation?.blocked_reason === "already_sent") {
    await release(enrollment, ctx, {
      status: "active",
      current_position: step.position + 1,
      next_run_at: new Date().toISOString(),
      attempts: 0,
    });
    await event(enrollment, "step_already_sent", {
      channel,
      step_position: step.position,
      execution_id: reservation.execution_id,
    });
    return;
  }
  if (!reservation?.execution_id || !reservation.idempotency_key) {
    if (reservation?.blocked_reason === "priority_paused") return;
    // D-8: past the per-player daily cap this occurrence gets no message.
    if (reservation?.blocked_reason === "journey_player_daily_cap") {
      await release(enrollment, ctx, {
        status: "exited",
        exited_at: new Date().toISOString(),
        exit_reason: "journey_player_daily_cap",
      });
      await event(enrollment, "exited", {
        reason: "journey_player_daily_cap",
        step_position: step.position,
      });
      return;
    }
    const retryAt = reservation?.retry_at ?? new Date(Date.now() + 60_000).toISOString();
    await release(enrollment, ctx, { status: "waiting", next_run_at: retryAt });
    await event(enrollment, "step_deferred", {
      channel,
      step_position: step.position,
      reason: reservation?.blocked_reason ?? "limit",
    });
    return;
  }
  const run = { id: reservation.execution_id, idempotency_key: reservation.idempotency_key };
  // Failure handling updates exactly this execution (never another worker's).
  ctx.executions.set(enrollment.id, run.id);
  const finalExitReason = await shouldExit(
    enrollment,
    journey.exit_rules ?? {},
    inactivityField(journey),
  );
  if (finalExitReason) {
    await finishExecution(run.id, { status: "skipped", provider: "exit_policy" });
    await release(enrollment, ctx, {
      status: "exited",
      exited_at: new Date().toISOString(),
      exit_reason: finalExitReason,
    });
    await event(enrollment, "exited", { reason: finalExitReason, step_position: step.position });
    return;
  }

  if (step.step_type === "sms") {
    if (await isChannelRevoked(enrollment.tenant_id, "sms", player.telefone ?? "")) {
      await finishExecution(run.id, { status: "skipped", provider: "consent" });
      await release(enrollment, ctx, {
        status: "active",
        current_position: step.position + 1,
        next_run_at: new Date().toISOString(),
        attempts: 0,
      });
      await event(enrollment, "step_skipped", {
        channel,
        step_position: step.position,
        reason: "consent_revoked",
      });
      return;
    }
    const variants = smsVariants(step.config);
    const variantIndex =
      variants.length > 1
        ? pickSmsVariant(
            variants,
            enrollment.entry_key ?? enrollment.id,
            await variantsUsedToday(enrollment),
          )
        : 0;
    const content = renderTemplate(variants[variantIndex], vars);
    const result = await sendSmsInternal({
      to: player.telefone ?? "",
      content,
      playerId: enrollment.player_id,
      tenantId: enrollment.tenant_id,
      triggerName: `journey:${enrollment.journey_id}`,
      linkTrackingOrigin: {
        sourceType: "journey",
        sourceId: enrollment.journey_id,
        journeyStepId: step.id,
        journeyStepPosition: step.position,
        shortDomainId: stepShortDomainId(step.config),
      },
      variables: vars,
      linkTrackingEnabled: step.config.track_links !== false,
      deliveryKey: run.idempotency_key,
    });
    if (!result.ok) throw smsSendError(result);
    await finishExecution(run.id, {
      status: "sent",
      provider: "short-brasil",
      provider_response: variants.length > 1 ? { ...result, variant_index: variantIndex } : result,
    });
  } else if (step.step_type === "email") {
    if (!player.email) throw new Error("Jogador sem e-mail");
    if (await isChannelRevoked(enrollment.tenant_id, "email", player.email)) {
      await finishExecution(run.id, { status: "skipped", provider: "consent" });
      await release(enrollment, ctx, {
        status: "active",
        current_position: step.position + 1,
        next_run_at: new Date().toISOString(),
        attempts: 0,
      });
      await event(enrollment, "step_skipped", {
        channel,
        step_position: step.position,
        reason: "consent_revoked",
      });
      return;
    }
    const templateId = String(step.config.template_id ?? "");
    const snapshot = step.config.template_snapshot as
      { subject?: string; body_html?: string } | undefined;
    const { data: template } =
      snapshot?.subject && snapshot.body_html
        ? { data: { subject: snapshot.subject, body_html: snapshot.body_html } }
        : await supabaseAdmin
            .from("email_templates")
            .select("subject,body_html")
            .eq("id", templateId)
            .eq("tenant_id", enrollment.tenant_id)
            .maybeSingle();
    if (!template) throw new Error("Template de e-mail não encontrado");
    const sender = await resolveSender({
      tenantId: enrollment.tenant_id,
      senderId: String(step.config.sender_id ?? "") || null,
    });
    if (!sender) throw new EmailDomainNotVerifiedError();
    const result = await sendInfobipEmail({
      to: player.email,
      from: sender.fromEmail,
      fromName: sender.fromName,
      replyTo: sender.replyTo,
      subject: renderTemplate(template.subject, vars),
      html: renderTemplate(template.body_html, vars),
      tenantId: enrollment.tenant_id,
      idempotencyKey: run.idempotency_key,
      linkTracking: {
        tenantId: enrollment.tenant_id,
        sourceType: "journey",
        sourceId: enrollment.journey_id,
        recipientPlayerId: enrollment.player_id,
        messageLogType: "email_send_logs",
        enabled: step.config.track_links !== false,
        journeyStepId: step.id,
        journeyStepPosition: step.position,
        shortDomainId: stepShortDomainId(step.config),
      },
    });
    if (!result.ok)
      throw new ProviderSendError({
        channel: "email",
        message: JSON.stringify(result.body),
        status: result.status,
        body: result.body,
        temporary: result.temporary,
        errorKind: result.errorKind ?? null,
      });
    // An already-sent key was logged by the first attempt; do not log twice.
    if (!result.alreadySent) {
      await supabaseAdmin.from("email_send_logs").insert({
        tenant_id: enrollment.tenant_id,
        player_id: enrollment.player_id,
        to_email: player.email,
        subject: renderTemplate(template.subject, vars),
        status: "sent",
        sent_at: new Date().toISOString(),
        provider_response: {
          journey_execution_id: run.id,
          provider: "infobip",
          body: result.body,
          idempotency_key: result.idempotencyKey,
        } as never,
      });
    }
    await finishExecution(run.id, {
      status: "sent",
      provider: "infobip",
      provider_response: result.body,
    });
  } else if (step.step_type === "voice") {
    if (!player.telefone) throw new Error("Jogador sem telefone");
    const contactPolicy = await evaluateVoiceContactPolicy(enrollment.tenant_id, player.telefone);
    if (!contactPolicy.allowed) {
      const consentRevoked = contactPolicy.reason === "consent_revoked";
      await finishExecution(run.id, {
        status: consentRevoked ? "skipped" : "retrying",
        provider: "contact_policy",
        provider_response: {
          suppressed: consentRevoked,
          reason: contactPolicy.reason,
          retry_at: contactPolicy.retryAt,
        },
      });
      await release(enrollment, ctx, {
        status: "active",
        current_position: consentRevoked ? step.position + 1 : step.position,
        next_run_at: contactPolicy.retryAt ?? new Date(Date.now() + 3600_000).toISOString(),
        attempts: consentRevoked ? 0 : enrollment.attempts + 1,
      });
      await event(enrollment, consentRevoked ? "step_skipped" : "step_deferred", {
        channel,
        step_position: step.position,
        reason: contactPolicy.reason,
        retry_at: contactPolicy.retryAt,
      });
      return;
    }
    const assetId = String(step.config.asset_id ?? "");
    const { data: asset } = await db
      .from("journey_voice_assets")
      .select("storage_path")
      .eq("id", assetId)
      .eq("tenant_id", enrollment.tenant_id)
      .maybeSingle();
    if (!asset) throw new Error("Arquivo de áudio da jornada não encontrado");
    const { data: signed, error: signedError } = await supabaseAdmin.storage
      .from("call-audios")
      .createSignedUrl(asset.storage_path, 60 * 60);
    if (signedError || !signed?.signedUrl)
      throw new Error("Não foi possível disponibilizar o áudio para a ligação");
    const to = normalizeE164BR(player.telefone);
    const result = await callInfobipVoice(
      to,
      { type: "audio", audioUrl: signed.signedUrl },
      { idempotencyKey: run.idempotency_key, tenantId: enrollment.tenant_id },
    );
    if (!result.ok)
      throw new ProviderSendError({
        channel: "voice",
        message: `Ligação não aceita pelo provedor: ${JSON.stringify(result.body ?? null).slice(0, 300)}`,
        status: result.status,
        body: result.body,
        errorKind: result.errorKind ?? null,
      });
    // correlation_id is what the voice duplicate check looks up next time.
    if (!result.alreadySent) {
      // The call is ongoing: keep the concurrency permit until the event
      // callback reports the end (I3) or concurrency_hold_seconds elapse.
      gate.keepPermit = Boolean(gate.admission.permitId);
      await supabaseAdmin.from("call_history").insert({
        tenant_id: enrollment.tenant_id,
        lead_id: enrollment.player_id,
        audio_url: signed.signedUrl,
        status: "pending",
        provider: "infobip",
        provider_call_id: result.providerCallId ?? result.idempotencyKey ?? null,
        provider_response: {
          ...(result.body && typeof result.body === "object" && !Array.isArray(result.body)
            ? (result.body as Record<string, unknown>)
            : { body: result.body ?? null }),
          correlation_id: result.idempotencyKey,
          channel_permit_id: gate.keepPermit ? gate.admission.permitId : null,
        } as never,
        provider_status_code: result.status,
        to_phone: to,
      });
    }
    await finishExecution(run.id, {
      status: "sent",
      provider: "infobip",
      provider_response: result,
    });
  } else {
    throw new Error(`Passo ${step.step_type} ainda não está habilitado no dispatcher`);
  }

  await release(enrollment, ctx, {
    status: "active",
    current_position: step.position + 1,
    next_run_at: new Date().toISOString(),
    attempts: 0,
  });
  await event(enrollment, "step_sent", {
    channel,
    step_position: step.position,
    execution_id: run.id,
  });
}

/**
 * sendSmsInternal returns several failure shapes; keep status/body/temporary
 * for the classifier. Local validation failures (no status) and consent
 * suppression (status 200) are permanent.
 */
function smsSendError(result: unknown): ProviderSendError {
  const r = (result ?? {}) as {
    status?: number;
    error?: string;
    body?: unknown;
    temporary?: boolean;
    errorKind?: ProviderSendError["errorKind"];
  };
  return new ProviderSendError({
    channel: "sms",
    message: r.error ?? "SMS não aceito pelo provedor",
    status: typeof r.status === "number" ? r.status : 400,
    body: r.body,
    temporary: r.temporary,
    errorKind: r.errorKind ?? null,
  });
}

type DispatchCounters = {
  processed: number;
  failed: number;
  rescheduled: number;
  rateLimited: number;
  outcomeUnknown: number;
  leaseLost: number;
  /** SMS items held back (no attempt consumed) because the provider breaker is open. */
  providerSuspended: number;
};

/**
 * This run's view of the global SMS provider circuit breaker.
 *   closed : SMS items are sent.
 *   open   : SMS items are not claimed (p_exclude) / handed back untouched.
 *   probe  : this worker holds the half-open probe: exactly ONE SMS item is
 *            sent (probeItem); the others wait for its verdict.
 */
type SmsRunGate = {
  mode: SmsSendGate["mode"];
  holder: string;
  probeItem: string | null;
  heldProbe: boolean;
  retryAt: string | null;
  checkedAt: number;
  /** Tenants of this run's scope, loaded only when SMS must be excluded from claims. */
  tenantIds: string[] | null;
};

type DispatchContext = {
  workerId: string;
  budget: TimeBudget;
  counters: DispatchCounters;
  /** enrollment id -> execution reserved by THIS worker for the current item. */
  executions: Map<string, string>;
  /** `${tenant_id}:${channel}` -> epoch ms until which its budget is exhausted. */
  exhausted: Map<string, number>;
  sms: SmsRunGate;
};

function newSmsRunGate(holder: string): SmsRunGate {
  return {
    mode: "closed",
    holder,
    probeItem: null,
    heldProbe: false,
    retryAt: null,
    checkedAt: 0,
    tenantIds: null,
  };
}

function applySmsGate(ctx: DispatchContext, decision: SmsSendGate) {
  ctx.sms.mode = decision.mode;
  ctx.sms.retryAt = decision.mode === "closed" ? null : decision.snapshot.retryAt;
  ctx.sms.checkedAt = Date.now();
  if (decision.mode === "probe") ctx.sms.heldProbe = true;
}

/** Re-asks the global breaker (another process may have opened/closed it). */
async function refreshSmsGate(ctx: DispatchContext, force = false) {
  // While our probe is in flight its verdict decides; nothing else may send.
  if (ctx.sms.probeItem) return;
  if (!force && Date.now() - ctx.sms.checkedAt < BREAKER_CACHE_MS) return;
  // Claimed before awaiting so concurrent pool slots do not all re-ask at once.
  ctx.sms.checkedAt = Date.now();
  applySmsGate(ctx, await acquireSmsSendGate(ctx.sms.holder));
}

/** SMS must not be sent by this run right now (open, or our single probe is taken). */
function smsBlocked(ctx: DispatchContext): boolean {
  return ctx.sms.mode === "open" || (ctx.sms.mode === "probe" && ctx.sms.probeItem !== null);
}

/** p_exclude keys that keep SMS items out of the claim while SMS is blocked. */
async function smsExcludeKeys(ctx: DispatchContext, scopeTenantIds: string[]): Promise<string[]> {
  if (!smsBlocked(ctx)) return [];
  if (!ctx.sms.tenantIds) {
    if (scopeTenantIds.length) {
      ctx.sms.tenantIds = scopeTenantIds;
    } else {
      const { data, error } = await db.from("tenants").select("id");
      if (error) {
        console.error("[journey dispatcher] tenant list for sms exclusion failed", error.message);
        return [];
      }
      ctx.sms.tenantIds = ((data ?? []) as Array<{ id: string }>).map((row) => row.id);
    }
  }
  return (ctx.sms.tenantIds ?? []).map((tenantId) => `${tenantId}:sms`);
}

/**
 * Admission of one claimed SMS item against the breaker. Returns false when
 * the item was handed back untouched (no attempt, no execution, next_run_at
 * kept); the claim RPC then excludes SMS for the rest of this run.
 */
async function admitSmsItem(row: ClaimedRow, ctx: DispatchContext): Promise<boolean> {
  await refreshSmsGate(ctx);
  if (ctx.sms.mode === "closed") return true;
  if (ctx.sms.mode === "probe" && ctx.sms.probeItem === null) {
    ctx.sms.probeItem = row.id;
    console.warn("[journey dispatcher] sms breaker half-open: probing with one item", {
      enrollmentId: row.id,
      workerId: ctx.workerId,
    });
    return true;
  }
  ctx.counters.providerSuspended++;
  await release({ id: row.id } as EnrollmentRow, ctx, {});
  return false;
}

/** After the probe item: learn the verdict (closed / reopened / still ours). */
async function settleSmsProbe(row: ClaimedRow, ctx: DispatchContext) {
  if (ctx.sms.probeItem !== row.id) return;
  ctx.sms.probeItem = null;
  const snapshot = await readSmsBreaker({ force: true });
  ctx.sms.checkedAt = Date.now();
  if (snapshot.state === "closed") {
    ctx.sms.mode = "closed";
    ctx.sms.retryAt = null;
  } else if (snapshot.state === "open") {
    ctx.sms.mode = "open";
    ctx.sms.retryAt = snapshot.retryAt;
  }
  // Still half_open: the probe never got a provider verdict (exit, consent,
  // per-lead error...): the next SMS item of this run probes instead.
}

/** step_type is the current step's channel (claim RPC since I2; may be absent). */
type ClaimedRow = { id: string; tenant_id: string; step_type?: string | null };

type ProviderDeferrals = { step_position: number; loop_iteration: number; count: number };

/** Consecutive no-cost defers of the enrollment's CURRENT step (resets on a new step/loop). */
function nextNoCostDeferral(enrollment: Record<string, unknown>): ProviderDeferrals {
  const metadata = (enrollment.metadata ?? {}) as Record<string, unknown>;
  const previous = metadata.provider_deferrals as Partial<ProviderDeferrals> | undefined;
  const position = Number(enrollment.current_position ?? 0);
  const loop = Number(enrollment.loop_iteration ?? 0);
  const sameStep = previous?.step_position === position && previous?.loop_iteration === loop;
  return {
    step_position: position,
    loop_iteration: loop,
    count: (sameStep ? Number(previous?.count ?? 0) : 0) + 1,
  };
}

async function retryPolicy(journeyId: string) {
  const { data: retryJourney } = await db
    .from("journeys")
    .select("entry_rules")
    .eq("id", journeyId)
    .maybeSingle();
  return {
    maxAttempts: Math.min(10, Math.max(1, Number(retryJourney?.entry_rules?.max_attempts ?? 3))),
    retryBaseSeconds: Math.min(
      3600,
      Math.max(10, Number(retryJourney?.entry_rules?.retry_base_seconds ?? 60)),
    ),
  };
}

/** Updates only the execution this worker reserved, and only while it is still `claimed`. */
async function finishOwnExecution(
  ctx: DispatchContext,
  enrollmentId: string,
  patch: Record<string, unknown>,
) {
  const executionId = ctx.executions.get(enrollmentId);
  if (!executionId) return;
  await db
    .from("journey_step_executions")
    .update(patch)
    .eq("id", executionId)
    .eq("status", "claimed");
}

/**
 * Error path for one item (B1 / ENV-04):
 * - defer   (provider answered 429/5xx/402...): reschedule WITHOUT consuming an
 *           attempt, at most MAX_NO_COST_DEFERS times in a row per step; after
 *           that every further failure consumes an attempt (never infinite).
 *           Missing credit no longer pauses the tenant channel (I4): the item
 *           just comes back in 15 min, so a recharge resumes sends by itself.
 * - unknown (no response, may have been accepted): possibly sent. The
 *           execution stays `claimed`, so reserve_journey_delivery answers
 *           `in_flight` for 15 min; the item waits 15 min and an attempt is
 *           consumed; at max_attempts the enrollment fails.
 * - fail    : the journey's max_attempts/backoff policy; a misconfigured
 *           provider (missing credentials) is also reported to Sentry.
 */
async function handleItemFailure(row: ClaimedRow, ctx: DispatchContext, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const decision = classifyProviderFailure(error);
  const nowIso = () => new Date().toISOString();
  const { data: enrollmentRaw } = await db
    .from("journey_enrollments")
    .select("*")
    .eq("id", row.id)
    .maybeSingle();
  if (!enrollmentRaw) {
    await finishOwnExecution(ctx, row.id, {
      status: "failed",
      error: message,
      completed_at: nowIso(),
    });
    return;
  }
  const enrollment = enrollmentRaw as EnrollmentRow & Record<string, unknown>;

  if (decision.kind === "provider_account") {
    // The provider refused the ACCOUNT (101/505, 401/402/403): every lead would
    // get the same answer. No attempt consumed, no failure, no defer cap: the
    // item waits for the breaker (sendSmsInternal already reported it).
    ctx.counters.providerSuspended++;
    if (
      error instanceof ProviderSendError &&
      error.channel === "sms" &&
      ctx.sms.probeItem !== row.id
    ) {
      ctx.sms.mode = "open";
      ctx.sms.checkedAt = Date.now();
    }
    const snapshot = cachedSmsBreaker();
    const retryAt = breakerRetryAt(
      snapshot.state === "closed" ? null : snapshot,
      decision.retryAfterMs,
    );
    ctx.sms.retryAt = retryAt;
    await finishOwnExecution(ctx, row.id, {
      status: "retrying",
      error: message.slice(0, 1000),
      completed_at: nowIso(),
    });
    // attempts and provider_deferrals intentionally unchanged.
    await release(enrollment, ctx, { status: "waiting", next_run_at: retryAt });
    await event(enrollment, "step_deferred", {
      reason: decision.reason,
      error: message.slice(0, 500),
      retry_at: retryAt,
      attempt_consumed: false,
    });
    console.warn("[journey dispatcher] provider refused the account; item deferred", {
      enrollmentId: row.id,
      retryAt,
    });
    return;
  }

  if (decision.kind === "defer") {
    const deferrals = nextNoCostDeferral(enrollment);
    if (deferrals.count <= MAX_NO_COST_DEFERS) {
      ctx.counters.rescheduled++;
      const retryAt = new Date(Date.now() + decision.retryAfterMs).toISOString();
      await finishOwnExecution(ctx, row.id, {
        status: "retrying",
        error: message,
        completed_at: nowIso(),
      });
      // attempts intentionally unchanged.
      await release(enrollment, ctx, {
        status: "waiting",
        next_run_at: retryAt,
        metadata: {
          ...((enrollment.metadata ?? {}) as Record<string, unknown>),
          provider_deferrals: deferrals,
        },
      });
      await event(enrollment, "step_deferred", {
        reason: decision.reason,
        error: message.slice(0, 500),
        retry_at: retryAt,
        attempt_consumed: false,
        no_cost_defers: deferrals.count,
      });
      console.warn("[journey dispatcher] provider failure deferred", {
        enrollmentId: row.id,
        reason: decision.reason,
        retryAt,
        noCostDefers: deferrals.count,
      });
      return;
    }
    // Cap reached: from now on the failure costs an attempt (below).
  }

  const policy = await retryPolicy(enrollment.journey_id);
  const attempts = Number(enrollment.attempts ?? 0) + 1;
  const exhausted = attempts >= policy.maxAttempts;

  if (decision.kind === "unknown") {
    ctx.counters.outcomeUnknown++;
    const retryAt = new Date(Date.now() + decision.retryAfterMs).toISOString();
    const detail = `outcome_unknown: ${message}`;
    if (exhausted) {
      ctx.counters.failed++;
      await finishOwnExecution(ctx, row.id, {
        status: "failed",
        error: detail.slice(0, 1000),
        completed_at: nowIso(),
      });
      await release(enrollment, ctx, {
        status: "failed",
        exit_reason: detail.slice(0, 500),
        attempts,
      });
      await event(enrollment, "failed", { error: message, attempts, reason: "outcome_unknown" });
    } else {
      ctx.counters.rescheduled++;
      // The execution stays `claimed` (possibly sent): only the error is recorded.
      await finishOwnExecution(ctx, row.id, { error: detail.slice(0, 1000) });
      await release(enrollment, ctx, { status: "waiting", next_run_at: retryAt, attempts });
      await event(enrollment, "step_outcome_unknown", {
        error: message.slice(0, 500),
        attempts,
        retry_at: retryAt,
        attempt_consumed: true,
      });
    }
    console.warn("[journey dispatcher] provider outcome unknown (possibly sent)", {
      enrollmentId: row.id,
      attempts,
      failed: exhausted,
    });
    return;
  }

  ctx.counters.failed++;
  if (decision.reason === "provider_misconfigured") {
    captureServerException(error, {
      job: "journey_dispatch",
      tenantId: row.tenant_id,
      tags: { reason: decision.reason },
    });
  }
  const retryAt = new Date(
    Date.now() +
      Math.min(6 * 3600_000, policy.retryBaseSeconds * 1000 * 2 ** Math.max(0, attempts - 1)),
  ).toISOString();
  await finishOwnExecution(ctx, row.id, {
    status: "failed",
    error: message,
    completed_at: nowIso(),
  });
  await release(
    enrollment,
    ctx,
    !exhausted
      ? { status: "waiting", next_run_at: retryAt, attempts }
      : { status: "failed", exit_reason: message.slice(0, 500), attempts },
  );
  await event(enrollment, !exhausted ? "retry_scheduled" : "failed", {
    error: message,
    reason: decision.reason,
    attempts,
    retry_at: !exhausted ? retryAt : null,
  });
  console.error("[journey dispatcher] execution failed", {
    enrollmentId: row.id,
    error: message,
  });
}

function exhaustedKeys(ctx: DispatchContext): string[] {
  const now = Date.now();
  const keys: string[] = [];
  for (const [key, until] of ctx.exhausted) {
    if (until > now) keys.push(key);
    else ctx.exhausted.delete(key);
  }
  return keys;
}

export async function runJourneyDispatcher(limit = 100) {
  const run = await startJobRun("journey_dispatch", { channel: "journey", kind: "tick" });
  try {
    return await runJourneyDispatcherMonitored(limit, run);
  } catch (error) {
    await run.fail(error);
    throw error;
  }
}

async function runJourneyDispatcherMonitored(limit: number, run: JobRunHandle) {
  // A cron may be installed before the final operational acceptance. The
  // dispatcher itself remains fail-closed until the platform enables it.
  if (process.env.JOURNEYS_DISPATCH_ENABLED !== "true") {
    await run.finish({ stop_reason: "disabled" });
    return { enrolled: 0, claimed: 0, processed: 0, failed: 0, disabled: true };
  }
  const scope = resolveJourneyWorkerScope();
  if (!scope.allowed) {
    await run.finish({ stop_reason: "canary_scope_required" });
    return {
      enrolled: 0,
      claimed: 0,
      processed: 0,
      failed: 0,
      disabled: true,
      reason: "canary_scope_required",
    };
  }

  // ENV-01: explicit leases, a per-run time budget, at most N concurrent runs
  // and a continuous concurrency pool. Sizing: src/lib/rate-limit/worker-config.ts.
  const config = resolveDispatchWorkerConfig("JOURNEYS_DISPATCH");
  const dispatchLimit = Math.max(1, Math.min(limit, config.batchSize));
  const workerId = `journey-dispatcher:${crypto.randomUUID()}`;
  const budget = createTimeBudget({
    claimMs: config.timeBudgetMs,
    hardMs: config.hardDeadlineMs,
  });

  const { data: slot, error: slotError } = await db.rpc("acquire_journey_dispatcher_slot", {
    p_holder: workerId,
    p_max_slots: config.maxWorkers,
    p_lease_seconds: config.leaseSeconds,
  });
  if (slotError) throw new Error(slotError.message);
  if (slot === null || slot === undefined) {
    // Every slot is held (e.g. the previous tick is still finishing in-flight items).
    await run.finish({ stop_reason: "busy" });
    return { enrolled: 0, claimed: 0, processed: 0, failed: 0, busy: true };
  }

  const ctx: DispatchContext = {
    workerId,
    budget,
    counters: {
      processed: 0,
      failed: 0,
      rescheduled: 0,
      rateLimited: 0,
      outcomeUnknown: 0,
      leaseLost: 0,
      providerSuspended: 0,
    },
    executions: new Map(),
    exhausted: new Map(),
    sms: newSmsRunGate(workerId),
  };
  const owned = new Set<string>();
  let keeper: LeaseKeeper | null = null;
  let source: ClaimingSource<ClaimedRow> | null = null;
  let hardTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    // Demo tenants are never claimed (claim_journey_enrollments_leased skips
    // them), so they are not counted as queued work either.
    const demoTenantIds = await listDemoTenantIds();
    let queueQuery = db
      .from("journey_enrollments")
      .select("id", { count: "exact", head: true })
      .in("status", ["active", "waiting"])
      .lte("next_run_at", new Date().toISOString());
    if (demoTenantIds.length > 0) {
      queueQuery = queueQuery.not("tenant_id", "in", `(${demoTenantIds.join(",")})`);
    }
    const { count: queueBefore } = await queueQuery;
    // Lease-based since 20261015110000: only expired leases are recovered.
    const { error: recoveryError } = await db.rpc("recover_orphaned_journey_claims");
    if (recoveryError) throw new Error(recoveryError.message);
    const { error: resumeError } = await db.rpc("resume_priority_paused_journeys", {
      p_limit: limit,
    });
    if (resumeError) throw new Error(resumeError.message);
    // Exit rules of every open enrollment (deposit, band change, archived
    // journey, no contact) are applied here, so a category switch ends the old
    // journey within a cycle instead of at its next step (S-01, S-02, F-2).
    // Best effort: never blocks the dispatch.
    const { error: sweepError } = await db.rpc("sweep_journey_exits", { p_limit: 1000 });
    if (sweepError) console.error("[journeys] exit sweep failed", sweepError.message);
    run.progress({ queue_before: queueBefore ?? 0 });
    // Global SMS provider breaker: while open, SMS items are not claimed.
    await refreshSmsGate(ctx, true);

    keeper = startLeaseKeeper({
      intervalMs: config.renewIntervalMs,
      renew: async () => {
        const { data, error } = await db.rpc("renew_journey_dispatch_leases", {
          p_worker_id: workerId,
          p_slot: slot,
          p_ids: [...owned],
          p_lease_seconds: config.leaseSeconds,
        });
        if (error) throw new Error(error.message);
        const renewal = (Array.isArray(data) ? data[0] : data) as {
          slot_held?: boolean;
          lost_ids?: string[];
        } | null;
        const lost = (renewal?.lost_ids ?? []).filter((id) => owned.has(id));
        if (!renewal?.slot_held || lost.length) {
          console.warn("[journey dispatcher] lease renewal incomplete", {
            workerId,
            slotHeld: Boolean(renewal?.slot_held),
            lost: lost.length,
          });
        }
      },
      onError: (error) =>
        console.error("[journey dispatcher] lease renewal failed", {
          workerId,
          error: error instanceof Error ? error.message : String(error),
        }),
    });

    const claimingSource = createClaimingSource<ClaimedRow>({
      chunkSize: config.claimChunk,
      maxItems: dispatchLimit,
      canClaim: budget.canClaim,
      claim: async (count) => {
        for (;;) {
          // I2: (tenant, channel) pairs whose budget is exhausted right now,
          // plus every (tenant, sms) pair while the SMS provider breaker blocks.
          const budgetExclude = exhaustedKeys(ctx);
          const exclude = [...budgetExclude, ...(await smsExcludeKeys(ctx, scope.tenantIds))];
          const { data, error } = await db.rpc("claim_journey_enrollments_leased", {
            p_limit: count,
            p_worker_id: workerId,
            p_lease_seconds: config.leaseSeconds,
            p_tenant_ids: scope.tenantIds,
            p_journey_ids: scope.journeyIds,
            p_exclude: exclude,
          });
          if (error) throw new Error(error.message);
          const rows = (data ?? []) as ClaimedRow[];
          for (const row of rows) owned.add(row.id);
          if (rows.length || !budgetExclude.length || !budget.canClaim()) return rows;
          // Only budget-limited work is due: wait for the earliest refill
          // instead of ending the run as "queue_empty".
          const wakeAt = Math.min(...ctx.exhausted.values());
          await sleep(Math.max(50, Math.min(wakeAt - Date.now(), budget.claimRemainingMs())));
        }
      },
    });
    source = claimingSource;

    const progress = () =>
      run.progress({
        claimed: claimingSource.claimed,
        sent: ctx.counters.processed,
        errors: ctx.counters.failed,
        rescheduled: ctx.counters.rescheduled,
        rate_limited: ctx.counters.rateLimited,
      });
    const pool = runBoundedPool<ClaimedRow>({
      concurrency: config.concurrency,
      next: () => claimingSource.next(),
      handle: async (row) => {
        let gate: ChannelGate | null = null;
        try {
          const channel = row.step_type && SEND_CHANNELS.has(row.step_type) ? row.step_type : null;
          if (channel === "sms" && !(await admitSmsItem(row, ctx))) {
            // Provider breaker open: handed back untouched, not part of the batch.
            claimingSource.giveBack();
            return;
          }
          if (channel) {
            gate = await admitClaimedItem(row, channel, ctx);
            if (!gate) {
              // Budget-deferred: does not count toward the batch size.
              claimingSource.giveBack();
              return;
            }
          }
          await executeEnrollment(row.id, ctx, gate);
          ctx.counters.processed++;
        } catch (error) {
          await handleItemFailure(row, ctx, error);
        } finally {
          await settleSmsProbe(row, ctx);
          if (gate && !gate.keepPermit) await channelBudget.release(gate.admission);
          owned.delete(row.id);
          ctx.executions.delete(row.id);
          progress();
        }
      },
      onError: (error, row) =>
        console.error("[journey dispatcher] failure handling failed", {
          enrollmentId: row.id,
          error: error instanceof Error ? error.message : String(error),
        }),
    });
    // A hung provider call must not hold the run (and its slot) forever.
    const hardDeadline = new Promise<"hard_deadline">((resolve) => {
      hardTimer = setTimeout(() => resolve("hard_deadline"), budget.hardRemainingMs());
    });
    pool.catch(() => undefined);
    const outcome = await Promise.race([pool.then(() => "done" as const), hardDeadline]);

    const stopReason =
      outcome === "hard_deadline"
        ? "hard_deadline"
        : ctx.sms.mode !== "closed" &&
            (ctx.sms.mode === "open" || ctx.counters.providerSuspended > 0)
          ? "provider_unavailable"
          : claimingSource.claimed === 0
            ? "queue_empty"
            : claimingSource.stopReason;
    await run.finish({
      queue_before: queueBefore ?? 0,
      claimed: claimingSource.claimed,
      sent: ctx.counters.processed,
      errors: ctx.counters.failed,
      rescheduled: ctx.counters.rescheduled,
      rate_limited: ctx.counters.rateLimited,
      stop_reason: stopReason,
    });
    // Eligibility discovery is intentionally handled by journey-scan. Keeping
    // this compatibility field avoids breaking existing cron diagnostics.
    return {
      enrolled: 0,
      claimed: claimingSource.claimed,
      processed: ctx.counters.processed,
      failed: ctx.counters.failed,
      rescheduled: ctx.counters.rescheduled,
      rateLimited: ctx.counters.rateLimited,
      outcomeUnknown: ctx.counters.outcomeUnknown,
      leaseLost: ctx.counters.leaseLost,
      providerSuspended: ctx.counters.providerSuspended,
      smsBreaker: ctx.sms.mode,
      stopReason,
      scannerSeparated: true,
    };
  } finally {
    if (hardTimer) clearTimeout(hardTimer);
    // Claimed but never started (time budget over): hand back immediately.
    const unstarted = source?.drainUnstarted() ?? [];
    if (unstarted.length) {
      const { error } = await db.rpc("release_journey_enrollment_claims", {
        p_worker_id: workerId,
        p_ids: unstarted.map((row) => row.id),
      });
      if (error) {
        console.error("[journey dispatcher] release of unstarted claims failed", {
          workerId,
          count: unstarted.length,
          error: error.message,
        });
      }
      for (const row of unstarted) owned.delete(row.id);
    }
    await keeper?.stop();
    // A probe we took but never resolved goes back so the next worker can probe.
    if (ctx.sms.heldProbe && ctx.sms.mode === "probe") await releaseSmsProbe(workerId);
    const { error: slotReleaseError } = await db.rpc("release_journey_dispatcher_slot", {
      p_slot: slot,
      p_holder: workerId,
    });
    if (slotReleaseError) {
      console.error("[journey dispatcher] slot release failed", {
        workerId,
        error: slotReleaseError.message,
      });
    }
  }
}
