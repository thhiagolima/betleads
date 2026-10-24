// Modelos de mensagem e texto pronto para o WhatsApp (Área do Expert, Fase 2,
// Task 4): o expert mantém seus próprios modelos e pode copiar, só para
// leitura, os `sms_templates` ativos da casa. `renderExpertMessage` monta o
// texto final substituindo as variáveis do lead (`buildPlayerVariables` +
// `renderTemplate`, `template-vars.server.ts`) e o `{link}` — que só pode
// ser um link já gerado pelo próprio expert para aquele lead
// (`expert_links.sent_url`), nunca um link colado à mão sem rastreio.
//
// `expert_message_templates` (migration 20261027100000) ainda não está nos
// tipos gerados do Supabase, por isso `(supabaseAdmin as any)`.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { ExpertAccessError, requireExpertContext } from "@/lib/expert-access.server";
import { loadVisibleLead, type VisibleLead } from "@/lib/expert-lead-access.server";
import { loadHouseLinks } from "@/lib/house-links.server";
import {
  isExpertSupportedVariable,
  unsupportedExpertVariables,
} from "@/lib/expert-template-variables";
import { buildPlayerVariables, renderTemplate, type PlayerVarsInput } from "@/lib/template-vars.server";
import { dbUuid } from "@/lib/zod-helpers";

type ServerContext = {
  userId: string;
  activeTenantId?: string | null;
};

export type ExpertTemplate = {
  id: string;
  nome: string;
  conteudo: string;
  origem: "meu" | "casa";
};

const NOT_FOUND = "Modelo não encontrado.";
const DUPLICATE_NAME = "Você já tem um modelo com esse nome.";
const MISSING_LINK = "Gere o link da oferta antes de usar {link}.";

function db() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- expert_message_templates is not in the generated types yet
  return supabaseAdmin as any;
}

type ExpertTemplateRow = {
  id: string;
  nome: string;
  conteudo: string;
};

type SmsTemplateRow = {
  id: string;
  name: string;
  content: string;
};

function isUniqueViolation(error: { code?: string } | null | undefined) {
  return error?.code === "23505";
}

// ------------------------------------------------------------- list

export const listExpertTemplates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => listExpertTemplatesFor(context as unknown as ServerContext));

export async function listExpertTemplatesFor(
  ctx: ServerContext,
): Promise<{ meus: ExpertTemplate[]; casa: ExpertTemplate[] }> {
  const expert = await requireExpertContext(ctx.userId, ctx.activeTenantId);

  const { data: meusRows, error: meusError } = await db()
    .from("expert_message_templates")
    .select("id,nome,conteudo")
    .eq("expert_id", expert.expertId)
    .order("updated_at", { ascending: false });
  if (meusError) throw new Error(meusError.message);

  const { data: casaRows, error: casaError } = await db()
    .from("sms_templates")
    .select("id,name,content")
    .eq("tenant_id", expert.tenantId)
    .eq("is_active", true)
    .order("updated_at", { ascending: false });
  if (casaError) throw new Error(casaError.message);

  return {
    meus: ((meusRows ?? []) as ExpertTemplateRow[]).map((row) => ({
      id: row.id,
      nome: row.nome,
      conteudo: row.conteudo,
      origem: "meu" as const,
    })),
    casa: ((casaRows ?? []) as SmsTemplateRow[]).map((row) => ({
      id: row.id,
      nome: row.name,
      conteudo: row.content,
      origem: "casa" as const,
    })),
  };
}

// ------------------------------------------------------------- save

const saveTemplateInput = z.object({
  id: dbUuid().optional(),
  nome: z.string().trim().min(2).max(60),
  conteudo: z.string().min(1).max(1000),
});

export type SaveExpertTemplateInput = z.input<typeof saveTemplateInput>;

export const saveExpertTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => saveTemplateInput.parse(data))
  .handler(async ({ data, context }) =>
    saveExpertTemplateFor(context as unknown as ServerContext, data),
  );

export async function saveExpertTemplateFor(
  ctx: ServerContext,
  data: SaveExpertTemplateInput,
): Promise<{ id: string }> {
  const input = saveTemplateInput.parse(data);
  const expert = await requireExpertContext(ctx.userId, ctx.activeTenantId);

  if (input.id) {
    const { data: existing, error: readError } = await db()
      .from("expert_message_templates")
      .select("id")
      .eq("id", input.id)
      .eq("expert_id", expert.expertId)
      .maybeSingle();
    if (readError) throw new Error(readError.message);
    if (!existing) throw new ExpertAccessError(NOT_FOUND);

    const { error } = await db()
      .from("expert_message_templates")
      .update({ nome: input.nome, conteudo: input.conteudo })
      .eq("id", input.id)
      .eq("expert_id", expert.expertId);
    if (error) {
      if (isUniqueViolation(error)) throw new Error(DUPLICATE_NAME);
      throw new Error(error.message);
    }
    return { id: input.id };
  }

  const id = crypto.randomUUID();
  const { error } = await db()
    .from("expert_message_templates")
    .insert({
      id,
      tenant_id: expert.tenantId,
      expert_id: expert.expertId,
      nome: input.nome,
      conteudo: input.conteudo,
    });
  if (error) {
    if (isUniqueViolation(error)) throw new Error(DUPLICATE_NAME);
    throw new Error(error.message);
  }
  return { id };
}

// ------------------------------------------------------------- delete

const deleteTemplateInput = z.object({
  id: dbUuid(),
});

