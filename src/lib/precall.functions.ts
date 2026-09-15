// CRUD server fns para o módulo Pré-ligação.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type CreateCampaignInput = {
  nome: string;
  filtro_id: string;
  session_id: string;
  delay_min_seconds: number;
  delay_max_seconds: number;
  templates: string[];
};

export const listPrecallCampaigns = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("precall_campaigns")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { campaigns: data ?? [] };
  });

export const createPrecallCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: CreateCampaignInput) => d)
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { resolveAudience } = await import("./precall.server");

    // tenant do user (current_tenant_id() via RPC seria ideal; usa user_roles)
    const { data: roleRow } = await context.supabase
      .from("user_roles")
      .select("tenant_id")
      .eq("user_id", context.userId)
      .not("tenant_id", "is", null)
      .limit(1)
      .maybeSingle();
    const tenantId = roleRow?.tenant_id;
    if (!tenantId) throw new Error("tenant não encontrado");

    // 1) cria campanha
    const { data: camp, error: cErr } = await supabaseAdmin
      .from("precall_campaigns")
      .insert({
        tenant_id: tenantId,
        nome: data.nome,
        filtro_id: data.filtro_id,
        session_id: data.session_id,
        delay_min_seconds: data.delay_min_seconds,
        delay_max_seconds: data.delay_max_seconds,
        status: "rascunho",
        created_by: context.userId,
      })
      .select("*")
      .single();
    if (cErr || !camp) throw new Error(cErr?.message ?? "falha ao criar campanha");

    // 2) templates
    if (data.templates.length > 0) {
      const rows = data.templates
        .map((c, i) => ({
          campaign_id: camp.id,
          tenant_id: tenantId,
          ordem: i,
          content: c.trim(),
        }))
        .filter((r) => r.content.length > 0);
      if (rows.length > 0) {
        const { error: tErr } = await supabaseAdmin.from("precall_templates").insert(rows);
        if (tErr) throw new Error(tErr.message);
      }
    }

    // 3) materializa audience -> leads
    const audience = await resolveAudience(tenantId, data.filtro_id);
    if (audience.length > 0) {
      // intervalo crescente já no agendamento inicial para evitar burst
      const now = Date.now();
      const rows = audience.map((a, i) => ({
        campaign_id: camp.id,
        tenant_id: tenantId,
        player_id: a.player_id,
        telefone_e164: a.telefone_e164,
        status: "pendente",
        scheduled_at: new Date(now + i * Math.floor((data.delay_min_seconds + data.delay_max_seconds) / 2) * 1000).toISOString(),
      }));
      const { error: lErr } = await supabaseAdmin
        .from("precall_leads")
        .upsert(rows, { onConflict: "campaign_id,player_id", ignoreDuplicates: true });
      if (lErr) throw new Error(lErr.message);
    }

    await supabaseAdmin
      .from("precall_campaigns")
      .update({ total_leads: audience.length })
      .eq("id", camp.id);

    return { campaign_id: camp.id, total_leads: audience.length };
  });

export const setPrecallCampaignStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string; status: "rodando" | "pausada" | "cancelada" }) => d)
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("precall_campaigns")
      .update({ status: data.status })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const getPrecallCampaign = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data, context }) => {
    const { data: camp, error } = await context.supabase
      .from("precall_campaigns")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!camp) throw new Error("campanha não encontrada");

    const { data: templates } = await context.supabase
      .from("precall_templates")
      .select("id, ordem, content")
      .eq("campaign_id", data.id)
      .order("ordem", { ascending: true });

    const { data: leads } = await context.supabase
      .from("precall_leads")
      .select("id, player_id, telefone_e164, status, scheduled_at, sent_at, responded_at, called_at, mensagem_enviada, resposta_texto, observacao, error")
      .eq("campaign_id", data.id)
      .order("created_at", { ascending: true })
      .limit(2000);

    // join nome/categoria/ultimo_login dos players
    const ids = (leads ?? []).map((l) => l.player_id).filter((x): x is string => !!x);
    const players = ids.length
      ? (await context.supabase
          .from("players")
          .select("id, nome, vip, total_depositado, ultimo_login")
          .in("id", ids)).data ?? []
      : [];
    const pmap = new Map(players.map((p) => [p.id, p]));
    const leadsFull = (leads ?? []).map((l) => {
      const p = l.player_id ? pmap.get(l.player_id) : undefined;
      const dias = p?.ultimo_login
        ? Math.floor((Date.now() - new Date(p.ultimo_login).getTime()) / 86400000)
        : null;
      return {
        ...l,
        nome: p?.nome ?? null,
        categoria: p?.vip ? "VIP" : p && Number(p.total_depositado) >= 1000 ? "Alto valor" : "Padrão",
        dias_sem_login: dias,
      };
    });

    return { campaign: camp, templates: templates ?? [], leads: leadsFull };
  });

export const markPrecallLeadCalled = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { lead_id: string; observacao?: string | null }) => d)
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("precall_leads")
      .update({
        status: "ligado",
        called_at: new Date().toISOString(),
        observacao: data.observacao ?? null,
      })
      .eq("id", data.lead_id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const previewPrecallAudience = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { filtro_id: string }) => d)
  .handler(async ({ data, context }) => {
    const { resolveAudience } = await import("./precall.server");
    const { data: roleRow } = await context.supabase
      .from("user_roles")
      .select("tenant_id")
      .eq("user_id", context.userId)
      .not("tenant_id", "is", null)
      .limit(1)
      .maybeSingle();
    const tenantId = roleRow?.tenant_id;
    if (!tenantId) return { count: 0 };
    const aud = await resolveAudience(tenantId, data.filtro_id);
    return { count: aud.length };
  });