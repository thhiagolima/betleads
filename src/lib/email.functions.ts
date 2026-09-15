// Server functions para persistir SMTP, Templates, Campanhas e Automações de email.

import { createServerFn } from "@tanstack/react-start";
import { dbUuid } from "@/lib/zod-helpers";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  BUSINESSCODE_EMAIL_URL,
  callBusinessCodeEmail,
  resolveSender,
} from "./email-send.server";
import { loadPlayersForSegment, countPlayersForSegment } from "./email-segments.server";
import { buildPlayerVariables } from "./template-vars.server";
import { renderTemplate } from "./template-vars.server";

// ============ Helpers ============

export function summarizeProviderError(
  provider_response: unknown,
  fallback?: string | null,
): string {
  const r = (provider_response ?? {}) as Record<string, unknown>;
  const status = r.status ? String(r.status) : null;
  const body = (r.body ?? {}) as Record<string, unknown>;
  // SPA HTML from BusinessCode means the endpoint doesn't exist
  const snippet = typeof body.snippet === "string" ? body.snippet : null;
  if (status === "405" || (snippet && snippet.includes("<!DOCTYPE html>"))) {
    return `HTTP ${status ?? "405"} — endpoint indisponível na BusinessCode`;
  }
  // JSON-shaped provider error
  const msg =
    (typeof body.message === "string" && body.message) ||
    (typeof body.error === "string" && body.error) ||
    (typeof (body as { data?: { message?: string } }).data?.message === "string" &&
      (body as { data: { message: string } }).data.message) ||
    null;
  if (status && msg) return `HTTP ${status} — ${msg.slice(0, 160)}`;
  if (status) return `HTTP ${status}`;
  if (fallback) {
    try {
      const parsed = JSON.parse(fallback);
      if (parsed && typeof parsed === "object" && "snippet" in parsed) {
        return "Sem resposta legível do provedor";
      }
    } catch {
      // fallback is plain text
      return fallback.slice(0, 200);
    }
  }
  return "Falha desconhecida";
}

// ============ ENVIO via BusinessCode ============

export const getEmailProviderStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    return {
      configured: Boolean(
        process.env.BUSINESSCODE_SMS_TOKEN || process.env.BUSINESSCODE_EMAIL_TOKEN,
      ),
      endpoint: BUSINESSCODE_EMAIL_URL,
      provider: "businesscode" as const,
    };
  });

const SendTestEmailSchema = z.object({
  to: z.string().email().max(255),
  subject: z.string().min(1).max(255),
  html: z.string().min(1).max(200_000),
  smtpId: dbUuid().optional().nullable(),
  playerId: dbUuid().optional().nullable(),
  fromEmail: z.string().email().max(255).optional().nullable(),
  fromName: z.string().max(160).optional().nullable(),
  replyTo: z.string().email().max(255).optional().nullable(),
});

export const sendTestEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => SendTestEmailSchema.parse(d))
  .handler(async ({ data, context }) => {
    // Resolve remetente
    let sender: { fromEmail: string; fromName: string | null; replyTo: string | null } | null = null;
    if (data.fromEmail) {
      sender = {
        fromEmail: data.fromEmail,
        fromName: data.fromName ?? null,
        replyTo: data.replyTo ?? null,
      };
    } else {
      const { data: tenantRow, error: tenantErr } = await context.supabase.rpc("current_tenant_id");
      if (tenantErr) throw new Error(tenantErr.message);
      const tenantId = tenantRow as string | null;
      sender = await resolveSender(data.smtpId ?? null, tenantId);
    }
    if (!sender) {
      throw new Error(
        "Nenhum remetente configurado. Vá em Email > Remetentes e cadastre um remetente padrão.",
      );
    }

    // Variáveis do player (se informado)
    let html = data.html;
    let subject = data.subject;
    let playerId: string | null = null;
    if (data.playerId) {
      const { data: p } = await supabaseAdmin
        .from("players")
        .select("*")
        .eq("id", data.playerId)
        .maybeSingle();
      if (p) {
        playerId = p.id;
        const vars = buildPlayerVariables(p);
        html = renderTemplate(html, vars);
        subject = renderTemplate(subject, vars);
      }
    } else {
      // tenta auto-match por email
      const { data: p } = await supabaseAdmin
        .from("players")
        .select("*")
        .eq("email", data.to)
        .maybeSingle();
      if (p) {
        playerId = p.id;
        const vars = buildPlayerVariables(p);
        html = renderTemplate(html, vars);
        subject = renderTemplate(subject, vars);
      }
    }

    const result = await callBusinessCodeEmail({
      to: data.to,
      from: sender.fromEmail,
      fromName: sender.fromName,
      replyTo: sender.replyTo,
      subject,
      html,
    });

    // Log
    const { error: logErr } = await supabaseAdmin.from("email_send_logs").insert({
      to_email: data.to,
      subject,
      status: result.ok ? "sent" : "error",
      error: result.ok ? null : JSON.stringify(result.body).slice(0, 1000),
      sent_at: result.ok ? new Date().toISOString() : null,
      player_id: playerId,
      provider_response: { status: result.status, body: result.body, idempotency_key: result.idempotencyKey } as never,
    });
    if (logErr) console.error("email_send_logs insert error", logErr.message);

    if (!result.ok) {
      const b = result.body as { provider_error?: string } | null;
      const msg = b?.provider_error
        ? b.provider_error
        : `Resposta inesperada do provedor (${result.status}).`;
      throw new Error(`Falha no envio (${result.status}): ${msg}`);
    }
    const body = result.body as { dispatch_id?: number; status?: string; data?: { id?: number; status?: string } } | null;
    return {
      ok: true,
      status: result.status,
      providerStatus: body?.status ?? body?.data?.status ?? null,
      dispatchId: body?.dispatch_id ?? body?.data?.id ?? null,
      idempotencyKey: result.idempotencyKey,
    };
  });

