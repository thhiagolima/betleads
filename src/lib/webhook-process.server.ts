import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function getServiceClient(): SupabaseClient | null {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !secretKey) return null;
  return createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false },
  });
}

export async function processWebhookEvent(
  sb: SupabaseClient,
  tenantId: string,
  evento: string,
  payload: Record<string, unknown>,
  options: { mirror?: boolean; existingLogId?: string } = { mirror: true },
): Promise<Response> {
  let logId = options.existingLogId;
  let receiptClaimed = false;
  let receiptEventId: string | null = null;
  if (!logId) {
    const { data: logRow, error: logError } = await sb
      .from("webhook_logs")
      .insert({ evento, payload, status: "recebido", tenant_id: tenantId })
      .select("id")
      .single();
    if (logError) {
      return Response.json(
        { ok: false, evento, error: `Falha ao registrar webhook: ${logError.message}` },
        { status: 503 },
      );
    }
    logId = logRow?.id as string | undefined;
  }

  const markLog = async (status: string, extra?: Record<string, unknown>) => {
    if (logId) {
      await sb
        .from("webhook_logs")
        .update({
          status,
          ...(extra ? { payload: { ...payload, _processing: extra } } : {}),
        })
        .eq("id", logId);
    }

    if (!receiptClaimed || !receiptEventId) return;
    if (status === "processado" || status === "sem_player") {
      await sb
        .from("webhook_event_receipts")
        .update({ status: "completed", completed_at: new Date().toISOString(), last_error: null })
        .eq("tenant_id", tenantId)
        .eq("provider_event_id", receiptEventId);
    }
    if (status === "erro") {
      await sb
        .from("webhook_event_receipts")
        .update({
          status: "failed",
          last_error: String(extra?.error ?? extra?.step ?? "processing_error").slice(0, 1000),
        })
        .eq("tenant_id", tenantId)
        .eq("provider_event_id", receiptEventId);
    }
  };

  try {
    const data = (payload.data ?? payload.player ?? payload.user ?? payload) as Record<
      string,
      unknown
    >;
    const eventIso = resolveEventTimestamp(evento, payload, data);
    // Carrega o modelo de CRM do tenant uma única vez — usado para gatear
    // enrollments automáticos. CRM_EXPERT só aceita entrada via
    // `lead_cadastrado`; demais gatilhos (cashback, segmentos, alertas)
    // são ignorados dentro do CRM Expert.
    const { data: tenantRow } = await sb
      .from("tenants")
      .select("crm_model")
      .eq("id", tenantId)
      .maybeSingle();
    const tenantCrmModel = (tenantRow?.crm_model as string | null) ?? null;
    const isExpertTenant = tenantCrmModel === "CRM_EXPERT";
    const tracking = asRecord(data.tracking);
    const signupAttribution = asRecord(data.signupAttribution ?? data.signup_attribution);
    const subject = asRecord(payload.subject);
    const utm = resolveUtm(data, tracking, signupAttribution);
    const affiliate = asRecord(data.affiliate);
    const affiliateId =
      firstString(
        affiliate.referredBy,
        affiliate.affiliate_id,
        data.affiliate_id,
        data.axioAffId,
        data.axio_aff_id,
      ) ?? null;

    let expertNome: string | null = null;
    if (affiliateId) {
      const { data: exp } = await sb
        .from("experts")
        .select("nome")
        .eq("affiliate_id", affiliateId)
        .eq("tenant_id", tenantId)
        .maybeSingle();
      expertNome = exp?.nome ?? null;
    }

    const externalId = resolveExternalId(evento, payload, data);
    const signupEvent = isSignupEvent(evento, payload);

    const rawValor = data.amount ?? data.valor ?? payload.amount ?? payload.valor;
    const valor = rawValor != null ? Math.abs(Number(rawValor)) || null : null;

    const nome =
      firstString(
        data.fullName,
        data.full_name,
        data.nome,
        data.name,
        asRecord(data.profile).name,
        asRecord(data.user).name,
        asRecord(data.player).name,
      ) ?? "Novo player";
    const email =
      firstString(
        data.email,
        asRecord(data.profile).email,
        asRecord(data.user).email,
        asRecord(data.player).email,
      ) ?? null;
    const telefone =
      firstString(
        data.phone,
        data.telefone,
        data.mobile,
        data.whatsapp,
        asRecord(data.profile).phone,
        asRecord(data.user).phone,
        asRecord(data.player).phone,
      ) ?? null;
    const origem =
      firstString(
        tracking.landing_page,
        tracking.referer,
        data.origem,
        utm.utm_source,
        signupAttribution.fbclid ? "fb" : undefined,
      ) ?? null;
    const metodo =
      firstString(data.paymentMethod, data.methodCode, data.metodo, data.method) ?? null;
    const transactionId =
      firstString(
        data.transactionId,
        data.transaction_id,
        data.referenceId,
        data.operationId,
        subject.type === "payment_transaction" ? subject.id : undefined,
        payload.eventId,
        payload.event_id,
        payload.deliveryId,
      ) ?? null;
    const providerEventId =
      firstString(payload.eventId, payload.event_id, data.eventId, data.event_id) ?? null;
    const providerStatus = firstString(data.status, payload.status) ?? null;

    if (providerEventId) {
      const { data: claimed, error: claimError } = await sb.rpc("claim_webhook_event", {
        p_tenant_id: tenantId,
        p_provider_event_id: providerEventId,
        p_event_name: evento,
      });
      if (claimError) {
        await markLog("erro", { step: "claim_webhook_event", error: claimError.message });
        return Response.json({ ok: false, evento, error: claimError.message }, { status: 503 });
      }
      if (!claimed) {
        await markLog("duplicado", { provider_event_id: providerEventId });
        return Response.json({ ok: true, evento, duplicate: true });
      }
      receiptClaimed = true;
      receiptEventId = providerEventId;
    }

    let playerId: string | null = null;

    if (externalId) {
      const { data: existing, error: existingError } = await sb
        .from("players")
        .select("id")
        .eq("player_external_id", externalId)
        .eq("tenant_id", tenantId)
        .maybeSingle();
      if (existingError) {
        await markLog("erro", { step: "find_player", error: existingError.message });
        return Response.json({ ok: false, evento, error: existingError.message }, { status: 200 });
      }

      if (existing) {
        playerId = existing.id;
      } else {
        const { data: created, error: createError } = await sb
          .from("players")
          .insert({
            nome,
            email,
            telefone,
            origem,
            ...utm,
            player_external_id: externalId,
            status: "ativo",
            affiliate_id: affiliateId,
            expert: expertNome,
            tenant_id: tenantId,
            created_at: eventIso,
            updated_at: eventIso,
          })
          .select("id")
          .single();
        playerId = created?.id ?? null;
        // Cadastro, login e evento financeiro podem chegar simultaneamente.
        // Se outro request criou o player entre o SELECT e o INSERT, recupera
        // a linha vencedora em vez de classificar o evento como sem_player.
        if (createError) {
          const { data: concurrentPlayer, error: retryError } = await sb
            .from("players")
            .select("id")
            .eq("player_external_id", externalId)
            .eq("tenant_id", tenantId)
            .maybeSingle();
          playerId = concurrentPlayer?.id ?? null;
          if (!playerId) {
            await markLog("erro", {
              step: "create_player",
              error: createError.message,
              retry_error: retryError?.message,
            });
            return Response.json(
              { ok: false, evento, error: createError.message },
              { status: 200 },
            );
          }
        }
      }
    }

    if (playerId) {
      const now = new Date().toISOString();
      const updates: Record<string, unknown> = { updated_at: now };

      if (utm.utm_source) updates.utm_source = utm.utm_source;
      if (utm.utm_medium) updates.utm_medium = utm.utm_medium;
      if (utm.utm_campaign) updates.utm_campaign = utm.utm_campaign;
      if (utm.utm_content) updates.utm_content = utm.utm_content;
      if (utm.utm_term) updates.utm_term = utm.utm_term;
      if (utm.utm_id) updates.utm_id = utm.utm_id;
      if (origem) updates.origem = origem;

      if (affiliateId) {
        const { data: cur } = await sb
          .from("players")
          .select("affiliate_id, expert")
          .eq("id", playerId)
          .single();
        if (!cur?.affiliate_id) updates.affiliate_id = affiliateId;
        if (!cur?.expert && expertNome) updates.expert = expertNome;
      }

      // CPF completo só chega nos eventos de saque PIX (pixData.keyValue).
      // O campo `document` do cadastro vem mascarado (146.***.**49-6*) e é ignorado.
      const cpfFromPayload = extractCpf(data);
      if (cpfFromPayload) {
        const { data: curCpf } = await sb
          .from("players")
          .select("cpf")
          .eq("id", playerId)
          .maybeSingle();
        if (!curCpf?.cpf) updates.cpf = cpfFromPayload;
      }

      const ACTIVITY_EVENTS = new Set([
        "login",
        "jogo-iniciado",
        "deposito-pendente",
        "deposito-aprovado",
        "deposito-falhou",
        "saque-pendente",
        "saque-aprovado",
        "saque-concluido",
        "saque-falhou",
      ]);
      if (ACTIVITY_EVENTS.has(evento)) updates.ultimo_login = eventIso;
      if (evento === "jogo-iniciado") updates.ultimo_jogo = eventIso;

      const financialEvent = resolveFinancialEvent(evento);
      if (financialEvent && valor) {
        if (!transactionId) {
          await markLog("erro", {
            step: "financial_transaction",
            error: "missing_transaction_id",
            provider_event: payload.event,
          });
          return Response.json(
            { ok: false, evento, error: "ID da transação não encontrado" },
            { status: 200 },
          );
        }
        const { error: financialError } = await sb.rpc("record_financial_webhook_event", {
          p_tenant_id: tenantId,
          p_player_id: playerId,
          p_kind: financialEvent.kind,
          p_external_id: transactionId,
          p_event_id: providerEventId,
          p_amount: valor,
          p_status: financialEvent.status,
          p_provider_status: providerStatus,
          p_method: metodo,
          p_event_at: eventIso,
          p_payload: payload,
        });
        if (financialError) {
          await markLog("erro", {
            step: "record_financial_transaction",
            kind: financialEvent.kind,
            status: financialEvent.status,
            error: financialError.message,
          });
          return Response.json(
            { ok: false, evento, error: financialError.message },
            { status: 200 },
          );
        }
      }

      if (evento === "cashback-pago" && valor) {
        const eventIdRaw =
          (payload.event_id as string | undefined) ??
          (data.event_id as string | undefined) ??
          (data.id as string | undefined) ??
          null;
        const campaign =
          (data.campaign as string | undefined) ?? (payload.campaign as string | undefined) ?? null;
        const cashbackStatus =
          (data.status as string | undefined) ?? (payload.status as string | undefined) ?? "paid";
        const currency =
          (data.currency as string | undefined) ??
          (payload.currency as string | undefined) ??
          "BRL";
        const paidAtRaw =
          (data.paid_at as string | undefined) ?? (payload.paid_at as string | undefined) ?? now;
        const paidAt = (() => {
          const t = Date.parse(paidAtRaw);
          return Number.isNaN(t) ? now : new Date(t).toISOString();
        })();

        const { error: cbErr } = await sb.from("cashback_payments").insert({
          tenant_id: tenantId,
          player_id: playerId,
          platform_user_id: externalId ?? null,
          nome,
          telefone,
          email,
          cashback_amount: valor,
          currency,
          paid_at: paidAt,
          campaign,
          status: cashbackStatus,
          event_id: eventIdRaw,
          raw_payload: payload,
        });
        if (cbErr && cbErr.code !== "23505") {
          await markLog("erro", { step: "insert_cashback", error: cbErr.message });
          return Response.json({ ok: false, evento, error: cbErr.message }, { status: 200 });
        }
        if (!cbErr && !isExpertTenant) {
          // Atualiza agregados no player (idempotente para duplicados graças ao 23505 acima).
          updates.last_cashback_paid_at = paidAt;
          updates.last_cashback_amount = valor;
          const { data: curCb } = await sb
            .from("players")
            .select("total_cashback_paid")
            .eq("id", playerId)
            .single();
          updates.total_cashback_paid =
            Number((curCb as { total_cashback_paid?: number } | null)?.total_cashback_paid ?? 0) +
            valor;

          // Contato de contingência: a casa nem sempre envia telefone/email no
          // evento de cashback. Nesse caso usamos os dados já cadastrados no
          // próprio lead — sem isso o disparo imediato era sempre pulado.
          let cbPhone: string | null = telefone;
          let cbEmail: string | null = email;
          if (!cbPhone || !cbEmail) {
            const { data: contato } = await sb
              .from("players")
              .select("telefone, email")
              .eq("id", playerId)
              .maybeSingle();
            if (!cbPhone) cbPhone = (contato?.telefone as string | null) ?? null;
            if (!cbEmail) cbEmail = (contato?.email as string | null) ?? null;
          }

          // Disparo imediato: enfileira o player nos fluxos de SMS com
          // gatilho `cashback_pago` para este tenant. Idempotente — pula
          // se já houver enrollment pending/running ativo.
          const phoneDigits = cbPhone ? cbPhone.replace(/\D/g, "") : "";
          if (phoneDigits.length >= 10) {
            const { data: cbFlows } = await sb
              .from("sms_flows")
              .select("id")
              .eq("tenant_id", tenantId)
              .eq("trigger_name", "cashback_pago")
              .eq("is_active", true);
            for (const f of cbFlows ?? []) {
              // Existe índice único (flow_id, player_id): um lead que já passou
              // por este fluxo antes NÃO pode ser inserido de novo. Nesse caso
              // reiniciamos a inscrição existente.
              const { data: existing } = await sb
                .from("sms_flow_leads")
                .select("id, status")
                .eq("flow_id", f.id)
                .eq("player_id", playerId)
                .maybeSingle();
              if (existing && ["pending", "running"].includes(existing.status as string)) continue;
              // Prioridade máxima: next_run_at em 1970 garante que o claim
              // (ORDER BY next_run_at ASC) pegue este lead antes de qualquer
              // outro pendente da fila normal.
              const priorityAt = new Date(0).toISOString();
              if (existing) {
                const { error: rErr } = await sb
                  .from("sms_flow_leads")
                  .update({
                    tenant_id: tenantId,
                    phone_e164: phoneDigits,
                    status: "pending",
                    current_step_index: 0,
                    next_run_at: priorityAt,
                  })
                  .eq("id", existing.id);
                if (rErr)
                  await markLog("erro", { step: "reenroll_sms_cashback", error: rErr.message });
              } else {
                const { error: iErr } = await sb.from("sms_flow_leads").insert({
                  tenant_id: tenantId,
                  flow_id: f.id,
                  player_id: playerId,
                  phone_e164: phoneDigits,
                  status: "pending",
                  current_step_index: 0,
                  next_run_at: priorityAt,
                });
                if (iErr)
                  await markLog("erro", { step: "enroll_sms_cashback", error: iErr.message });
              }
            }
          }

          // Enfileira o player nos fluxos de EMAIL com gatilho `cashback_pago`.
          // Idempotente: a inserção do cashback_payments já deduplica por event_id /
          // chave natural, então este bloco só roda em eventos novos. Mesmo assim,
          // ainda pulamos se houver enrollment pending/running ativo no mesmo fluxo.
          if (cbEmail) {
            const { data: cbEmailFlows } = await sb
              .from("email_flows")
              .select("id")
              .eq("tenant_id", tenantId)
              .eq("trigger_type", "cashback_pago")
              .eq("active", true);
            for (const f of cbEmailFlows ?? []) {
              const { data: existing } = await sb
                .from("email_flow_leads")
                .select("id, status")
                .eq("flow_id", f.id)
                .eq("player_id", playerId)
                .order("created_at", { ascending: false })
                .limit(1)
                .maybeSingle();
              if (existing && ["pending", "running"].includes(existing.status as string)) continue;
              // Prioridade máxima: ver comentário no bloco de SMS acima.
              const priorityAt = new Date(0).toISOString();
              if (existing) {
                const { error: rErr } = await sb
                  .from("email_flow_leads")
                  .update({
                    tenant_id: tenantId,
                    email: cbEmail,
                    status: "pending",
                    current_block_index: 0,
                    next_run_at: priorityAt,
                  })
                  .eq("id", existing.id);
                if (rErr)
                  await markLog("erro", { step: "reenroll_email_cashback", error: rErr.message });
              } else {
                const { error: iErr } = await sb.from("email_flow_leads").insert({
                  tenant_id: tenantId,
                  flow_id: f.id,
                  player_id: playerId,
                  email: cbEmail,
                  status: "pending",
                  current_block_index: 0,
                  next_run_at: priorityAt,
                });
                if (iErr)
                  await markLog("erro", { step: "enroll_email_cashback", error: iErr.message });
              }
            }
          }
        } else if (!cbErr && isExpertTenant) {
          // No CRM Expert ainda atualizamos os agregados de cashback, mas
          // NÃO enfileiramos em fluxos — a única entrada permitida é
          // `lead_cadastrado`.
          updates.last_cashback_paid_at = paidAt;
          updates.last_cashback_amount = valor;
          const { data: curCb } = await sb
            .from("players")
            .select("total_cashback_paid")
            .eq("id", playerId)
            .single();
          updates.total_cashback_paid =
            Number((curCb as { total_cashback_paid?: number } | null)?.total_cashback_paid ?? 0) +
            valor;
        }
      }

      const { error: playerUpdateError } = await sb
        .from("players")
        .update(updates)
        .eq("id", playerId)
        .eq("tenant_id", tenantId);
      if (playerUpdateError) {
        await markLog("erro", { step: "update_player", error: playerUpdateError.message });
        return Response.json(
          { ok: false, evento, error: playerUpdateError.message },
          { status: 200 },
        );
      }
      if (signupEvent) {
        await savePlayerAttribution(sb, {
          tenantId,
          playerId,
          payload,
          data,
          tracking,
          signupAttribution,
          utm,
          capturedAt: eventIso,
        });
      }

      if (evento === "login") {
        let sessionExists = false;
        if (providerEventId) {
          const { data: existingSession, error: existingSessionError } = await sb
            .from("sessions")
            .select("id")
            .eq("tenant_id", tenantId)
            .eq("provider_event_id", providerEventId)
            .maybeSingle();
          if (existingSessionError) {
            await markLog("erro", { step: "find_session", error: existingSessionError.message });
            return Response.json(
              { ok: false, evento, error: existingSessionError.message },
              { status: 200 },
            );
          }
          sessionExists = !!existingSession;
        }
        if (!sessionExists) {
          const { error: sessionInsertError } = await sb.from("sessions").upsert(
            {
              tenant_id: tenantId,
              player_id: playerId,
              iniciado_em: eventIso,
              provider_event_id: providerEventId,
            },
            { onConflict: "tenant_id,provider_event_id", ignoreDuplicates: true },
          );
          if (sessionInsertError) {
            await markLog("erro", { step: "insert_session", error: sessionInsertError.message });
            return Response.json(
              { ok: false, evento, error: sessionInsertError.message },
              { status: 200 },
            );
          }
        }
      } else if (evento === "logout") {
        const { data: openSession, error: openSessionError } = await sb
          .from("sessions")
          .select("id,iniciado_em")
          .eq("tenant_id", tenantId)
          .eq("player_id", playerId)
          .is("encerrado_em", null)
          .order("iniciado_em", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (openSessionError) {
          await markLog("erro", { step: "find_open_session", error: openSessionError.message });
          return Response.json(
            { ok: false, evento, error: openSessionError.message },
            { status: 200 },
          );
        }
        if (openSession) {
          const duration = Math.max(
            0,
            Math.floor(
              (new Date(eventIso).getTime() - new Date(openSession.iniciado_em).getTime()) / 1000,
            ),
          );
          const { error: closeSessionError } = await sb
            .from("sessions")
            .update({ encerrado_em: eventIso, duracao_segundos: duration })
            .eq("id", openSession.id)
            .eq("tenant_id", tenantId);
          if (closeSessionError) {
            await markLog("erro", { step: "close_session", error: closeSessionError.message });
            return Response.json(
              { ok: false, evento, error: closeSessionError.message },
              { status: 200 },
            );
          }
        }
      }

      let eventExists = false;
      if (providerEventId) {
        const { data: existingEvent, error: existingEventError } = await sb
          .from("events")
          .select("id")
          .eq("tenant_id", tenantId)
          .eq("provider_event_id", providerEventId)
          .maybeSingle();
        if (existingEventError) {
          await markLog("erro", { step: "find_event", error: existingEventError.message });
          return Response.json(
            { ok: false, evento, error: existingEventError.message },
            { status: 200 },
          );
        }
        eventExists = !!existingEvent;
      }
      if (!eventExists) {
        const { error: eventInsertError } = await sb.from("events").upsert(
          {
            player_id: playerId,
            tipo: evento,
            valor,
            metadata: payload,
            tenant_id: tenantId,
            provider_event_id: providerEventId,
            created_at: eventIso,
          },
          { onConflict: "tenant_id,provider_event_id", ignoreDuplicates: true },
        );
        if (eventInsertError) {
          await markLog("erro", { step: "insert_event", error: eventInsertError.message });
          return Response.json(
            { ok: false, evento, error: eventInsertError.message },
            { status: 200 },
          );
        }
      }

      // Entrada principal do CRM EXPERT: ao receber um cadastro de lead
      // pertencente ao expert (já validado pelo espelhamento via
      // affiliate_id), enfileira o player em todos os fluxos ativos de
      // SMS, Email e Ligações com gatilho `lead_cadastrado` deste tenant.
      // Idempotente: pula se já existe enrollment pending/running/active.
      if (isExpertTenant && signupEvent) {
        const phoneDigits = telefone ? telefone.replace(/\D/g, "") : "";
        // SMS
        if (phoneDigits.length >= 10) {
          const { data: smsFlows } = await sb
            .from("sms_flows")
            .select("id")
            .eq("tenant_id", tenantId)
            .eq("trigger_name", "lead_cadastrado")
            .eq("is_active", true);
          for (const f of smsFlows ?? []) {
            const { count: active } = await sb
              .from("sms_flow_leads")
              .select("id", { count: "exact", head: true })
              .eq("tenant_id", tenantId)
              .eq("flow_id", f.id)
              .eq("player_id", playerId)
              .in("status", ["pending", "running"]);
            if ((active ?? 0) > 0) continue;
            // Se o fluxo tem passos com horário fixo (CRM_EXPERT funil diário),
            // calcula entered_at = 00:00 BRT do dia base e next_run_at = horário
            // do primeiro SMS desse dia. Regra: se já passou do horário do
            // primeiro SMS, começa no dia seguinte (sem catch-up).
            const { data: firstStep } = await sb
              .from("sms_flow_steps")
              .select("scheduled_time, scheduled_day_offset")
              .eq("flow_id", f.id)
              .eq("step_type", "sms")
              .order("order_index", { ascending: true })
              .limit(1)
              .maybeSingle();
            let enteredAtIso = new Date().toISOString();
            let nextRunIso = enteredAtIso;
            if (firstStep?.scheduled_time && typeof firstStep.scheduled_day_offset === "number") {
              const now = new Date();
              // wall-clock BRT (UTC-3)
              const brtNow = new Date(now.getTime() - 3 * 3_600_000);
              const y = brtNow.getUTCFullYear();
              const mo = brtNow.getUTCMonth();
              const d = brtNow.getUTCDate();
              const [hhStr, mmStr] = firstStep.scheduled_time.split(":");
              const hh = Number(hhStr);
              const mm = Number(mmStr);
              const todayFirst = Date.UTC(y, mo, d, hh + 3, mm, 0, 0);
              const startOffset = firstStep.scheduled_day_offset ?? 0;
              // Se já passou o horário do primeiro SMS hoje, base_day = amanhã.
              const baseShift = now.getTime() > todayFirst ? 1 : 0;
              const baseDay = d + baseShift - startOffset;
              enteredAtIso = new Date(Date.UTC(y, mo, baseDay, 3, 0, 0, 0)).toISOString();
              nextRunIso = new Date(Date.UTC(y, mo, d + baseShift, hh + 3, mm, 0, 0)).toISOString();
            }
            await sb.from("sms_flow_leads").insert({
              tenant_id: tenantId,
              flow_id: f.id,
              player_id: playerId,
              phone_e164: phoneDigits,
              status: "pending",
              current_step_index: 0,
              entered_at: enteredAtIso,
              next_run_at: nextRunIso,
            });
          }
        }
        // Email
        if (email) {
          const { data: emailFlows } = await sb
            .from("email_flows")
            .select("id")
            .eq("tenant_id", tenantId)
            .eq("trigger_type", "lead_cadastrado")
            .eq("active", true);
          for (const f of emailFlows ?? []) {
            const { count: active } = await sb
              .from("email_flow_leads")
              .select("id", { count: "exact", head: true })
              .eq("tenant_id", tenantId)
              .eq("flow_id", f.id)
              .eq("player_id", playerId)
              .in("status", ["pending", "running"]);
            if ((active ?? 0) > 0) continue;
            await sb.from("email_flow_leads").insert({
              tenant_id: tenantId,
              flow_id: f.id,
              player_id: playerId,
              email,
              status: "pending",
              current_block_index: 0,
              next_run_at: new Date().toISOString(),
            });
          }
        }
        // Ligações
        if (phoneDigits.length >= 10) {
          const { data: callFlows } = await sb
            .from("call_flows")
            .select("id")
            .eq("tenant_id", tenantId)
            .eq("trigger_name", "lead_cadastrado")
            .eq("is_active", true);
          for (const f of callFlows ?? []) {
            const { count: active } = await sb
              .from("call_flow_progress")
              .select("id", { count: "exact", head: true })
              .eq("tenant_id", tenantId)
              .eq("flow_id", f.id)
              .eq("player_id", playerId)
              .eq("status", "active");
            if ((active ?? 0) > 0) continue;
            await sb.from("call_flow_progress").insert({
              tenant_id: tenantId,
              flow_id: f.id,
              player_id: playerId,
              phone_e164: phoneDigits,
              status: "active",
              current_block_index: 0,
              next_run_at: new Date().toISOString(),
            });
          }
        }
      }
    }

    if (!playerId) {
      await markLog("sem_player", {
        step: "resolve_player",
        reason: externalId ? "external_id_without_player" : "missing_external_id",
        provider_event: payload.event,
        subject_type: subject.type,
        subject_id: subject.id,
        data_keys: Object.keys(data).slice(0, 40),
        expected_any_of: [
          "data.userId",
          "data.external_id",
          "data.id",
          "payload.user_id",
          "payload.player_id",
          "payload.subject.id for auth.signup.success",
        ],
      });
      return Response.json({ ok: true, evento, ignored: true, reason: "sem_player" });
    }

    await markLog("processado");

    // Espelhamento para CRMs Expert.
    // Quando um evento chega no tenant principal (CRM_PLATAFORMA) e o
    // affiliate_id do lead está na allowlist de algum tenant CRM_EXPERT,
    // o mesmo evento é reprocessado nesse tenant — assim o CRM Expert
    // só recebe leads dele e ignora todo o resto automaticamente.
    if (options.mirror !== false) {
      try {
        const data2 = (payload.data ?? payload.player ?? payload.user ?? payload) as Record<
          string,
          unknown
        >;
        const aff = asRecord(data2.affiliate);
        let affId =
          firstString(
            aff.referredBy,
            aff.affiliate_id,
            data2.affiliate_id,
            data2.axioAffId,
            data2.axio_aff_id,
          ) ?? null;
        if (typeof affId === "string") affId = affId.trim() || null;
        // Fallback: eventos financeiros (deposito-aprovado, saque-*, cashback-pago,
        // jogo-iniciado, logout) normalmente NÃO trazem o bloco `affiliate` no
        // payload — só vem `userId`. Sem affiliate_id o mirror não dispara e
        // o CRM Expert nunca recebe esses eventos. Resolve via lookup do player
        // no tenant de origem usando qualquer um dos IDs externos disponíveis.
        if (!affId) {
          const candidates = [
            data2.userId,
            data2.external_id,
            (data2 as { user_id?: unknown }).user_id,
            data2.id,
            payload.user_id,
            payload.player_id,
            payload.userId,
            payload.external_id,
          ]
            .map((v) => (typeof v === "string" ? v.trim() : v))
            .filter((v): v is string => typeof v === "string" && v.length > 0);
          for (const ext of candidates) {
            const { data: playerRow } = await sb
              .from("players")
              .select("affiliate_id")
              .eq("tenant_id", tenantId)
              .eq("player_external_id", ext)
              .maybeSingle();
            const found = (playerRow?.affiliate_id as string | undefined) ?? null;
            if (found && found.trim().length > 0) {
              affId = found.trim();
              break;
            }
          }
          if (!affId) {
            console.warn("[webhook] mirror skipped — no affiliate_id resolved", {
              tenantId,
              evento,
              externalCandidates: candidates,
            });
          }
        }
        if (affId) {
          const { data: experts } = await sb
            .from("tenants")
            .select("id, metadata, crm_model")
            .eq("crm_model", "CRM_EXPERT");
          for (const t of experts ?? []) {
            if (t.id === tenantId) continue;
            const rawIds =
              ((t.metadata as { expert_affiliate_ids?: unknown } | null)
                ?.expert_affiliate_ids as unknown) ?? [];
            const ids = Array.isArray(rawIds)
              ? rawIds
                  .map((v) => (typeof v === "string" ? v.trim() : ""))
                  .filter((v) => v.length > 0)
              : [];
            if (ids.includes(affId)) {
              await processWebhookEvent(sb, t.id as string, evento, payload, {
                mirror: false,
              });
            }
          }
        }
      } catch (mirrorErr) {
        console.error("[webhook] mirror to CRM_EXPERT failed", mirrorErr);
      }
    }

    return Response.json({ ok: true, evento });
  } catch (e) {
    await markLog("erro", { step: "exception", error: String(e) });
    return Response.json({ ok: false, evento, error: String(e) }, { status: 200 });
  }
}

// Valida CPF (11 dígitos + dígitos verificadores). Rejeita máscaras/parciais.
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringFrom(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = stringFrom(value);
    if (normalized) return normalized;
  }
  return undefined;
}

