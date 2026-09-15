// Dispatcher do módulo Pré-ligação WhatsApp.
// Loop simples chamado por cron a cada minuto. Não compartilha estado com o
// dispatcher de automações.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sendFlowBlock } from "./whatsapp-send.server";
import { buildPlayerVariables, renderTemplate } from "./template-vars.server";
import { randomDelaySeconds } from "./precall.server";

export async function runPrecallDispatcher(): Promise<{
  campaigns: number;
  sent: number;
  failed: number;
}> {
  const { data: campaigns } = await supabaseAdmin
    .from("precall_campaigns")
    .select("id, tenant_id, session_id, delay_min_seconds, delay_max_seconds, status")
    .eq("status", "rodando");

  let sent = 0;
  let failed = 0;

  for (const camp of campaigns ?? []) {
    if (!camp.session_id) continue;

    // 1 lead por campanha por ciclo — o delay aleatório já regula a velocidade.
    const { data: lead } = await supabaseAdmin
      .from("precall_leads")
      .select("id, player_id, telefone_e164")
      .eq("campaign_id", camp.id)
      .eq("status", "pendente")
      .lte("scheduled_at", new Date().toISOString())
      .order("scheduled_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (!lead) {
      // se não há mais pendentes, conclui
      const { count } = await supabaseAdmin
        .from("precall_leads")
        .select("id", { count: "exact", head: true })
        .eq("campaign_id", camp.id)
        .eq("status", "pendente");
      if ((count ?? 0) === 0) {
        await supabaseAdmin
          .from("precall_campaigns")
          .update({ status: "concluida" })
          .eq("id", camp.id);
      }
      continue;
    }

    // Sessão precisa estar conectada
    const { data: session } = await supabaseAdmin
      .from("whatsapp_sessions")
      .select("id, instance_name, name, status")
      .eq("id", camp.session_id)
      .maybeSingle();
    if (!session || session.status !== "connected") continue;

    // Anti-duplicação: já recebeu mensagem desta MESMA campanha?
    // (a UNIQUE(campaign_id, player_id) já garante 1 row por player)
    // Player info para variáveis
    const { data: player } = await supabaseAdmin
      .from("players")
      .select("id, nome, telefone, saldo_carteira, ultimo_login, ultimo_jogo, ultimo_deposito, total_depositado, total_sacado, vip, status, expert, risco")
      .eq("id", lead.player_id ?? "00000000-0000-0000-0000-000000000000")
      .maybeSingle();

    // Escolhe template aleatório
    const { data: templates } = await supabaseAdmin
      .from("precall_templates")
      .select("id, content")
      .eq("campaign_id", camp.id);
    if (!templates || templates.length === 0) {
      await supabaseAdmin
        .from("precall_leads")
        .update({ status: "falhou", error: "sem templates cadastrados" })
        .eq("id", lead.id);
      failed++;
      continue;
    }
    const tpl = templates[Math.floor(Math.random() * templates.length)];
    const vars = buildPlayerVariables(player ?? { nome: null });
    // Fallback seguro: se {primeiro_nome} vazio
    if (!vars.primeiro_nome || vars.primeiro_nome === "amigo") {
      vars.primeiro_nome = "tudo bem";
    }
    const mensagem = renderTemplate(tpl.content, vars);

    try {
      await sendFlowBlock(
        {
          id: tpl.id,
          block_type: "text",
          content: mensagem,
          caption: null,
          media_url: null,
          media_mimetype: null,
          media_filename: null,
          delay_seconds: 0,
        },
        { phone_e164: lead.telefone_e164, player_id: lead.player_id },
        {
          id: session.id,
          instance_name: session.instance_name,
          name: session.name,
          status: session.status,
        },
      );

      await supabaseAdmin
        .from("precall_leads")
        .update({
          status: "enviado",
          sent_at: new Date().toISOString(),
          template_id_used: tpl.id,
          mensagem_enviada: mensagem,
          error: null,
        })
        .eq("id", lead.id);

      // Atualiza contadores da campanha
      const { data: cnt } = await supabaseAdmin
        .from("precall_leads")
        .select("status")
        .eq("campaign_id", camp.id);
      const totals = (cnt ?? []).reduce(
        (a, r) => {
          if (r.status === "enviado" || r.status === "respondido" || r.status === "ligar_agora" || r.status === "ligado" || r.status === "sem_resposta")
            a.enviados++;
          if (r.status === "respondido" || r.status === "ligar_agora" || r.status === "ligado")
            a.respondidos++;
          if (r.status === "falhou") a.falhas++;
          if (r.status === "ligado") a.ligacoes++;
          return a;
        },
        { enviados: 0, respondidos: 0, falhas: 0, ligacoes: 0 },
      );
      await supabaseAdmin
        .from("precall_campaigns")
        .update({
          enviados: totals.enviados,
          respondidos: totals.respondidos,
          falhas: totals.falhas,
          ligacoes_feitas: totals.ligacoes,
        })
        .eq("id", camp.id);

      // Agenda o PRÓXIMO pendente da campanha com delay aleatório
      const nextDelay = randomDelaySeconds(
        camp.delay_min_seconds ?? 60,
        camp.delay_max_seconds ?? 180,
      );
      const nextAt = new Date(Date.now() + nextDelay * 1000).toISOString();
      const { data: nextLead } = await supabaseAdmin
        .from("precall_leads")
        .select("id")
        .eq("campaign_id", camp.id)
        .eq("status", "pendente")
        .order("scheduled_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (nextLead) {
        await supabaseAdmin
          .from("precall_leads")
          .update({ scheduled_at: nextAt })
          .eq("id", nextLead.id);
      }
      sent++;
    } catch (e: any) {
      await supabaseAdmin
        .from("precall_leads")
        .update({ status: "falhou", error: String(e?.message ?? e).slice(0, 500) })
        .eq("id", lead.id);
      failed++;
    }
  }

  return { campaigns: campaigns?.length ?? 0, sent, failed };
}

/**
 * Detecta resposta inbound de um lead em campanha precall.
 * Chamado pelo webhook Evolution quando uma mensagem inbound chega.
 * Marca o lead como 'ligar_agora' se houver pré-call enviado nas últimas 48h.
 */
export async function detectPrecallResponse(
  phone: string,
  text: string | null,
): Promise<void> {
  if (!phone) return;
  const cutoff = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const { data: leads } = await supabaseAdmin
    .from("precall_leads")
    .select("id, campaign_id")
    .eq("telefone_e164", phone)
    .eq("status", "enviado")
    .gte("sent_at", cutoff)
    .limit(5);
  if (!leads || leads.length === 0) return;

  for (const l of leads) {
    await supabaseAdmin
      .from("precall_leads")
      .update({
        status: "ligar_agora",
        responded_at: new Date().toISOString(),
        resposta_texto: (text ?? "").slice(0, 1000),
      })
      .eq("id", l.id);

    // bump campaign counter
    const { count: respCount } = await supabaseAdmin
      .from("precall_leads")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", l.campaign_id)
      .in("status", ["respondido", "ligar_agora", "ligado"]);
    await supabaseAdmin
      .from("precall_campaigns")
      .update({ respondidos: respCount ?? 0 })
      .eq("id", l.campaign_id);
  }
}