// ============ SMTP ============

const SmtpInputSchema = z.object({
  id: dbUuid().optional(),
  nome: z.string().min(1).max(160),
  provedor: z.string().max(120).default(""),
  host: z.string().min(1).max(255),
  porta: z.number().int().min(1).max(65535),
  seguranca: z.enum(["SSL/TLS", "STARTTLS", "Nenhuma"]),
  usuario: z.string().max(255).default(""),
  senha: z.string().max(500).default(""),
  fromName: z.string().max(160).default(""),
  fromEmail: z.string().max(255),
  replyTo: z.string().max(255).default(""),
  limiteDiario: z.number().int().min(0).default(10000),
  limiteHora: z.number().int().min(0).default(500),
  status: z.enum(["ativo", "inativo"]).default("ativo"),
  padrao: z.boolean().default(false),
});

function smtpRowToUI(r: any) {
  return {
    id: r.id,
    nome: r.name,
    provedor: r.config?.provedor ?? "",
    host: r.host,
    porta: r.port,
    seguranca: r.config?.seguranca ?? (r.secure ? "SSL/TLS" : "STARTTLS"),
    usuario: r.username ?? "",
    senha: r.password_encrypted ?? "",
    fromName: r.from_name ?? "",
    fromEmail: r.from_email,
    replyTo: r.config?.replyTo ?? "",
    limiteDiario: r.config?.limiteDiario ?? 10000,
    limiteHora: r.config?.limiteHora ?? 500,
    status: r.status === "ativo" ? "ativo" : "inativo",
    padrao: !!r.is_default,
  };
}

export const listSmtpConfigs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("email_smtp_configs")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    // 'config' jsonb não existe na tabela base; preserva extras em row.last_test_error como fallback? Vamos usar metadados extras via colunas existentes ou stringify.
    return { items: (data ?? []).map(smtpRowToUI) };
  });

export const saveSmtpConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => SmtpInputSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const payload: any = {
      name: data.nome,
      host: data.host,
      port: data.porta,
      secure: data.seguranca === "SSL/TLS",
      username: data.usuario || null,
      password_encrypted: data.senha || null,
      from_email: data.fromEmail,
      from_name: data.fromName || null,
      is_default: data.padrao,
      status: data.status,
      config: {
        provedor: data.provedor,
        seguranca: data.seguranca,
        replyTo: data.replyTo,
        limiteDiario: data.limiteDiario,
        limiteHora: data.limiteHora,
      },
    };

    let id = data.id;
    if (id) {
      const { error } = await supabase.from("email_smtp_configs").update(payload).eq("id", id);
      if (error) throw new Error(error.message);
    } else {
      const { data: created, error } = await supabase
        .from("email_smtp_configs")
        .insert(payload)
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      id = created.id;
    }

    if (data.padrao) {
      await supabase.from("email_smtp_configs").update({ is_default: false }).neq("id", id!);
      await supabase.from("email_smtp_configs").update({ is_default: true }).eq("id", id!);
    }

    return { id };
  });

export const deleteSmtpConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: dbUuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("email_smtp_configs")
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const setDefaultSmtpConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: dbUuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await supabase.from("email_smtp_configs").update({ is_default: false }).neq("id", data.id);
    const { error } = await supabase
      .from("email_smtp_configs")
      .update({ is_default: true })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ============ REMETENTES (email_senders) ============
// Entidade dedicada para o "from" do email — independente de SMTP.
// Permite usar a API BusinessCode sem precisar cadastrar SMTP só para
// armazenar from_email / from_name / reply_to.

const SenderInputSchema = z.object({
  id: dbUuid().optional(),
  name: z.string().min(1).max(160),
  fromEmail: z.string().email().max(255),
  fromName: z.string().max(160).default(""),
  replyTo: z.string().max(255).default(""),
  domain: z.string().max(255).default(""),
  isDefault: z.boolean().default(false),
});

function senderRowToUI(r: any) {
  return {
    id: r.id,
    name: r.name,
    fromEmail: r.from_email,
    fromName: r.from_name ?? "",
    replyTo: r.reply_to ?? "",
    domain: r.domain ?? "",
    isDefault: !!r.is_default,
  };
}

export const listEmailSenders = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("email_senders")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { items: (data ?? []).map(senderRowToUI) };
  });