function isSignupEvent(evento: string, payload: Record<string, unknown>): boolean {
  return evento === "cadastro" || stringFrom(payload.event) === "auth.signup.success";
}

function resolveFinancialEvent(
  evento: string,
): { kind: "deposit" | "withdrawal"; status: "pendente" | "aprovado" | "falhou" } | null {
  switch (evento) {
    case "deposito-pendente":
      return { kind: "deposit", status: "pendente" };
    case "deposito-aprovado":
      return { kind: "deposit", status: "aprovado" };
    case "deposito-falhou":
      return { kind: "deposit", status: "falhou" };
    case "saque-pendente":
      return { kind: "withdrawal", status: "pendente" };
    case "saque-aprovado":
    case "saque-concluido":
      return { kind: "withdrawal", status: "aprovado" };
    case "saque-falhou":
      return { kind: "withdrawal", status: "falhou" };
    default:
      return null;
  }
}

function resolveExternalId(
  evento: string,
  payload: Record<string, unknown>,
  data: Record<string, unknown>,
): string | undefined {
  const user = asRecord(data.user);
  const player = asRecord(data.player);
  const profile = asRecord(data.profile);
  const subject = asRecord(payload.subject);

  const direct = firstString(
    data.userId,
    data.user_id,
    data.external_id,
    data.player_external_id,
    data.playerId,
    data.player_id,
    data.customerId,
    data.customer_id,
    data.id,
    user.id,
    user.userId,
    user.external_id,
    player.id,
    player.userId,
    player.external_id,
    profile.id,
    payload.userId,
    payload.user_id,
    payload.playerId,
    payload.player_id,
    payload.external_id,
  );
  if (direct) return direct;

  const providerEvent = stringFrom(payload.event);
  const subjectType = stringFrom(subject.type);
  const subjectId = stringFrom(subject.id);
  if (
    isSignupEvent(evento, payload) &&
    providerEvent === "auth.signup.success" &&
    subjectType === "session" &&
    subjectId
  ) {
    return `session:${subjectId}`;
  }
  if (["user", "player", "account", "customer"].includes(subjectType ?? "") && subjectId) {
    return subjectId;
  }
  return undefined;
}

