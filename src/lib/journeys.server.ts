import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { callBusinessCodeEmail, resolveSender } from "./email-send.server";
import { callBusinessCodeVoice } from "./businesscode-voice.server";
import { callInfobipVoice } from "./infobip-voice.server";
import { sendSmsInternal } from "./sms.functions";
import { buildPlayerVariables, renderTemplate } from "./template-vars.server";

type JourneyRow = {
  id: string;
  status: string;
  exit_rules: Record<string, boolean>;
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
    .select("id,status,exit_rules")
    .eq("id", enrollment.journey_id)
    .maybeSingle();
  const journey = journeyRaw as JourneyRow | null;
  if (!journey || journey.status !== "active") {
    await release(enrollment, { status: "paused" });
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
  const run = await execution(enrollment, step, channel);

  if (step.step_type === "sms") {
    const content = renderTemplate(String(step.config.content ?? ""), vars);
    const result = await sendSmsInternal({
      to: player.telefone ?? "",
      content,
      playerId: enrollment.player_id,
      tenantId: enrollment.tenant_id,
      triggerName: `journey:${enrollment.journey_id}`,
      variables: vars,
    });
    if (!result.ok) throw new Error(result.error ?? "SMS não aceito pelo provedor");
    await finishExecution(run.id, {
      status: "sent",
      provider: "short-brasil",
      provider_response: result,
    });
  } else if (step.step_type === "email") {
    if (!player.email) throw new Error("Jogador sem e-mail");
    const templateId = String(step.config.template_id ?? "");
    const { data: template } = await supabaseAdmin
      .from("email_templates")
      .select("subject,body_html")
      .eq("id", templateId)
      .maybeSingle();
    if (!template) throw new Error("Template de e-mail não encontrado");
    const sender = await resolveSender(
      String(step.config.sender_id ?? "") || null,
      enrollment.tenant_id,
    );
    if (!sender) throw new Error("Remetente de e-mail não configurado");
    const result = await callBusinessCodeEmail({
      to: player.email,
      from: sender.fromEmail,
      fromName: sender.fromName,
      replyTo: sender.replyTo,
      subject: renderTemplate(template.subject, vars),
      html: renderTemplate(template.body_html, vars),
      idempotencyKey: run.idempotency_key,
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
      } as never,
    });
    await finishExecution(run.id, {
      status: "sent",
      provider: process.env.EMAIL_PROVIDER ?? "businesscode",
      provider_response: result.body,
    });
  } else if (step.step_type === "voice") {
    if (!player.telefone) throw new Error("Jogador sem telefone");
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
    const result =
      process.env.VOICE_PROVIDER?.toLowerCase() === "infobip"
        ? await callInfobipVoice(player.telefone, signed.signedUrl)
        : await callBusinessCodeVoice(player.telefone, signed.signedUrl);
    if (!result.ok) throw new Error("Ligação não aceita pelo provedor");
    await finishExecution(run.id, {
      status: "sent",
      provider:
        process.env.VOICE_PROVIDER?.toLowerCase() === "infobip" ? "infobip" : "businesscode",
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
        await db
          .from("journey_step_executions")
          .update({
            status: "failed",
            error: message,
            completed_at: new Date().toISOString(),
          })
          .eq("enrollment_id", row.id)
          .eq("status", "claimed");
        await release(enrollment as EnrollmentRow, {
          status: "failed",
          exit_reason: message.slice(0, 500),
          attempts: Number(enrollment.attempts ?? 0) + 1,
        });
        await event(enrollment as EnrollmentRow, "failed", { error: message });
      }
      console.error("[journey dispatcher] execution failed", {
        enrollmentId: row.id,
        error: message,
      });
    }
  }
  return { claimed: (claimed ?? []).length, processed, failed };
}