export const saveEmailSender = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => SenderInputSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: tenantRow, error: tenantErr } = await supabase.rpc("current_tenant_id");
    if (tenantErr) throw new Error(tenantErr.message);
    const tenantId = tenantRow as string | null;
    if (!tenantId) throw new Error("tenant não encontrado para o usuário");
    const payload: any = {
      name: data.name,
      from_email: data.fromEmail,
      from_name: data.fromName || null,
      reply_to: data.replyTo || null,
      domain: data.domain || null,
      is_default: data.isDefault,
      tenant_id: tenantId,
    };
    let id = data.id;
    if (id) {
      const { error } = await supabase.from("email_senders").update(payload).eq("id", id);
      if (error) throw new Error(error.message);
    } else {
      const { data: created, error } = await supabase
        .from("email_senders")
        .insert(payload)
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      id = created.id;
    }
    if (data.isDefault && id) {
      await supabase
        .from("email_senders")
        .update({ is_default: false })
        .eq("tenant_id", tenantId)
        .neq("id", id);
      await supabase.from("email_senders").update({ is_default: true }).eq("id", id);
    }
    return { id };
  });

export const deleteEmailSender = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: dbUuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("email_senders")
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const setDefaultEmailSender = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: dbUuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: tenantRow, error: tenantErr } = await supabase.rpc("current_tenant_id");
    if (tenantErr) throw new Error(tenantErr.message);
    const tenantId = tenantRow as string | null;
    if (!tenantId) throw new Error("tenant não encontrado para o usuário");
    await supabase
      .from("email_senders")
      .update({ is_default: false })
      .eq("tenant_id", tenantId)
      .neq("id", data.id);
    const { error } = await supabase
      .from("email_senders")
      .update({ is_default: true })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ============ TEMPLATES ============

const TemplateInputSchema = z.object({
  id: dbUuid().optional(),
  nome: z.string().min(1).max(160),
  assunto: z.string().max(255).default(""),
  preheader: z.string().max(500).default(""),
  fromName: z.string().max(160).default(""),
  categoria: z.string().max(80).default("Geral"),
  tags: z.array(z.string().max(60)).default([]),
  corpo: z.string().default(""),
  ativo: z.boolean().default(true),
});

function templateRowToUI(r: any) {
  return {
    id: r.id,
    nome: r.name,
    assunto: r.subject,
    preheader: r.preheader ?? "",
    fromName: r.from_name ?? "",
    categoria: "Geral",
    tags: r.tags ?? [],
    corpo: r.body_html ?? "",
    ativo: !!r.is_active,
    atualizadoEm: new Date(r.updated_at ?? r.created_at).toLocaleString("pt-BR"),
  };
}

export const listEmailTemplates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("email_templates")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { items: (data ?? []).map(templateRowToUI) };
  });

export const saveEmailTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => TemplateInputSchema.parse(d))
  .handler(async ({ data, context }) => {
    const payload = {
      name: data.nome,
      subject: data.assunto,
      preheader: data.preheader || null,
      from_name: data.fromName || null,
      body_html: data.corpo,
      body_text: "",
      tags: data.tags,
      is_active: data.ativo,
    };
    if (data.id) {
      const { error } = await context.supabase
        .from("email_templates")
        .update(payload)
        .eq("id", data.id);
      if (error) throw new Error(error.message);
      return { id: data.id };
    }
    const { data: created, error } = await context.supabase
      .from("email_templates")
      .insert(payload)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: created.id };
  });

export const deleteEmailTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: dbUuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("email_templates")
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const duplicateEmailTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: dbUuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: orig, error: oErr } = await context.supabase
      .from("email_templates")
      .select("*")
      .eq("id", data.id)
      .single();
    if (oErr) throw new Error(oErr.message);
    const { data: created, error } = await context.supabase
      .from("email_templates")
      .insert({
        name: `${orig.name} (cópia)`,
        subject: orig.subject,
        preheader: orig.preheader,
        from_name: orig.from_name,
        body_html: orig.body_html,
        body_text: orig.body_text,
        tags: orig.tags,
        is_active: orig.is_active,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: created.id };
  });

// ============ CAMPANHAS ============

const CampanhaInputSchema = z.object({
  id: dbUuid().optional(),
  nome: z.string().min(1).max(160),
  audienceMode: z.enum(["segmento", "leads", "emails"]).default("segmento"),
  segmento: z.string().max(160).default("Todos"),
  template: z.string().max(160).default(""),
  smtp: z.string().max(160).default(""),
  templateId: dbUuid().nullable().optional(),
  smtpId: z.string().max(64).nullable().optional(),
  agendadoPara: z.string().nullable().optional(),
  status: z.enum(["rascunho", "agendada", "enviando", "pausada", "concluida"]).default("rascunho"),
  targetPlayerIds: z.array(dbUuid()).max(5000).optional(),
  extraEmails: z.array(z.string().email().max(255)).max(5000).optional(),
});

function campanhaRowToUI(r: any) {
  const stats = r.stats ?? {};
  const af = r.audience_filter ?? {};
  const targetIds = Array.isArray(af.target_player_ids) ? af.target_player_ids : [];
  const extraEmails = Array.isArray(af.extra_emails) ? af.extra_emails : [];
  return {
    id: r.id,
    nome: r.name,
    audienceMode: af.audience_mode ?? (targetIds.length > 0 ? "leads" : extraEmails.length > 0 ? "emails" : "segmento"),
    segmento: af.segmento ?? "Todos",
    template: af.template_label ?? "",
    smtp: af.smtp_label ?? "",
    templateId: r.template_id ?? null,
    smtpId: r.smtp_id ?? null,
    agendadoPara: r.scheduled_at ?? undefined,
    status: r.status,
    targetPlayerIds: targetIds,
    extraEmails,
    enviados: stats.enviados ?? 0,
    entregues: stats.entregues ?? 0,
    abertos: stats.abertos ?? 0,
    cliques: stats.cliques ?? 0,
    falhas: stats.falhas ?? 0,
    data: new Date(r.created_at).toLocaleDateString("pt-BR"),
  };
}