function resolveUtm(
  data: Record<string, unknown>,
  tracking: Record<string, unknown>,
  signupAttribution: Record<string, unknown>,
): {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  utm_id: string | null;
} {
  return {
    utm_source:
      firstString(
        data.utm_source,
        data.utmSource,
        tracking.utm_source,
        tracking.utmSource,
        signupAttribution.utmSource,
        signupAttribution.utm_source,
      ) ?? null,
    utm_medium:
      firstString(
        data.utm_medium,
        data.utmMedium,
        tracking.utm_medium,
        tracking.utmMedium,
        signupAttribution.utmMedium,
        signupAttribution.utm_medium,
      ) ?? null,
    utm_campaign:
      firstString(
        data.utm_campaign,
        data.utmCampaign,
        tracking.utm_campaign,
        tracking.utmCampaign,
        signupAttribution.utmCampaign,
        signupAttribution.utm_campaign,
      ) ?? null,
    utm_content:
      firstString(
        data.utm_content,
        data.utmContent,
        tracking.utm_content,
        tracking.utmContent,
        signupAttribution.utmContent,
        signupAttribution.utm_content,
      ) ?? null,
    utm_term:
      firstString(
        data.utm_term,
        data.utmTerm,
        tracking.utm_term,
        tracking.utmTerm,
        signupAttribution.utmTerm,
        signupAttribution.utm_term,
      ) ?? null,
    utm_id:
      firstString(
        data.utm_id,
        data.utmId,
        tracking.utm_id,
        tracking.utmId,
        signupAttribution.utmId,
        signupAttribution.utm_id,
      ) ?? null,
  };
}

