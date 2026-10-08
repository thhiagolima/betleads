import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sendInfobipEmail, resolveSender } from "./email-send.server";
import { callInfobipVoice, normalizeE164BR } from "./infobip-voice.server";
import { sendSmsInternal } from "./sms.functions";
import { buildPlayerVariables, renderTemplate } from "./template-vars.server";
import { detectTriggersForPlayer } from "./triggers.server";
import { evaluateVoiceContactPolicy, isChannelRevoked } from "./consent.server";
import {
  journeyEntryKey,
  nextJourneyWindowOpen,
  qualifiesForInactivity,
  triggerOccurrence,
} from "./journey-policy";

export { nextJourneyWindowOpen } from "./journey-policy";

type JourneyRow = {
  id: string;
  status: string;
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

async function enrollEligibleJourneyPlayers(limit = 500) {
  const { data: journeys } = await db
    .from("journeys")
    .select("*")
    .eq("status", "active")
    .limit(100);
  if (!journeys?.length) return 0;
  const { data: players } = await supabaseAdmin
    .from("players")
    .select("*")
    .eq("status", "ativo")
    .limit(limit);
  let enrolled = 0;
  for (const journey of journeys as Array<
    JourneyRow & {
      tenant_id: string;
      trigger_type: string;
      trigger_config: Record<string, unknown>;
      version: number;
      entry_rules: Record<string, unknown>;
    }
  >) {
    // Jornadas manuais só podem receber matrículas por uma API auditada. Até
    // essa API existir, o worker nunca pode transformar uma entrada manual em
    // uma varredura automática da base.
    if (journey.trigger_type === "manual") continue;
    for (const player of players ?? []) {
      if (player.tenant_id !== journey.tenant_id) continue;
      const audience = String(journey.entry_rules?.audience ?? "all_active");
      if (audience === "vip" && !player.vip) continue;
      if (audience === "manual") continue;
      const matches =
        journey.trigger_type === "inactivity"
          ? qualifiesForInactivity(player as Record<string, unknown>, journey.trigger_config ?? {})
          : detectTriggersForPlayer(player as never).includes(journey.trigger_type as never);
      if (!matches) continue;
      if (journey.entry_rules?.reentry === "after_cooldown") {
        const hours = Math.max(
          1,
          Number(journey.entry_rules.reentry_cooldown_hours ?? journey.cooldown_hours ?? 24),
        );
        const { data: previous } = await db
          .from("journey_enrollments")
          .select("created_at")
          .eq("journey_id", journey.id)
          .eq("player_id", player.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (previous && Date.parse(previous.created_at) > Date.now() - hours * 3600_000) continue;
      }
      const occurrence = triggerOccurrence(
        journey.trigger_type,
        player as Record<string, unknown>,
        journey.trigger_config ?? {},
      );
      const { error } = await db.from("journey_enrollments").insert({
        tenant_id: journey.tenant_id,
        journey_id: journey.id,
        journey_version: journey.version,
        player_id: player.id,
        entry_key: journeyEntryKey(
          journey.trigger_type,
          journey.entry_rules ?? {},
          String(occurrence),
        ),
        metadata: {
          trigger: journey.trigger_type,
          deposited_before_entry: Number(player.total_depositado ?? 0),
        },
      });
      if (!error) enrolled++;
    }
  }
  return enrolled;
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

async function release(enrollment: EnrollmentRow, patch: Record<string, unknown>) {
  const { error } = await db
    .from("journey_enrollments")
    .update({ ...patch, claimed_at: null, claimed_by: null })
    .eq("id", enrollment.id);
  if (error) throw new Error(error.message);
}

async function shouldExit(
  enrollment: EnrollmentRow,
  rules: Record<string, boolean>,
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
  return null;
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
  const { data, error } = await db.rpc("reserve_journey_delivery", {
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

async function executeEnrollment(id: string): Promise<void> {
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
    .select("id,status,exit_rules,entry_rules,daily_limit,cooldown_hours")
    .eq("id", enrollment.journey_id)
    .maybeSingle();
  const journey = journeyRaw as JourneyRow | null;
  if (!journey || journey.status !== "active") {
    await release(enrollment, { status: "paused" });
    return;
  }
  const nextOpen = nextJourneyWindowOpen(journey.entry_rules ?? {});
  if (nextOpen) {
    await release(enrollment, { status: "waiting", next_run_at: nextOpen });
    await event(enrollment, "deferred_outside_window", { next_run_at: nextOpen });
    return;
  }
  const exitReason = await shouldExit(enrollment, journey.exit_rules ?? {});
  if (exitReason) {
    await release(enrollment, {
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
    await release(enrollment, {
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
    await release(enrollment, {
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
    await release(enrollment, {
      status: "completed",
      completed_at: new Date().toISOString(),
      exit_reason: "end_step",
    });
    await event(enrollment, "completed", { step_position: step.position });
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
    await release(enrollment, {
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
  const reservation = await reserveDelivery(enrollment, step, journey);
  if (!reservation?.execution_id || !reservation.idempotency_key) {
    const retryAt = reservation?.retry_at ?? new Date(Date.now() + 60_000).toISOString();
    await release(enrollment, { status: "waiting", next_run_at: retryAt });
    await event(enrollment, "step_deferred", {
      channel,
      step_position: step.position,
      reason: reservation?.blocked_reason ?? "limit",
    });
    return;
  }
  const run = { id: reservation.execution_id, idempotency_key: reservation.idempotency_key };
  const finalExitReason = await shouldExit(enrollment, journey.exit_rules ?? {});
  if (finalExitReason) {
    await finishExecution(run.id, { status: "skipped", provider: "exit_policy" });
    await release(enrollment, {
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
      await release(enrollment, {
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
    const content = renderTemplate(String(step.config.content ?? ""), vars);
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
      },
      variables: vars,
      linkTrackingEnabled: step.config.track_links !== false,
      deliveryKey: run.idempotency_key,
    });
    if (!result.ok) throw new Error(result.error ?? "SMS não aceito pelo provedor");
    await finishExecution(run.id, {
      status: "sent",
      provider: "short-brasil",
      provider_response: result,
    });
  } else if (step.step_type === "email") {
    if (!player.email) throw new Error("Jogador sem e-mail");
    if (await isChannelRevoked(enrollment.tenant_id, "email", player.email)) {
      await finishExecution(run.id, { status: "skipped", provider: "consent" });
      await release(enrollment, {
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
    const sender = await resolveSender(
      String(step.config.sender_id ?? "") || null,
      enrollment.tenant_id,
    );
    if (!sender) throw new Error("Remetente de e-mail não configurado");
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
      },
    });
    if (!result.ok) throw new Error(JSON.stringify(result.body));
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
      await release(enrollment, {
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
    const result = await callInfobipVoice(to, signed.signedUrl);
    if (!result.ok) throw new Error("Ligação não aceita pelo provedor");
    await supabaseAdmin.from("call_history").insert({
      tenant_id: enrollment.tenant_id,
      lead_id: enrollment.player_id,
      audio_url: signed.signedUrl,
      status: "pending",
      provider: "infobip",
      provider_call_id: result.providerCallId ?? result.idempotencyKey ?? null,
      provider_response: (result.body ?? {}) as never,
      provider_status_code: result.status,
      to_phone: to,
    });
    await finishExecution(run.id, {
      status: "sent",
      provider: "infobip",
      provider_response: result,
    });
  } else {
    throw new Error(`Passo ${step.step_type} ainda não está habilitado no dispatcher`);
  }

  await release(enrollment, {
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

export async function runJourneyDispatcher(limit = 100) {
  // A cron may be installed before the final operational acceptance. The
  // dispatcher itself remains fail-closed until the platform enables it.
  if (process.env.JOURNEYS_DISPATCH_ENABLED !== "true") {
    return { enrolled: 0, claimed: 0, processed: 0, failed: 0, disabled: true };
  }
  const { error: recoveryError } = await db.rpc("recover_orphaned_journey_claims");
  if (recoveryError) throw new Error(recoveryError.message);
  const enrolled = await enrollEligibleJourneyPlayers(limit);
  const { data: claimed, error } = await db.rpc("claim_due_journey_enrollments", {
    p_limit: limit,
  });
  if (error) throw new Error(error.message);
  let processed = 0;
  let failed = 0;
  for (const row of (claimed ?? []) as Array<{ id: string }>) {
    try {
      await executeEnrollment(row.id);
      processed++;
    } catch (error) {
      failed++;
      const message = error instanceof Error ? error.message : String(error);
      const { data: enrollment } = await db
        .from("journey_enrollments")
        .select("*")
        .eq("id", row.id)
        .maybeSingle();
      if (enrollment) {
        const attempts = Number(enrollment.attempts ?? 0) + 1;
        const { data: retryJourney } = await db
          .from("journeys")
          .select("entry_rules")
          .eq("id", enrollment.journey_id)
          .maybeSingle();
        const maxAttempts = Math.min(
          10,
          Math.max(1, Number(retryJourney?.entry_rules?.max_attempts ?? 3)),
        );
        const retryBaseSeconds = Math.min(
          3600,
          Math.max(10, Number(retryJourney?.entry_rules?.retry_base_seconds ?? 60)),
        );
        const retryAt = new Date(
          Date.now() +
            Math.min(6 * 3600_000, retryBaseSeconds * 1000 * 2 ** Math.max(0, attempts - 1)),
        ).toISOString();
        await db
          .from("journey_step_executions")
          .update({
            status: "failed",
            error: message,
            completed_at: new Date().toISOString(),
          })
          .eq("enrollment_id", row.id)
          .eq("status", "claimed");
        await release(
          enrollment as EnrollmentRow,
          attempts < maxAttempts
            ? { status: "waiting", next_run_at: retryAt, attempts }
            : { status: "failed", exit_reason: message.slice(0, 500), attempts },
        );
        await event(
          enrollment as EnrollmentRow,
          attempts < maxAttempts ? "retry_scheduled" : "failed",
          {
            error: message,
            attempts,
            retry_at: attempts < maxAttempts ? retryAt : null,
          },
        );
      }
      console.error("[journey dispatcher] execution failed", {
        enrollmentId: row.id,
        error: message,
      });
    }
  }
  return { enrolled, claimed: (claimed ?? []).length, processed, failed };
}