export const listEmailCampaigns = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("email_campaigns")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { items: (data ?? []).map(campanhaRowToUI) };
  });

export const saveEmailCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => CampanhaInputSchema.parse(d))
  .handler(async ({ data, context }) => {
    // BusinessCode é um provedor próprio (não SMTP). Normaliza para null
    // para evitar gravar valor não-UUID em smtp_id.
    const smtpIdNorm =
      data.smtpId && data.smtpId !== "businesscode" ? data.smtpId : null;
    const payload: any = {
      name: data.nome,
      audience_filter: {
        audience_mode: data.audienceMode,
        segmento: data.segmento,
        template_label: data.template,
        smtp_label: data.smtp,
        target_player_ids: data.targetPlayerIds ?? [],
        extra_emails: (data.extraEmails ?? []).map((e) => e.trim().toLowerCase()),
      },
      template_id: data.templateId ?? null,
      smtp_id: smtpIdNorm,
      scheduled_at: data.agendadoPara ? new Date(data.agendadoPara).toISOString() : null,
      status: data.status,
    };
    if (data.id) {
      const { error } = await context.supabase
        .from("email_campaigns")
        .update(payload)
        .eq("id", data.id);
      if (error) throw new Error(error.message);
      return { id: data.id };
    }
    const { data: created, error } = await context.supabase
      .from("email_campaigns")
      .insert(payload)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: created.id };
  });

export const updateEmailCampaignStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      id: dbUuid(),
      status: z.enum(["rascunho", "agendada", "enviando", "pausada", "concluida"]),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("email_campaigns")
      .update({ status: data.status })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const duplicateEmailCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: dbUuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: orig, error: oErr } = await context.supabase
      .from("email_campaigns")
      .select("*")
      .eq("id", data.id)
      .single();
    if (oErr) throw new Error(oErr.message);
    const { data: created, error } = await context.supabase
      .from("email_campaigns")
      .insert({
        name: `${orig.name} (cópia)`,
        audience_filter: orig.audience_filter,
        template_id: orig.template_id,
        smtp_id: orig.smtp_id,
        status: "rascunho",
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: created.id };
  });

export const deleteEmailCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: dbUuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("email_campaigns")
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// Conta destinatários de um segmento (pré-visualização no diálogo).
export const previewSegmentCount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        audienceMode: z.enum(["segmento", "leads", "emails"]).default("segmento"),
        segmento: z.string().max(160).optional(),
        targetPlayerIds: z.array(dbUuid()).max(5000).optional(),
        extraEmails: z.array(z.string().email().max(255)).max(5000).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    if (data.audienceMode === "emails") {
      return { total: new Set((data.extraEmails ?? []).map((e) => e.trim().toLowerCase())).size };
    }
    if (data.audienceMode === "leads") {
      if (!data.targetPlayerIds || data.targetPlayerIds.length === 0) return { total: 0 };
      const { data: rows, error } = await context.supabase
        .from("players")
        .select("id, email")
        .in("id", data.targetPlayerIds);
      if (error) throw new Error(error.message);
      const total = (rows ?? []).filter((p: any) => p.email && p.email.trim()).length;
      return { total };
    }
    const total = await countPlayersForSegment(data.segmento || "Todos");
    return { total };
  });

// Busca leads para selecionar manualmente no diálogo de campanha de email.
export const listPlayersForEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        search: z.string().max(120).optional(),
        limit: z.number().int().min(1).max(50).default(20),
        ids: z.array(dbUuid()).max(500).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("players")
      .select("id, nome, email, telefone, status, vip")
      .order("updated_at", { ascending: false })
      .limit(data.limit);
    if (data.ids && data.ids.length > 0) {
      q = q.in("id", data.ids).limit(data.ids.length);
    } else if (data.search && data.search.trim()) {
      const s = data.search.trim();
      q = q.or(`nome.ilike.%${s}%,telefone.ilike.%${s}%,email.ilike.%${s}%`);
    }
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { players: rows ?? [] };
  });

// Dispara o envio em massa de uma campanha agora.
// Retorna estatísticas finais.
export const sendEmailCampaignNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ campaignId: dbUuid() }).parse(d),
  )
  .handler(async ({ data }) => {
    try {
      return await runCampaignSend(data.campaignId);
    } catch (err) {
      await supabaseAdmin
        .from("email_campaigns")
        .update({ status: "rascunho" })
        .eq("id", data.campaignId)
        .eq("status", "enviando");
      throw err;
    }
  });