type ResolvedUtm = ReturnType<typeof resolveUtm>;

async function savePlayerAttribution(
  sb: SupabaseClient,
  args: {
    tenantId: string;
    playerId: string;
    payload: Record<string, unknown>;
    data: Record<string, unknown>;
    tracking: Record<string, unknown>;
    signupAttribution: Record<string, unknown>;
    utm: ResolvedUtm;
    capturedAt: string;
  },
) {
  const clickIds = {
    fbclid:
      firstString(args.data.fbclid, args.tracking.fbclid, args.signupAttribution.fbclid) ?? null,
    gclid: firstString(args.data.gclid, args.tracking.gclid, args.signupAttribution.gclid) ?? null,
    gbraid:
      firstString(args.data.gbraid, args.tracking.gbraid, args.signupAttribution.gbraid) ?? null,
    wbraid:
      firstString(args.data.wbraid, args.tracking.wbraid, args.signupAttribution.wbraid) ?? null,
    ttclid:
      firstString(args.data.ttclid, args.tracking.ttclid, args.signupAttribution.ttclid) ?? null,
    msclkid:
      firstString(args.data.msclkid, args.tracking.msclkid, args.signupAttribution.msclkid) ?? null,
    trackgram_click_id:
      firstString(
        args.data.trackgramClickId,
        args.data.trackgram_click_id,
        args.tracking.trackgramClickId,
        args.tracking.trackgram_click_id,
        args.signupAttribution.trackgramClickId,
        args.signupAttribution.trackgram_click_id,
      ) ?? null,
  };
  const hasUtm = Object.values(args.utm).some(Boolean);
  const hasClickId = Object.values(clickIds).some(Boolean);
  const provider = inferAttributionProvider(args.utm, clickIds);

  if (!hasUtm && !hasClickId) return;

  await sb.from("player_attributions").upsert(
    {
      tenant_id: args.tenantId,
      player_id: args.playerId,
      event_id:
        firstString(
          args.payload.eventId,
          args.payload.event_id,
          args.data.eventId,
          args.data.event_id,
        ) ?? null,
      event_type: "signup",
      provider,
      ...args.utm,
      ...clickIds,
      raw_payload: {
        data: args.data,
        signupAttribution: args.signupAttribution,
        tracking: args.tracking,
      },
      match_status: hasUtm ? "orphan_campaign" : "missing_utm",
      match_confidence: 0,
      captured_at: args.capturedAt,
    },
    { onConflict: "tenant_id,player_id,event_type" },
  );
}