export const deleteExpertTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => deleteTemplateInput.parse(data))
  .handler(async ({ data, context }) =>
    deleteExpertTemplateFor(context as unknown as ServerContext, data),
  );

export async function deleteExpertTemplateFor(
  ctx: ServerContext,
  data: z.input<typeof deleteTemplateInput>,
): Promise<{ ok: true }> {
  const input = deleteTemplateInput.parse(data);
  const expert = await requireExpertContext(ctx.userId, ctx.activeTenantId);

  const { data: existing, error: readError } = await db()
    .from("expert_message_templates")
    .select("id")
    .eq("id", input.id)
    .eq("expert_id", expert.expertId)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  if (!existing) throw new ExpertAccessError(NOT_FOUND);

  const { error } = await db()
    .from("expert_message_templates")
    .delete()
    .eq("id", input.id)
    .eq("expert_id", expert.expertId);
  if (error) throw new Error(error.message);
  return { ok: true };
}

// ------------------------------------------------------------- copy from house

const copyHouseTemplateInput = z.object({
  smsTemplateId: dbUuid(),
});

export const copyHouseTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => copyHouseTemplateInput.parse(data))
  .handler(async ({ data, context }) =>
    copyHouseTemplateFor(context as unknown as ServerContext, data),
  );

export async function copyHouseTemplateFor(
  ctx: ServerContext,
  data: z.input<typeof copyHouseTemplateInput>,
): Promise<{ id: string }> {
  const input = copyHouseTemplateInput.parse(data);
  const expert = await requireExpertContext(ctx.userId, ctx.activeTenantId);

  const { data: original, error: readError } = await db()
    .from("sms_templates")
    .select("name,content")
    .eq("id", input.smsTemplateId)
    .eq("tenant_id", expert.tenantId)
    .eq("is_active", true)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  if (!original) throw new ExpertAccessError(NOT_FOUND);

  const nome = `${(original as SmsTemplateRow).name} (cópia)`.slice(0, 60);
  const conteudo = (original as SmsTemplateRow).content;

  const id = crypto.randomUUID();
  const { error } = await db()
    .from("expert_message_templates")
    .insert({
      id,
      tenant_id: expert.tenantId,
      expert_id: expert.expertId,
      nome,
      conteudo,
    });
  if (error) {
    if (isUniqueViolation(error)) throw new Error(DUPLICATE_NAME);
    throw new Error(error.message);
  }
  return { id };
}

// ------------------------------------------------------------- render

const renderMessageInput = z.object({
  playerId: dbUuid(),
  conteudo: z.string().min(1).max(1000),
  link: z.string().trim().min(1).optional(),
});

export type RenderExpertMessageInput = z.input<typeof renderMessageInput>;

export const renderExpertMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => renderMessageInput.parse(data))
  .handler(async ({ data, context }) =>
    renderExpertMessageFor(context as unknown as ServerContext, data),
  );

/** Monta `PlayerVarsInput` a partir do que `VisibleLead` carrega, mais o
 * nome do expert. Campos que `VisibleLead` não tem (login/jogo, e-mail, saldo
 * de carteira, status) não são carregados — nunca se amplia `VisibleLead`
 * para colunas sensíveis por causa disto; as variáveis correspondentes são
 * removidas antes de renderizar (`expert-template-variables.ts`) e ficam
 * literais, bloqueando o envio. */
function leadToPlayerVars(lead: VisibleLead, expertNome: string): PlayerVarsInput {
  return {
    expert: expertNome,
    nome: lead.nome,
    telefone: lead.telefone,
    ultimo_deposito: lead.ultimo_deposito,
    total_depositado: lead.total_depositado,
    total_sacado: lead.total_sacado,
    vip: lead.vip,
    risco: lead.risco,
    last_cashback_amount: lead.last_cashback_amount,
    last_cashback_paid_at: lead.last_cashback_paid_at,
  };
}

export async function renderExpertMessageFor(
  ctx: ServerContext,
  data: RenderExpertMessageInput,
): Promise<{ texto: string; faltaLink: boolean; variaveisNaoSuportadas: string[] }> {
  const input = renderMessageInput.parse(data);
  const expert = await requireExpertContext(ctx.userId, ctx.activeTenantId);
  const lead = await loadVisibleLead(expert, input.playerId);

  if (input.link) {
    const { data: linkRow, error: linkError } = await db()
      .from("expert_links")
      .select("id")
      .eq("expert_id", expert.expertId)
      .eq("player_id", lead.id)
      .eq("sent_url", input.link)
      .maybeSingle();
    if (linkError) throw new Error(linkError.message);
    if (!linkRow) throw new Error(MISSING_LINK);
  }

  const house = await loadHouseLinks(expert.tenantId);
  const vars = buildPlayerVariables(leadToPlayerVars(lead, expert.nome), house);
  const houseHasSite = !!house?.siteUrl;
  // Variável que só sairia com o valor padrão inventado fica literal.
  for (const key of Object.keys(vars)) {
    if (key !== "link" && !isExpertSupportedVariable(key, { houseHasSite })) delete vars[key];
  }
  if (input.link) {
    vars.link = input.link;
  } else {
    delete vars.link;
  }

  const texto = renderTemplate(input.conteudo, vars, house);
  const faltaLink = input.conteudo.includes("{link}") && !input.link;
  const variaveisNaoSuportadas = unsupportedExpertVariables(input.conteudo, { houseHasSite });

  return { texto, faltaLink, variaveisNaoSuportadas };
}