/** Executor interno reutilizado pela rota pública agendada. */
export async function runCampaignSend(campaignId: string) {
  const { data: camp, error: cErr } = await supabaseAdmin
    .from("email_campaigns")
    .select("*")
    .eq("id", campaignId)
    .maybeSingle();
  if (cErr || !camp) throw new Error("Campanha não encontrada");

  if (!camp.template_id) throw new Error("Selecione um template antes de enviar.");

  const { data: tpl, error: tErr } = await supabaseAdmin
    .from("email_templates")
    .select("*")
    .eq("id", camp.template_id)
    .maybeSingle();
  if (tErr || !tpl) throw new Error("Template da campanha não encontrado.");

  // smtp_id pode ser null quando o usuário escolheu "BusinessCode" como
  // provedor. resolveSender tenta primeiro a tabela `email_senders`
  // (entidade dedicada, independente de SMTP), depois SMTP padrão.
  const sender = await resolveSender(camp.smtp_id ?? null, camp.tenant_id);
  if (!sender) {
    throw new Error(
      "Nenhum remetente configurado. Vá em Email > Remetentes e cadastre um remetente padrão (nome, email e domínio verificado na BusinessCode).",
    );
  }

  const af = (camp.audience_filter ?? {}) as {
    audience_mode?: "segmento" | "leads" | "emails";
    segmento?: string;
    target_player_ids?: string[];
    extra_emails?: string[];
  };
  let players: any[];
  const audienceMode = af.audience_mode ??
    (Array.isArray(af.target_player_ids) && af.target_player_ids.length > 0
      ? "leads"
      : Array.isArray(af.extra_emails) && af.extra_emails.length > 0
      ? "emails"
      : "segmento");
  if (audienceMode === "emails") {
    players = [];
  } else if (audienceMode === "leads") {
    if (!Array.isArray(af.target_player_ids) || af.target_player_ids.length === 0) {
      throw new Error("Selecione pelo menos um lead antes de enviar.");
    }
    const { data: rows, error: pErr } = await supabaseAdmin
      .from("players")
      .select("*")
      .in("id", af.target_player_ids);
    if (pErr) throw new Error(pErr.message);
    players = (rows ?? []).filter((p: any) => p.email && p.email.trim());
  } else {
    const segmento = af.segmento || "Todos";
    players = await loadPlayersForSegment(segmento);
  }

  // Inclui emails avulsos (sem player vinculado), dedup contra a base.
  const baseEmails = new Set(
    players.map((p: any) => String(p.email ?? "").trim().toLowerCase()).filter(Boolean),
  );
  const extras = audienceMode === "leads" ? [] : Array.from(
    new Set((af.extra_emails ?? []).map((e) => String(e).trim().toLowerCase()).filter(Boolean)),
  ).filter((e) => audienceMode === "emails" || !baseEmails.has(e));
  for (const email of extras) {
    players.push({ id: null, email, nome: "" });
  }

  if (players.length === 0) {
    throw new Error("Nenhum destinatário com email foi encontrado para esta campanha.");
  }

  const IMMEDIATE_SEND_LIMIT = 50;
  if (players.length > IMMEDIATE_SEND_LIMIT) {
    await supabaseAdmin
      .from("email_campaigns")
      .update({
        status: "rascunho",
        stats: { enviados: 0, entregues: 0, abertos: 0, cliques: 0, falhas: 0, total: players.length },
      })
      .eq("id", campaignId);
    throw new Error(
      `Esta campanha tem ${players.length} destinatários. Para evitar travamento, envie agora apenas até ${IMMEDIATE_SEND_LIMIT} destinatários ou selecione e-mails/leads específicos.`,
    );
  }

  await supabaseAdmin
    .from("email_campaigns")
    .update({
      status: "enviando",
      stats: { enviados: 0, entregues: 0, abertos: 0, cliques: 0, falhas: 0, total: players.length },
    })
    .eq("id", campaignId);

  let enviados = 0;
  let falhas = 0;
  let pendentes = 0;

  for (const p of players) {
    if (!p.email) continue;
    try {
      const vars = buildPlayerVariables(p);
      const subject = renderTemplate(tpl.subject ?? "", vars);
      const html = renderTemplate(tpl.body_html ?? "", vars);
      const r = await callBusinessCodeEmail({
        to: p.email,
        from: sender.fromEmail,
        fromName: sender.fromName,
        replyTo: sender.replyTo,
        subject,
        html,
        idempotencyKey: crypto.randomUUID(),
      });
      const errSnippet = r.ok
        ? null
        : `status=${(r as any).status ?? "?"} body=${
            typeof r.body === "string" ? r.body.slice(0, 800) : JSON.stringify(r.body).slice(0, 800)
          }`;
      const isTemporary = !r.ok && (r as any).temporary === true;
      await supabaseAdmin.from("email_send_logs").insert({
        to_email: p.email,
        subject,
        status: r.ok ? "sent" : isTemporary ? "pending" : "error",
        error: errSnippet,
        sent_at: r.ok ? new Date().toISOString() : null,
        player_id: p.id,
        campaign_id: campaignId,
        tenant_id: camp.tenant_id,
        provider_response: { status: (r as any).status, body: r.body, idempotency_key: (r as any).idempotencyKey } as never,
      });
      if (r.ok) enviados++;
      else if (isTemporary) {
        pendentes++;
        console.warn("campaign send temporary failure — will retry later", {
          to: p.email,
          status: (r as any).status,
        });
      }
      else {
        falhas++;
        console.error("campaign send failed", { to: p.email, snippet: errSnippet });
      }
    } catch (err) {
      falhas++;
      console.error("campaign send error", err);
      await supabaseAdmin.from("email_send_logs").insert({
        to_email: p.email,
        subject: "",
        status: "error",
        error: String((err as any)?.message ?? err).slice(0, 1000),
        sent_at: null,
        player_id: p.id,
        campaign_id: campaignId,
        tenant_id: camp.tenant_id,
        provider_response: { error: String((err as any)?.message ?? err) } as never,
      });
    }
    // Atualização parcial a cada 25 envios para o usuário acompanhar progresso.
    if ((enviados + falhas) % 25 === 0) {
      await supabaseAdmin
        .from("email_campaigns")
        .update({
          stats: {
            enviados,
            entregues: 0,
            abertos: 0,
            cliques: 0,
            falhas,
            total: players.length,
          },
        })
        .eq("id", campaignId);
    }
    // small breath to avoid bursts
    await new Promise((r) => setTimeout(r, 30));
  }

  await supabaseAdmin
    .from("email_campaigns")
    .update({
      // Falhas temporárias ficam como pendentes no log; não contam como falha
      // definitiva porque o provedor pode aceitar o próximo retry.
      status: "concluida",
      stats: {
        enviados,
        entregues: 0,
        abertos: 0,
        cliques: 0,
        falhas,
        total: players.length,
      },
    })
    .eq("id", campaignId);

  return { enviados, falhas, pendentes, total: players.length };
}

