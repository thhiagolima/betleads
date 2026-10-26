// Corpo do envio de voz em massa ("Disparar agora"), só do servidor.
// Fica fora de calls.functions.ts porque aquele arquivo também entra no
// bundle do navegador: uma função exportada fora de um handler arrastaria
// calls.server.ts (node:crypto) para o client e quebraria o build.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runVoiceQueueDispatcher, VOICE_INSUFFICIENT_BALANCE_MESSAGE } from "./calls.server";
import { resolveOperationalTenantId } from "./tenant-access.server";
import type { BulkDispatchCallsInput } from "./calls.functions";

/** Targets left out after the house ran out of balance in "Disparar agora". */
const VOICE_NOT_ATTEMPTED_MESSAGE = "Não tentado: saldo insuficiente";

/** Body of `bulkDispatchCalls` (the `*For` convention keeps it unit testable). */
export async function bulkDispatchCallsFor(
  supabase: SupabaseClient<Database>,
  data: BulkDispatchCallsInput,
) {
  const tenantId = await resolveOperationalTenantId(supabase);
  const scheduledAt = data.scheduled_at ? new Date(data.scheduled_at) : null;
  if (scheduledAt && !Number.isFinite(scheduledAt.getTime())) {
    throw new Error("Data de agendamento de voz inválida.");
  }
  const isScheduled = Boolean(scheduledAt && scheduledAt.getTime() > Date.now());
  let fixedAudioUrl: string | null = null;
  if (data.asset_id) {
    const { data: asset, error: assetError } = await (supabaseAdmin as any)
      .from("journey_voice_assets")
      .select("storage_path, is_archived")
      .eq("id", data.asset_id)
      .eq("tenant_id", tenantId)
      .single();
    if (assetError || !asset || asset.is_archived)
      throw new Error("Áudio fixo não está disponível na biblioteca.");
    const { data: signed, error: signedError } = await supabaseAdmin.storage
      .from("call-audios")
      .createSignedUrl(asset.storage_path, 3600);
    if (signedError || !signed?.signedUrl)
      throw new Error(signedError?.message ?? "Não foi possível preparar o áudio fixo.");
    fixedAudioUrl = signed.signedUrl;
  }
  const results: Array<{
    ok: boolean;
    lead_id: string | null;
    phone: string | null;
    error?: string;
    not_attempted?: boolean;
  }> = [];
  let queued = 0;
  let pending = 0;
  let failed = 0;
  let notAttempted = 0;

  for (let index = 0; index < data.targets.length; index++) {
    const target = data.targets[index];
    let queueId: string | null = null;
    try {
      // 1. cria item na fila
      const { data: q, error: qErr } = await supabase
        .from("call_queue")
        .insert({
          lead_id: target.lead_id ?? null,
          script_id: data.script_id ?? null,
          voice_asset_id: data.asset_id ?? null,
          trigger_name: data.campaign_name ?? null,
          phone_number: target.phone_number ?? null,
          scheduled_at: scheduledAt?.toISOString() ?? new Date().toISOString(),
          status: "pending_audio",
        })
        .select("id")
        .single();
      if (qErr) throw new Error(qErr.message);
      queueId = q.id;

      // Scripts são sintetizados pela Infobip quando a chamada é atendida.
      // Arquivos da biblioteca continuam usando URL assinada e a ação CML `play`.
      await supabase
        .from("call_queue")
        .update({
          status: "audio_ready",
          audio_generation_id: null,
          audio_url: fixedAudioUrl,
        })
        .eq("id", q.id);

      if (isScheduled) {
        pending += 1;
        results.push({
          ok: true,
          lead_id: target.lead_id ?? null,
          phone: target.phone_number ?? null,
        });
        continue;
      }

      // 4. dispara
      const dispatchResult = await runVoiceQueueDispatcher(1, q.id);
      if (dispatchResult.insufficientBalance > 0) {
        // The queue dispatcher keeps a refused item ready (pushed 15 min),
        // but a "Disparar agora" call must never be dialed by surprise after
        // a later top-up (Ruling final-2): only here it is failed with
        // saldo_insuficiente. Scheduled queue items keep waiting.
        const { error: failError } = await supabase
          .from("call_queue")
          .update({
            status: "failed",
            provider_status: "saldo_insuficiente",
            provider_response: { error: VOICE_INSUFFICIENT_BALANCE_MESSAGE } as any,
          } as any)
          .eq("id", q.id);
        if (failError) {
          console.error("[calls] could not fail a dispatch-now item without balance", {
            queueId: q.id,
            error: failError.message,
          });
        }
        failed += 1;
        results.push({
          ok: false,
          lead_id: target.lead_id ?? null,
          phone: target.phone_number ?? null,
          error: VOICE_INSUFFICIENT_BALANCE_MESSAGE,
        });
        // PG3: the house's wallet is empty, so every next target would be
        // refused too. Stop here; the rest is reported, never queued.
        for (const rest of data.targets.slice(index + 1)) {
          notAttempted += 1;
          results.push({
            ok: false,
            lead_id: rest.lead_id ?? null,
            phone: rest.phone_number ?? null,
            error: VOICE_NOT_ATTEMPTED_MESSAGE,
            not_attempted: true,
          });
        }
        break;
      }
      if (dispatchResult.failed > 0) {
        throw new Error(
          "Não foi possível concluir o envio de voz. Consulte o histórico para os detalhes.",
        );
      }
      if (dispatchResult.deferred > 0) {
        pending += 1;
        results.push({
          ok: true,
          lead_id: target.lead_id ?? null,
          phone: target.phone_number ?? null,
          error: "Ligação adiada pela política de contato ou disponibilidade do provedor.",
        });
      } else {
        queued += 1;
        results.push({
          ok: true,
          lead_id: target.lead_id ?? null,
          phone: target.phone_number ?? null,
        });
      }
    } catch (err) {
      failed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      // Registra a falha no item criado para que a fila não o apresente
      // como se estivesse aguardando o provedor.
      if (queueId) {
        await supabase
          .from("call_queue")
          .update({
            status: "failed",
            provider_status: "dispatch_preparation_failed",
            provider_response: { stage: "dispatch_preparation", error: msg } as any,
          } as any)
          .eq("id", queueId);
      }
      results.push({
        ok: false,
        lead_id: target.lead_id ?? null,
        phone: target.phone_number ?? null,
        error: msg,
      });
    }
  }

  console.log(
    `[calls] bulk dispatch: total=${data.targets.length} ok=${queued} fail=${failed} not_attempted=${notAttempted}`,
  );
  return {
    total: data.targets.length,
    queued,
    pending,
    failed,
    notAttempted,
    scheduled: isScheduled,
    results,
  };
}