function inferAttributionProvider(
  utm: ResolvedUtm,
  clickIds: {
    fbclid: string | null;
    gclid: string | null;
    gbraid: string | null;
    wbraid: string | null;
    ttclid: string | null;
    msclkid: string | null;
    trackgram_click_id: string | null;
  },
) {
  const source = String(utm.utm_source ?? "").toLowerCase();
  if (source.includes("fb") || source.includes("facebook") || source.includes("ig")) return "meta";
  if (source.includes("google")) return "google";
  if (source.includes("tiktok")) return "tiktok";
  if (source.includes("kwai")) return "kwai";
  if (clickIds.fbclid) return "meta";
  if (clickIds.gclid || clickIds.gbraid || clickIds.wbraid) return "google";
  if (clickIds.ttclid) return "tiktok";
  if (clickIds.msclkid) return "microsoft";
  if (clickIds.trackgram_click_id) return "trackgram";
  return source || null;
}

function isValidCpf(digits: string): boolean {
  if (!/^\d{11}$/.test(digits)) return false;
  if (/^(\d)\1{10}$/.test(digits)) return false;
  const calc = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(digits[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(digits[9]) && calc(10) === Number(digits[10]);
}

function extractCpf(data: Record<string, unknown>): string | null {
  const pix = (data.pixData ?? data.pix_data ?? {}) as Record<string, unknown>;
  const metadata = asRecord(data.metadata);
  const withdrawPix = asRecord(metadata.withdrawPix ?? metadata.withdraw_pix);
  const keyType = String(
    pix.keyType ??
      pix.key_type ??
      withdrawPix.keyType ??
      withdrawPix.key_type ??
      data.pixKeyType ??
      "",
  ).toLowerCase();
  const candidates: unknown[] = [];
  if (keyType === "cpf") {
    candidates.push(pix.keyValue ?? pix.key_value, data.withdrawPixKey, data.withdraw_pix_key);
  }
  candidates.push(data.cpf, data.CPF);
  for (const c of candidates) {
    if (typeof c !== "string" && typeof c !== "number") continue;
    const digits = String(c).replace(/\D/g, "");
    if (isValidCpf(digits)) return digits;
  }
  return null;
}

function resolveEventTimestamp(
  evento: string,
  payload: Record<string, unknown>,
  data: Record<string, unknown>,
): string {
  const candidates = [
    evento.includes("aprovado") || evento.includes("concluido") ? data.completedAt : undefined,
    data.completed_at,
    data.paid_at,
    data.paidAt,
    data.startedAt,
    data.started_at,
    data.createdAt,
    data.created_at,
    data.timestamp,
    payload.occurredAt,
    payload.occurred_at,
    payload.timestamp,
    payload.createdAt,
    payload.created_at,
  ];
  for (const value of candidates) {
    if (typeof value !== "string" && typeof value !== "number") continue;
    const t = Date.parse(String(value));
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return new Date().toISOString();
}