// ============ AUTOMAÇÕES ============

const AutomacaoInputSchema = z.object({
  id: dbUuid().optional(),
  nome: z.string().min(1).max(160),
  gatilho: z.string().max(120),
  template: z.string().max(160).default(""),
  smtp: z.string().max(160).default(""),
  delayMin: z.number().int().min(0).default(0),
  delayMax: z.number().int().min(0).default(24),
  cooldown: z.number().int().min(0).default(72),
  limiteDiario: z.number().int().min(0).default(1000),
  ativo: z.boolean().default(true),
  saidas: z.array(z.string()).default([]),
});

function automacaoRowToUI(r: any) {
  const cfg = r.config ?? {};
  return {
    id: r.id,
    nome: r.name,
    gatilho: r.trigger_name ?? "",
    template: cfg.template_label ?? "",
    smtp: cfg.smtp_label ?? "",
    delayMin: cfg.delayMin ?? 0,
    delayMax: cfg.delayMax ?? 24,
    cooldown: cfg.cooldown ?? 72,
    limiteDiario: cfg.limiteDiario ?? 1000,
    ativo: !!r.is_active,
    saidas: cfg.saidas ?? [],
  };
}

export const listEmailAutomations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("email_automations")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { items: (data ?? []).map(automacaoRowToUI) };
  });

export const saveEmailAutomation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => AutomacaoInputSchema.parse(d))
  .handler(async ({ data, context }) => {
    const payload: any = {
      name: data.nome,
      trigger_name: data.gatilho,
      is_active: data.ativo,
      delay_minutes: data.delayMin * 60,
      config: {
        template_label: data.template,
        smtp_label: data.smtp,
        delayMin: data.delayMin,
        delayMax: data.delayMax,
        cooldown: data.cooldown,
        limiteDiario: data.limiteDiario,
        saidas: data.saidas,
      },
    };
    if (data.id) {
      const { error } = await context.supabase
        .from("email_automations")
        .update(payload)
        .eq("id", data.id);
      if (error) throw new Error(error.message);
      return { id: data.id };
    }
    const { data: created, error } = await context.supabase
      .from("email_automations")
      .insert(payload)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: created.id };
  });

export const toggleEmailAutomation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ id: dbUuid(), is_active: z.boolean() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("email_automations")
      .update({ is_active: data.is_active })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const duplicateEmailAutomation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: dbUuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: orig, error: oErr } = await context.supabase
      .from("email_automations")
      .select("*")
      .eq("id", data.id)
      .single();
    if (oErr) throw new Error(oErr.message);
    const { data: created, error } = await context.supabase
      .from("email_automations")
      .insert({
        name: `${orig.name} (cópia)`,
        trigger_name: orig.trigger_name,
        template_id: orig.template_id,
        smtp_id: orig.smtp_id,
        delay_minutes: orig.delay_minutes,
        is_active: false,
        config: orig.config,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: created.id };
  });

export const deleteEmailAutomation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: dbUuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("email_automations")
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ============================================================
// DASHBOARD
// ============================================================

