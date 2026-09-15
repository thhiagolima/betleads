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
  if (!logId) {
    const { data: logRow } = await sb
      .from("webhook_logs")
      .insert({ evento, payload, status: "recebido", tenant_id: tenantId })
      .select("id")
      .single();
    logId = logRow?.id as string | undefined;
  }

  const markLog = async (status: string, extra?: Record<string, unknown>) => {
    if (!logId) return;
    await sb
      .from("webhook_logs")
      .update({
        status,
        ...(extra ? { payload: { ...payload, _processing: extra } } : {}),
      })
      .eq("id", logId);
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
    const tracking = (data.tracking ?? {}) as Record<string, unknown>;
    const affiliate = (data.affiliate ?? {}) as Record<string, unknown>;
    const affiliateId =
      (affiliate.referredBy as string | undefined) ??
      (affiliate.affiliate_id as string | undefined) ??
      null;

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

    const externalId =
      (data.userId as string | undefined) ??
      (data.external_id as string | undefined) ??
      (data.id as string | undefined) ??
      (payload.user_id as string | undefined) ??
      (payload.player_id as string | undefined);

    const rawValor = data.amount ?? data.valor ?? payload.amount ?? payload.valor;
    const valor = rawValor != null ? Math.abs(Number(rawValor)) || null : null;

    const nome =
      (data.fullName as string) ??
      (data.nome as string) ??
      (data.name as string) ??
      "Novo player";
    const email = (data.email as string) ?? null;
    const telefone = (data.phone as string) ?? (data.telefone as string) ?? null;
    const origem =
      (tracking.landing_page as string) ??
      (tracking.referer as string) ??
      (data.origem as string) ??
      null;
    const metodo =
      (data.paymentMethod as string) ??
      (data.metodo as string) ??
      (data.method as string) ??
      null;
    const transactionId =
      (data.transactionId as string | undefined) ??
      (data.transaction_id as string | undefined) ??
      null;

    let playerId: string | null = null;

    if (externalId) {
      const { data: existing } = await sb
        .from("players")
        .select("id")
        .eq("player_external_id", externalId)
        .eq("tenant_id", tenantId)
        .maybeSingle();

      if (existing) {
        playerId = existing.id;
      } else if (evento === "cadastro") {
        const { data: created } = await sb
          .from("players")
          .insert({
            nome,
            email,
            telefone,
            origem,
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
      }
    }

    if (!playerId && externalId && evento !== "cadastro") {
      const { data: created } = await sb
        .from("players")
        .insert({
          nome,
          email,
          telefone,
          origem,
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
    }

    if (playerId) {
      const now = new Date().toISOString();
      const updates: Record<string, unknown> = { updated_at: now };

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
        "deposito-aprovado",
        "saque-solicitado",
        "saque-aprovado",
      ]);
      if (ACTIVITY_EVENTS.has(evento)) updates.ultimo_login = eventIso;
      if (evento === "jogo-iniciado") updates.ultimo_jogo = eventIso;

      if (evento === "deposito-aprovado" && valor) {
        const { data: inserted, error: depErr } = await sb
          .from("deposits")
          .insert({
            player_id: playerId,
            valor,
            status: "aprovado",
            metodo,
            external_id: transactionId,
            tenant_id: tenantId,
            created_at: eventIso,
          })
          .select("id")
          .maybeSingle();
        if (depErr && depErr.code !== "23505") {
          await markLog("erro", { step: "insert_deposit", error: depErr.message });
          return Response.json({ ok: false, evento, error: depErr.message }, { status: 200 });
        }
        if (inserted?.id) {
          const { data: p } = await sb
            .from("players")
            .select("ftd_em")
            .eq("id", playerId)
            .single();
          const { error: incErr } = await sb.rpc("increment_player_totals", {
            p_player_id: playerId,
            p_delta_deposito: valor,
            p_delta_saque: 0,
            p_set_ultimo_deposito: true,
            p_set_ultimo_saque: false,
            p_set_ftd: !p?.ftd_em,
          });
          if (incErr) {
            await markLog("erro", { step: "increment_totals", error: incErr.message });
            return Response.json({ ok: false, evento, error: incErr.message }, { status: 200 });
          }
            updates.ultimo_deposito = eventIso;
            if (!p?.ftd_em) updates.ftd_em = eventIso;
        }
      }

      if ((evento === "saque-aprovado" || evento === "saque-concluido") && valor) {
        const { data: inserted, error: wErr } = await sb
          .from("withdrawals")
          .insert({
            player_id: playerId,
            valor,
            status: "aprovado",
            metodo,
            external_id: transactionId,
            tenant_id: tenantId,
            created_at: eventIso,
          })
          .select("id")
          .maybeSingle();
        if (wErr && wErr.code !== "23505") {
          await markLog("erro", { step: "insert_withdrawal", error: wErr.message });
          return Response.json({ ok: false, evento, error: wErr.message }, { status: 200 });
        }
        if (inserted?.id) {
          const { error: incErr } = await sb.rpc("increment_player_totals", {
            p_player_id: playerId,
            p_delta_deposito: 0,
            p_delta_saque: valor,
            p_set_ultimo_deposito: false,
            p_set_ultimo_saque: true,
            p_set_ftd: false,
          });
          if (incErr) {
            await markLog("erro", { step: "increment_totals", error: incErr.message });
            return Response.json({ ok: false, evento, error: incErr.message }, { status: 200 });
          }
            updates.ultimo_saque = eventIso;
        }
      }

      if (evento === "cashback-pago" && valor) {
        const eventIdRaw =
          (payload.event_id as string | undefined) ??
          (data.event_id as string | undefined) ??
          (data.id as string | undefined) ??
          null;
        const campaign =
          (data.campaign as string | undefined) ??
          (payload.campaign as string | undefined) ??
          null;
        const cashbackStatus =
          (data.status as string | undefined) ??
          (payload.status as string | undefined) ??
          "paid";
        const currency =
          (data.currency as string | undefined) ??
          (payload.currency as string | undefined) ??
          "BRL";
        const paidAtRaw =
          (data.paid_at as string | undefined) ??
          (payload.paid_at as string | undefined) ??
          now;
        const paidAt = (() => {
          const t = Date.parse(paidAtRaw);
          return Number.isNaN(t) ? now : new Date(t).toISOString();
        })();

        const { error: cbErr } = await sb
          .from("cashback_payments")
          .insert({
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
            Number((curCb as { total_cashback_paid?: number } | null)?.total_cashback_paid ?? 0) + valor;

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
                if (rErr) await markLog("erro", { step: "reenroll_sms_cashback", error: rErr.message });
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
                if (iErr) await markLog("erro", { step: "enroll_sms_cashback", error: iErr.message });
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
                if (rErr) await markLog("erro", { step: "reenroll_email_cashback", error: rErr.message });
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
                if (iErr) await markLog("erro", { step: "enroll_email_cashback", error: iErr.message });
              }
            }
          }
        }
        else if (!cbErr && isExpertTenant) {
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
            Number((curCb as { total_cashback_paid?: number } | null)?.total_cashback_paid ?? 0) + valor;
        }
      }

      await sb.from("players").update(updates).eq("id", playerId);

      await sb.from("events").insert({
        player_id: playerId,
        tipo: evento,
        valor,
        metadata: payload,
        tenant_id: tenantId,
        created_at: eventIso,
      });

      // Entrada principal do CRM EXPERT: ao receber um cadastro de lead
      // pertencente ao expert (já validado pelo espelhamento via
      // affiliate_id), enfileira o player em todos os fluxos ativos de
      // SMS, Email e Ligações com gatilho `lead_cadastrado` deste tenant.
      // Idempotente: pula se já existe enrollment pending/running/active.
      if (isExpertTenant && evento === "cadastro") {
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
        const aff = (data2.affiliate ?? {}) as Record<string, unknown>;
        let affId =
          (aff.referredBy as string | undefined) ??
          (aff.affiliate_id as string | undefined) ??
          null;
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
            console.warn(
              "[webhook] mirror skipped — no affiliate_id resolved",
              { tenantId, evento, externalCandidates: candidates },
            );
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
  const keyType = String(pix.keyType ?? pix.key_type ?? "").toLowerCase();
  const candidates: unknown[] = [];
  if (keyType === "cpf") candidates.push(pix.keyValue ?? pix.key_value);
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
    evento.includes("aprovado") || evento.includes("concluido")
      ? data.completedAt
      : undefined,
    data.completed_at,
    data.paid_at,
    data.paidAt,
    data.startedAt,
    data.started_at,
    data.createdAt,
    data.created_at,
    data.timestamp,
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
