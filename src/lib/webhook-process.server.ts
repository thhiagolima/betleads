import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { attributeFromLastFirstPartyClick } from "./conversion-attribution.server";
import { lookupExpertName, type SupabaseLike } from "./expert-lookup.server";
import { enrollPlayerOnEvent, eventEntryTriggers } from "./journey-scanner.server";

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
  options: { existingLogId?: string } = {},
): Promise<Response> {
  let logId = options.existingLogId;
  let receiptClaimed = false;
  let receiptEventId: string | null = null;
  let financialAttemptId: string | null = null;
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

    if (financialAttemptId) {
      const completed = status === "processado" || status === "sem_player";
      await (sb as any)
        .from("financial_webhook_attempts")
        .update({
          status: completed ? "completed" : "failed",
          completed_at: completed ? new Date().toISOString() : null,
          error_message: completed
            ? null
            : String(extra?.error ?? extra?.step ?? status).slice(0, 1000),
        })
        .eq("id", financialAttemptId)
        .eq("tenant_id", tenantId);
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
    // Casas como a Sorte da Bet enviam `{ event, time, user, tracking, amount,
    // internal_id, ... }`: o player fica em `user`, mas a transação, o
    // tracking e o instante do evento ficam no topo do payload.
    const userEnvelope = isUserEnvelope(payload);
    // A bravabet365 usa o mesmo envelope, mas manda a transação num objeto
    // `deposit` ou `withdraw` em vez de no topo do payload.
    const envelopeTx = userEnvelope ? asRecord(payload.deposit ?? payload.withdraw) : {};
    const eventIso = resolveEventTimestamp(evento, payload, data, userEnvelope);
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
    const tracking = asRecord(data.tracking ?? (userEnvelope ? payload.tracking : undefined));
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

    const expertNome = await lookupExpertName(sb as unknown as SupabaseLike, tenantId, affiliateId);

    const externalId = resolveExternalId(evento, payload, data);
    const signupEvent = isSignupEvent(evento, payload);

    const rawValor =
      data.amount ?? data.valor ?? envelopeTx.amount ?? payload.amount ?? payload.valor;
    const valor = rawValor != null ? Math.abs(Number(rawValor)) || null : null;

    const nome =
      firstString(
        data.fullName,
        data.full_name,
        data.nome,
        data.name,
        joinName(data.first_name ?? data.firstName, data.last_name ?? data.lastName),
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
      firstString(data.paymentMethod, data.methodCode, data.metodo, data.method, envelopeTx.type) ??
      (userEnvelope && (stringFrom(payload.pix_copy_paste) || stringFrom(envelopeTx.pix))
        ? "pix"
        : null);
    // No envelope `user`, `data.id` é o player: a transação vem do topo.
    // `internal_id` é o id da fatura na casa; `external_id`, o do PSP.
    // Em `deposit`/`withdraw`, o `id` da casa é o único presente tanto no
    // evento pendente quanto no pago.
    const envelopeTransactionId = userEnvelope
      ? firstString(
          envelopeTx.id,
          payload.internal_id,
          payload.transaction_id,
          payload.transactionId,
          payload.external_id,
        )
      : undefined;
    const transactionId =
      firstString(
        envelopeTransactionId,
        data.transactionId,
        data.transaction_id,
        data.referenceId,
        data.operationId,
        subject.type === "payment_transaction" ? subject.id : undefined,
        payload.eventId,
        payload.event_id,
        payload.deliveryId,
      ) ?? null;
    // No envelope `user` o recibo inclui o tipo do evento: a casa pode repetir
    // o `event_id` entre eventos diferentes, e um login não pode bloquear o
    // depósito que chega depois.
    const rawProviderEventId = firstString(
      payload.eventId,
      payload.event_id,
      data.eventId,
      data.event_id,
    );
    const envelopeEvent = userEnvelope ? stringFrom(payload.event) : undefined;
    const providerEventId =
      (rawProviderEventId && envelopeEvent
        ? `${envelopeEvent}:${rawProviderEventId}`
        : rawProviderEventId) ??
      (userEnvelope ? envelopeEventId(payload, data, envelopeTransactionId) : null);
    const providerStatus = firstString(data.status, envelopeTx.status, payload.status) ?? null;

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
        // `claim_webhook_event` returns false both when the event was already
        // processed and when another delivery still holds the receipt (or a
        // failure is inside its 30 s cool-down). Only the first is a real
        // duplicate: marking an in-flight event `duplicado` drops it forever
        // when the original worker dies, because replay ignores duplicates.
        const receipt = await readReceiptState(sb, tenantId, providerEventId);
        if (receipt.state === "completed") {
          await markLog("duplicado", { provider_event_id: providerEventId });
          return Response.json({ ok: true, evento, duplicate: true });
        }
        const retryAfter = receipt.retryAfterSeconds;
        await deferLogForReplay(sb, logId, payload, {
          provider_event_id: providerEventId,
          deferred: "receipt_in_progress",
          receipt_status: receipt.status,
          retry_after_seconds: retryAfter,
        });
        // 202, not 4xx: the log is kept replayable, so the provider does not
        // need to retry, and some providers disable endpoints after 4xx bursts.
        return Response.json(
          {
            ok: true,
            evento,
            in_progress: true,
            retry_after: retryAfter,
          },
          { status: 202, headers: { "Retry-After": String(retryAfter) } },
        );
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

    const financialEvent = resolveFinancialEvent(evento);

    if (playerId) {
      const now = new Date().toISOString();
      const updates: Record<string, unknown> = { updated_at: now };

      if (Object.values(utm).some(Boolean)) {
        let keepOrigin = false;
        if (!signupEvent) {
          const { data: origin } = await sb
            .from("players")
            .select("utm_source, utm_campaign, utm_content, utm_id")
            .eq("id", playerId)
            .maybeSingle();
          keepOrigin = hasAcquisitionOrigin(origin);
        }
        if (!keepOrigin) {
          if (utm.utm_source) updates.utm_source = utm.utm_source;
          if (utm.utm_medium) updates.utm_medium = utm.utm_medium;
          if (utm.utm_campaign) updates.utm_campaign = utm.utm_campaign;
          if (utm.utm_content) updates.utm_content = utm.utm_content;
          if (utm.utm_term) updates.utm_term = utm.utm_term;
          if (utm.utm_id) updates.utm_id = utm.utm_id;
        }
      }
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

      // Atividade de login precisa representar somente uma entrada real na plataforma.
      // Depósitos e saques não podem mascarar filtros como “X dias sem login”.
      const nascimento = dateOnly(data.birth_date ?? data.birthDate ?? data.data_nascimento);
      if (nascimento) updates.data_nascimento = nascimento;

      if (evento === "login") updates.ultimo_login = eventIso;
      if (evento === "jogo-iniciado") updates.ultimo_jogo = eventIso;
      // O login do envelope `user` traz o saldo atual da carteira.
      if (userEnvelope) {
        const saldo = finiteNumber(payload.balance_brl ?? data.wallet);
        const bonus = finiteNumber(payload.balance_bonus ?? data.wallet_bonus);
        if (saldo !== null) updates.saldo_carteira = saldo;
        if (bonus !== null) updates.saldo_bonus = bonus;
      }

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

        const normalizedEvent = {
          kind: financialEvent.kind,
          status: financialEvent.status,
          tenant_id: tenantId,
          player_id: playerId,
          external_id: transactionId,
          provider_event_id: providerEventId,
          provider_status: providerStatus,
          amount: valor,
          method: metodo,
          event_at: eventIso,
        };
        const { data: attempt, error: attemptError } = await (sb as any)
          .from("financial_webhook_attempts")
          .insert({
            tenant_id: tenantId,
            webhook_log_id: logId ?? null,
            provider_event_id: providerEventId,
            event_name: evento,
            parser_version: "2026-10-03",
            raw_payload: payload,
            normalized_event: normalizedEvent,
          })
          .select("id")
          .single();
        if (attemptError) {
          await markLog("erro", {
            step: "record_financial_webhook_attempt",
            error: attemptError.message,
          });
          return Response.json({ ok: false, evento, error: attemptError.message }, { status: 503 });
        }
        financialAttemptId = attempt?.id ?? null;

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
      const conversionEvent = isSignupEvent(evento, payload)
        ? "registered"
        : evento === "login"
          ? "login"
          : evento === "jogo-iniciado"
            ? "game"
            : financialEvent?.kind === "deposit" && financialEvent.status === "aprovado"
              ? "deposit_approved"
              : null;
      if (conversionEvent) {
        const attributionEventId =
          providerEventId ??
          transactionId ??
          (conversionEvent === "registered" && externalId ? `signup:${externalId}` : null);
        if (attributionEventId) {
          try {
            const baseAttribution = {
              tenantId,
              playerId,
              eventType: conversionEvent,
              eventId: attributionEventId,
              occurredAt: eventIso,
              monetaryValue: conversionEvent === "deposit_approved" ? valor : null,
              isFtd:
                conversionEvent === "deposit_approved" &&
                (data.isFtd === true ||
                  (userEnvelope &&
                    (finiteNumber(payload.paid_deposits_count) === 1 ||
                      finiteNumber(envelopeTx.is_ftd) === 1))),
            } as const;
            // The provider identifies the player, while BetLeads owns the
            // click proof. Do not trust query parameters echoed by the casino:
            // attribution requires an exact, first-party recorded click.
            await attributeFromLastFirstPartyClick(baseAttribution);
          } catch (attributionError) {
            const error =
              attributionError instanceof Error
                ? attributionError.message
                : String(attributionError);
            // Financial and player events are the source of truth. Analytics
            // failures are observable but must never reject or replay them.
            console.error("[conversion attribution] async-compatible failure", {
              tenantId,
              playerId,
              eventType: conversionEvent,
              eventId: attributionEventId,
              error,
            });
          }
        }
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

    // ENV-09: enroll the player now in journeys this event qualifies for,
    // instead of waiting for the next scan cycle. Runs after the ledger and
    // never blocks or fails the webhook (errors are logged and reported).
    if (eventEntryTriggers(evento).length) {
      void enrollPlayerOnEvent(tenantId, playerId, evento);
    }

    return Response.json({ ok: true, evento });
  } catch (e) {
    await markLog("erro", { step: "exception", error: String(e) });
    return Response.json({ ok: false, evento, error: String(e) }, { status: 200 });
  }
}

/** Must match the processing lease in `claim_webhook_event`. */
export const RECEIPT_PROCESSING_LEASE_MS = 10 * 60 * 1000;
/** Must match the failed-receipt cool-down in `claim_webhook_event`. */
export const RECEIPT_FAILED_COOLDOWN_MS = 30 * 1000;
export const MIN_RETRY_AFTER_SECONDS = 30;
export const MAX_RETRY_AFTER_SECONDS = 600;
/** Extra slack before replay retries a deferred log, so the lease has expired. */
const REPLAY_DEFER_MARGIN_SECONDS = 30;

export type ReceiptState = {
  state: "completed" | "in_progress";
  status: string | null;
  retryAfterSeconds: number;
};

/**
 * Tells "already processed" apart from "still in flight" after
 * `claim_webhook_event` refused the claim. Reads the receipt directly, so it
 * works with the original boolean RPC (no DB change required). Anything that
 * is not positively `completed` is treated as in progress: retrying an event
 * is safe (the receipt keeps it idempotent), dropping it is not.
 */
export async function readReceiptState(
  sb: SupabaseClient,
  tenantId: string,
  providerEventId: string,
  now: number = Date.now(),
): Promise<ReceiptState> {
  const clamp = (seconds: number) =>
    Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(MIN_RETRY_AFTER_SECONDS, Math.ceil(seconds)));
  const { data, error } = await sb
    .from("webhook_event_receipts")
    .select("status, locked_at, updated_at")
    .eq("tenant_id", tenantId)
    .eq("provider_event_id", providerEventId)
    .maybeSingle();
  if (error || !data) {
    return { state: "in_progress", status: null, retryAfterSeconds: clamp(60) };
  }
  const status = (data.status as string | null) ?? null;
  if (status === "completed") {
    return { state: "completed", status, retryAfterSeconds: 0 };
  }
  if (status === "failed") {
    const updatedAt = Date.parse(String(data.updated_at ?? ""));
    const remaining = Number.isFinite(updatedAt)
      ? (updatedAt + RECEIPT_FAILED_COOLDOWN_MS - now) / 1000
      : RECEIPT_FAILED_COOLDOWN_MS / 1000;
    return { state: "in_progress", status, retryAfterSeconds: clamp(remaining) };
  }
  const lockedAt = Date.parse(String(data.locked_at ?? ""));
  const remaining = Number.isFinite(lockedAt)
    ? (lockedAt + RECEIPT_PROCESSING_LEASE_MS - now) / 1000
    : RECEIPT_PROCESSING_LEASE_MS / 1000;
  return { state: "in_progress", status, retryAfterSeconds: clamp(remaining) };
}

/**
 * Keeps a log row eligible for replay (`recebido`) and pushes its
 * `next_replay_at` past the receipt lease. Tolerates a database where the
 * CON-03 migration has not been applied yet (column missing): the row then
 * simply stays `recebido` and is retried by the legacy replay selection.
 */
async function deferLogForReplay(
  sb: SupabaseClient,
  logId: string | undefined,
  payload: Record<string, unknown>,
  note: Record<string, unknown> & { retry_after_seconds: number },
) {
  if (!logId) return;
  const base = { status: "recebido", payload: { ...payload, _processing: note } };
  const nextReplayAt = new Date(
    Date.now() + (note.retry_after_seconds + REPLAY_DEFER_MARGIN_SECONDS) * 1000,
  ).toISOString();
  const { error } = await sb
    .from("webhook_logs")
    .update({ ...base, next_replay_at: nextReplayAt })
    .eq("id", logId);
  if (error && isMissingColumnError(error)) {
    await sb.from("webhook_logs").update(base).eq("id", logId);
  }
}

function isMissingColumnError(error: { code?: string; message?: string }) {
  return (
    error.code === "42703" ||
    error.code === "PGRST204" ||
    /column .* does not exist|could not find the .* column/i.test(error.message ?? "")
  );
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

function isUserEnvelope(payload: Record<string, unknown>): boolean {
  return (
    payload.data === undefined &&
    payload.player === undefined &&
    Object.keys(asRecord(payload.user)).length > 0
  );
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Aceita só `AAAA-MM-DD` (com ou sem hora) e devolve a data pura. */
function dateOnly(value: unknown): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(stringFrom(value) ?? "");
  if (!match || Number.isNaN(Date.parse(match[1]))) return null;
  return match[1];
}

function joinName(first: unknown, last: unknown): string | undefined {
  const parts = [stringFrom(first), stringFrom(last)].filter(Boolean);
  return parts.length ? parts.join(" ") : undefined;
}

/**
 * O envelope `user` não traz id de evento. Sem ele não há recibo e uma
 * reentrega duplicaria eventos e sessões, então derivamos um id estável:
 * por transação nos eventos financeiros, por player + instante nos demais.
 */
function envelopeEventId(
  payload: Record<string, unknown>,
  data: Record<string, unknown>,
  transactionId: string | undefined,
): string | null {
  const event = stringFrom(payload.event);
  if (!event) return null;
  if (transactionId) return `${event}:${transactionId}`;
  const userId = stringFrom(data.id);
  const time = stringFrom(payload.time);
  return userId && time ? `${event}:${userId}:${time}` : null;
}

const BRASILIA_OFFSET_MS = 3 * 3_600_000;
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60_000;

/**
 * A Sorte da Bet envia `time` em epoch ms com o relógio de Brasília lido como
 * UTC (3 h atrás do instante real). Se a soma cair no futuro, a casa passou a
 * enviar UTC de verdade e o valor é usado como veio.
 */
function envelopeTimeToIso(value: unknown): string | null {
  const ms = finiteNumber(value);
  if (ms === null || ms <= 0) return null;
  const shifted = ms + BRASILIA_OFFSET_MS;
  return new Date(shifted <= Date.now() + CLOCK_SKEW_TOLERANCE_MS ? shifted : ms).toISOString();
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

/** O jogador já tem uma origem de aquisição gravada (primeiro toque). */
export function hasAcquisitionOrigin(origin: Record<string, unknown> | null | undefined): boolean {
  if (!origin) return false;
  return ["utm_source", "utm_campaign", "utm_content", "utm_id"].some((key) => {
    const value = origin[key];
    return typeof value === "string" && value.trim() !== "";
  });
}

export function isTrackingToken(value: string | null | undefined): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

export function resolveBetleadsClickId(
  data: Record<string, unknown>,
  tracking: Record<string, unknown>,
  signupAttribution: Record<string, unknown>,
  utm: ResolvedUtm,
): string | null {
  const dedicated = firstString(
    data.bl_click_id,
    data.blClickId,
    tracking.bl_click_id,
    tracking.blClickId,
    signupAttribution.bl_click_id,
    signupAttribution.blClickId,
  );
  if (isTrackingToken(dedicated)) return dedicated;
  return isTrackingToken(utm.utm_content) ? utm.utm_content : null;
}

export function resolveBetleadsClickTokenSource(
  data: Record<string, unknown>,
  tracking: Record<string, unknown>,
  signupAttribution: Record<string, unknown>,
  utm: ResolvedUtm,
): "bl_click_id" | "utm_content" | null {
  const dedicated = firstString(
    data.bl_click_id,
    data.blClickId,
    tracking.bl_click_id,
    tracking.blClickId,
    signupAttribution.bl_click_id,
    signupAttribution.blClickId,
  );
  if (isTrackingToken(dedicated)) return "bl_click_id";
  return isTrackingToken(utm.utm_content) ? "utm_content" : null;
}

export function resolveBetleadsClickCapturedAt(
  data: Record<string, unknown>,
  tracking: Record<string, unknown>,
  signupAttribution: Record<string, unknown>,
): string | null {
  const value = firstString(
    data.bl_click_captured_at,
    data.blClickCapturedAt,
    tracking.bl_click_captured_at,
    tracking.blClickCapturedAt,
    signupAttribution.bl_click_captured_at,
    signupAttribution.blClickCapturedAt,
  );
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
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

  const { error } = await sb.from("player_attributions").upsert(
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
      bl_click_id: resolveBetleadsClickId(
        args.data,
        args.tracking,
        args.signupAttribution,
        args.utm,
      ),
      bl_click_captured_at: resolveBetleadsClickCapturedAt(
        args.data,
        args.tracking,
        args.signupAttribution,
      ),
      ...args.utm,
      ...clickIds,
      raw_payload: {
        data: args.data,
        signupAttribution: args.signupAttribution,
        tracking: args.tracking,
      },
      // "pending": o worker da Meta reconcilia com anúncio e campanha a cada tick.
      match_status: hasUtm ? "pending" : "missing_utm",
      match_confidence: 0,
      captured_at: args.capturedAt,
    },
    { onConflict: "tenant_id,player_id,event_type" },
  );
  // A atribuição é análise: uma falha aqui não pode rejeitar o cadastro, mas precisa aparecer.
  if (error) {
    console.error("[player attribution] upsert failed", {
      tenantId: args.tenantId,
      playerId: args.playerId,
      error: error.message,
    });
  }
}

const META_SOURCES = new Set(["fb", "facebook", "ig", "instagram", "meta", "an", "msg", "threads"]);

export function inferAttributionProvider(
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
): string | null {
  const source = String(utm.utm_source ?? "")
    .trim()
    .toLowerCase();
  // Comparação exata: "digital" ou "original" contêm "ig" e não são Meta.
  if (META_SOURCES.has(source) || source.startsWith("facebook") || source.startsWith("instagram"))
    return "meta";
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
  userEnvelope = false,
): string {
  if (userEnvelope) {
    // `data` é o próprio usuário: o `created_at` dele só vale para o cadastro.
    const signupAt = isSignupEvent(evento, payload) ? stringFrom(data.created_at) : undefined;
    const signupMs = signupAt ? Date.parse(signupAt) : Number.NaN;
    if (!Number.isNaN(signupMs)) return new Date(signupMs).toISOString();
    const occurredAt = stringFrom(payload.occurred_at);
    const occurredMs = occurredAt ? Date.parse(occurredAt) : Number.NaN;
    return (
      envelopeTimeToIso(payload.time) ??
      (Number.isNaN(occurredMs) ? null : new Date(occurredMs).toISOString()) ??
      new Date().toISOString()
    );
  }
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