const DashboardRangeSchema = z
  .object({
    range_days: z.union([z.literal(1), z.literal(7), z.literal(30)]).optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .default({});

function dayKeyUTC(d: Date) {
  // Mantém o nome por compatibilidade, mas agora retorna a chave do dia
  // em horário de Brasília (UTC-3 fixo). Sem isso, envios após 21h BRT
  // pulam para o dia seguinte no gráfico e nos filtros.
  const shifted = new Date(d.getTime() - 3 * 3600 * 1000);
  return shifted.toISOString().slice(0, 10);
}

export const getEmailDashboard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => DashboardRangeSchema.parse(input ?? {}))
  .handler(async ({ data, context }) => {
    // Resolve tenant do usuário autenticado — todas as queries do dashboard
    // DEVEM ser filtradas por tenant para não misturar dados de outros tenants.
    const { data: tenantRow, error: tenantErr } = await context.supabase.rpc(
      "current_tenant_id",
    );
    if (tenantErr) throw new Error(tenantErr.message);
    const tenantId = tenantRow as string | null;
    if (!tenantId) throw new Error("tenant não encontrado para o usuário");
    // Dias YYYY-MM-DD = calendário em Brasília (BRT), não em UTC.
    const { parseBrtDayStart, parseBrtDayEnd, brtDayStart, brtDayEnd } =
      await import("./tz");
    let sinceDate: Date;
    let endDate: Date;
    if (data.from && data.to) {
      sinceDate = parseBrtDayStart(data.from);
      endDate = parseBrtDayStart(data.to);
    } else {
      const rd = data.range_days ?? 7;
      endDate = brtDayStart();
      sinceDate = new Date(endDate.getTime() - (rd - 1) * 86400000);
    }
    const rangeDays = Math.max(
      1,
      Math.round((endDate.getTime() - sinceDate.getTime()) / 86400000) + 1,
    );
    let sinceIso = sinceDate.toISOString();
    const endIso = (data.from && data.to ? parseBrtDayEnd(data.to) : brtDayEnd(endDate)).toISOString();

    let todayStart = new Date(endDate);

    // Respeita o marco "zerar dashboards"
    const { readResetAtAdmin } = await import("@/lib/dashboard-settings.functions");
    const resetAt = await readResetAtAdmin();
    if (resetAt > sinceIso) sinceIso = resetAt;
    if (resetAt > todayStart.toISOString()) todayStart = new Date(resetAt);

    // 1) Logs no período — paginado (PostgREST limita 1000/request).
    const rows: Array<{
      id: string;
      status: string | null;
      created_at: string;
      sent_at: string | null;
      player_id: string | null;
      campaign_id: string | null;
      automation_id: string | null;
      to_email: string | null;
      subject: string | null;
      error: string | null;
    }> = [];
    {
      const PAGE = 1000;
      let offset = 0;
      while (true) {
        const { data: chunk, error: logsErr } = await supabaseAdmin
          .from("email_send_logs")
          .select("id, status, created_at, sent_at, player_id, campaign_id, automation_id, to_email, subject, error")
          .eq("tenant_id", tenantId)
          .gte("created_at", sinceIso)
          .lte("created_at", endIso)
          .order("created_at", { ascending: false })
          .range(offset, offset + PAGE - 1);
        if (logsErr) throw new Error(logsErr.message);
        const got = (chunk ?? []) as typeof rows;
        rows.push(...got);
        if (got.length < PAGE) break;
        offset += PAGE;
        if (offset >= 200_000) break;
      }
    }

    // 2) Pendentes (fila atual — sem janela)
    const { count: pendingCount } = await supabaseAdmin
      .from("email_send_logs")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("status", "pending");

    // 2b) Fila REAL do dispatcher (email_flow_leads prontos pra disparar).
    const { count: queueDue } = await supabaseAdmin
      .from("email_flow_leads")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .in("status", ["pending", "running"])
      .lte("next_run_at", new Date().toISOString());
    const { count: queueTotal } = await supabaseAdmin
      .from("email_flow_leads")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .in("status", ["pending", "running"]);

    // 3) Campanhas ativas (status sending/scheduled)
    const { count: activeCampaigns } = await supabaseAdmin
      .from("email_campaigns")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .in("status", ["sending", "scheduled"]);

    // 4) Saúde SMTP
    const { data: smtp } = await supabaseAdmin
      .from("email_smtp_configs")
      .select("id, status, last_test_ok, is_default, name")
      .eq("tenant_id", tenantId)
      .order("is_default", { ascending: false })
      .limit(1);
    const smtpRow = smtp?.[0];
    const smtpActive = !!smtpRow && (smtpRow.status === "active" || smtpRow.last_test_ok === true);

    const { data: senderRow } = await supabaseAdmin
      .from("email_senders")
      .select("domain, from_email")
      .eq("tenant_id", tenantId)
      .order("is_default", { ascending: false })
      .limit(1)
      .maybeSingle();

    // 5) Conversões: depósitos pós-envio (janela 72h, igual SMS)
    const sentRowsWithPlayer = rows.filter((r) => r.status === "sent" && !!r.player_id);
    const playerIds = Array.from(new Set(sentRowsWithPlayer.map((r) => r.player_id as string)));
    const depositsByPlayer = new Map<string, Array<{ created_at: string }>>();
    if (playerIds.length > 0) {
      const PAGE = 1000;
      let offset = 0;
      while (true) {
        const { data: deps } = await supabaseAdmin
          .from("deposits")
          .select("player_id, created_at")
          .eq("tenant_id", tenantId)
          .in("player_id", playerIds)
          .eq("status", "aprovado")
          .gte("created_at", sinceIso)
          .lte("created_at", endIso)
          .range(offset, offset + PAGE - 1);
        const got = deps ?? [];
        got.forEach((d) => {
          if (!d.player_id) return;
          const arr = depositsByPlayer.get(d.player_id) ?? [];
          arr.push({ created_at: d.created_at });
          depositsByPlayer.set(d.player_id, arr);
        });
        if (got.length < PAGE) break;
        offset += PAGE;
        if (offset >= 200_000) break;
      }
    }

    // Buckets por dia
    const buckets = new Map<string, { enviados: number; entregues: number; falharam: number }>();
    const ensure = (k: string) => {
      let b = buckets.get(k);
      if (!b) {
        b = { enviados: 0, entregues: 0, falharam: 0 };
        buckets.set(k, b);
      }
      return b;
    };

    let sentTotal = 0;
    let deliveredTotal = 0;
    let failedTotal = 0;
    let bouncedTotal = 0;
    let todaySent = 0;
    const uniqueEmailsPeriod = new Set<string>();
    const uniqueEmailsToday = new Set<string>();

    for (const r of rows) {
      const created = new Date(r.created_at);
      const k = dayKeyUTC(created);
      const b = ensure(k);
      const st = (r.status || "").toLowerCase();
      if (st === "sent" || st === "delivered") {
        sentTotal++;
        b.enviados++;
        if (created >= todayStart) todaySent++;
        if (r.to_email) {
          uniqueEmailsPeriod.add(r.to_email);
          if (created >= todayStart) uniqueEmailsToday.add(r.to_email);
        }
      }
      if (st === "delivered") {
        deliveredTotal++;
        b.entregues++;
      }
      if (st === "failed" || st === "error" || st === "dlq") {
        failedTotal++;
        b.falharam++;
      }
      if (st === "bounced" || st === "bounce") {
        bouncedTotal++;
      }
    }

    // Conversões
    const CONVERSION_WINDOW_MS = 72 * 3600 * 1000;
    let conversions = 0;
    const conversionsByDay = new Map<string, number>();
    const countedPlayer = new Set<string>();
    for (const r of sentRowsWithPlayer) {
      const pid = r.player_id as string;
      const sentAt = new Date(r.created_at).getTime();
      const deps = depositsByPlayer.get(pid) ?? [];
      const matched = deps.find((d) => {
        const t = new Date(d.created_at).getTime();
        return t >= sentAt && t <= sentAt + CONVERSION_WINDOW_MS;
      });
      if (matched && !countedPlayer.has(pid)) {
        countedPlayer.add(pid);
        conversions++;
        const k = dayKeyUTC(new Date(matched.created_at));
        conversionsByDay.set(k, (conversionsByDay.get(k) ?? 0) + 1);
      }
    }

    // Série diária completa preenchida
    const by_day: Array<{ date: string; enviados: number; entregues: number; falharam: number }> = [];
    const conversions_by_day: Array<{ date: string; conversoes: number }> = [];
    for (let i = 0; i < rangeDays; i++) {
      const d = new Date(sinceDate);
      d.setUTCDate(d.getUTCDate() + i);
      const k = dayKeyUTC(d);
      const b = buckets.get(k) ?? { enviados: 0, entregues: 0, falharam: 0 };
      by_day.push({ date: k, ...b });
      conversions_by_day.push({ date: k, conversoes: conversionsByDay.get(k) ?? 0 });
    }

    const recent_events = rows.slice(0, 10).map((r) => ({
      id: r.id,
      status: r.status,
      to_email: r.to_email ?? "",
      subject: r.subject ?? null,
      error: r.error ?? null,
      created_at: r.created_at,
    }));

    return {
      totals: {
        sent: sentTotal,
        delivered: deliveredTotal,
        failed: failedTotal,
        bounced: bouncedTotal,
        pending: pendingCount ?? 0,
        queue_due: queueDue ?? 0,
        queue_total: queueTotal ?? 0,
        active_campaigns: activeCampaigns ?? 0,
        conversions,
        opens: 0, // tracking não implementado ainda
        clicks: 0,
        unique_recipients: uniqueEmailsPeriod.size,
      },
      today: {
        sent: todaySent,
        unique_recipients: uniqueEmailsToday.size,
      },
      by_day,
      conversions_by_day,
      health: {
        smtp_active: smtpActive,
        smtp_name: smtpRow?.name ?? null,
        sender_domain: senderRow?.domain ?? senderRow?.from_email?.split("@")[1] ?? null,
      },
      recent_events,
    };
  });

// ============ Histórico de envios ============

const EmailHistorySchema = z.object({
  from: z.string().datetime().optional().nullable(),
  to: z.string().datetime().optional().nullable(),
  status: z.enum(["all", "sent", "error", "pending"]).optional().default("all"),
  search: z.string().max(255).optional().nullable(),
  campaign_id: dbUuid().optional().nullable(),
  limit: z.number().int().min(1).max(200).optional().default(50),
  offset: z.number().int().min(0).max(100000).optional().default(0),
});

export const getEmailHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => EmailHistorySchema.parse(d))
  .handler(async ({ data }) => {
    let q = supabaseAdmin
      .from("email_send_logs")
      .select(
        "id, created_at, sent_at, to_email, subject, status, error, campaign_id, automation_id, player_id, provider_response",
        { count: "exact" },
      )
      .order("created_at", { ascending: false });

    if (data.from) q = q.gte("created_at", data.from);
    if (data.to) q = q.lte("created_at", data.to);
    if (data.status && data.status !== "all") q = q.eq("status", data.status);
    if (data.campaign_id) q = q.eq("campaign_id", data.campaign_id);
    if (data.search && data.search.trim().length > 0) {
      q = q.ilike("to_email", `%${data.search.trim()}%`);
    }
    q = q.range(data.offset, data.offset + data.limit - 1);

    const { data: rows, error, count } = await q;
    if (error) throw new Error(error.message);

    const items = (rows ?? []).map((r) => ({
      id: r.id as string,
      created_at: r.created_at as string,
      sent_at: (r.sent_at as string | null) ?? null,
      recipient: (r.to_email as string | null) ?? "—",
      subject: (r.subject as string | null) ?? "—",
      status: r.status as string,
      campaign_id: (r.campaign_id as string | null) ?? null,
      automation_id: (r.automation_id as string | null) ?? null,
      error_summary:
        r.status === "error"
          ? summarizeProviderError(r.provider_response, r.error as string | null)
          : null,
    }));

    return { items, total: count ?? items.length };
  });