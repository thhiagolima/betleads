// Sugestão de abordagem por IA para um lead na Área do Expert (Fase 2,
// Task 6): a partir do resumo da ficha do lead (Task 2), pede ao mesmo
// provider/modelo de `ai.functions.ts` (Lovable AI Gateway) uma oferta e uma
// mensagem curta para o expert reconquistar o lead.
//
// Fluxo: requireExpertContext -> assertTenantCanSendExternally (casa demo
// nunca chega a chamar o modelo) -> getExpertLeadSheetFor (que roda seu
// próprio requireExpertContext + loadVisibleLead, recusando lead fora de
// alcance antes de qualquer chamada ao modelo) -> monta o prompt só com os
// campos permitidos -> chama o modelo -> faz o parse da resposta.
//
// O prompt nunca leva telefone, nome completo, CPF ou e-mail — só o
// primeiro nome do lead e os campos agregados da ficha.

import { createServerFn } from "@tanstack/react-start";
import { generateText } from "ai";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { LOVABLE_MODEL_ID } from "@/lib/ai.functions";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway";
import { requireExpertContext } from "@/lib/expert-access.server";
import { getExpertLeadSheetFor } from "@/lib/expert-lead-sheet.functions";
import type { ExpertLeadSheet } from "@/lib/expert-lead-sheet";
import { assertTenantCanSendExternally } from "@/lib/tenant-access.server";

const MENSAGEM_MAX = 400;
const RETRY_MESSAGE = "A IA não conseguiu sugerir agora. Tente de novo.";

type ServerContext = {
  userId: string;
  activeTenantId?: string | null;
};

export type ExpertApproachSuggestion = { oferta: string; mensagem: string };

type GenerateArgs = { system: string; prompt: string };
type GenerateFn = (args: GenerateArgs) => Promise<{ text: string }>;
export type SuggestExpertApproachDeps = { generate?: GenerateFn };

const suggestInput = z.object({ playerId: z.string().uuid() });

export const suggestExpertApproach = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => suggestInput.parse(data))
  .handler(async ({ data, context }) =>
    suggestExpertApproachFor(context as unknown as ServerContext, data),
  );

/** Body of `suggestExpertApproach`, exported so it is directly unit-testable. */
export async function suggestExpertApproachFor(
  ctx: ServerContext,
  data: { playerId: string },
  deps: SuggestExpertApproachDeps = {},
): Promise<ExpertApproachSuggestion> {
  const expert = await requireExpertContext(ctx.userId, ctx.activeTenantId);
  await assertTenantCanSendExternally(expert.tenantId);

  // getExpertLeadSheetFor roda seu próprio requireExpertContext +
  // loadVisibleLead: um lead fora do alcance do expert é recusado aqui,
  // antes de qualquer chamada ao modelo.
  const sheet = await getExpertLeadSheetFor(ctx, data);
  const { system, prompt } = buildPrompt(sheet);

  const generate = deps.generate ?? defaultGenerate;

  let text: string;
  try {
    const result = await generate({ system, prompt });
    text = result.text;
  } catch {
    throw new Error(RETRY_MESSAGE);
  }

  try {
    return parseSuggestion(text);
  } catch {
    throw new Error(RETRY_MESSAGE);
  }
}

async function defaultGenerate(args: GenerateArgs): Promise<{ text: string }> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) throw new Error("LOVABLE_API_KEY não configurada.");
  const gateway = createLovableAiGatewayProvider(apiKey);
  const { text } = await generateText({
    model: gateway(LOVABLE_MODEL_ID),
    system: args.system,
    prompt: args.prompt,
  });
  return { text };
}

function firstName(nome: string): string {
  const trimmed = nome.trim();
  const first = trimmed.split(/\s+/)[0];
  return first || trimmed;
}

/**
 * Resumo do lead que vai ao modelo: só os campos agregados da ficha, nunca
 * telefone, nome completo, CPF ou e-mail.
 */
function buildPrompt(sheet: ExpertLeadSheet): { system: string; prompt: string } {
  const { lead } = sheet;
  const primeiroNome = firstName(lead.nome);
  const ultimasEntradas = sheet.timeline
    .slice(0, 10)
    .map((item) => ({ titulo: item.titulo, data: item.at }));
  const resultadoUltimoContato =
    sheet.timeline.find((item) => item.kind === "contato")?.titulo ?? null;

  const resumo = {
    primeiroNome,
    situacao: lead.situacaoLabel,
    nivel: lead.nivel,
    diasSemDepositar: lead.diasSemDepositar,
    totalDepositado: lead.totalDepositado,
    numeroDepositos: lead.depositos,
    ticketMedio: lead.ticketMedio,
    beneficiosRecentes: sheet.beneficios,
    ultimasEntradasDaLinhaDoTempo: ultimasEntradas,
    resultadoUltimoContato,
  };

  const system = `Você é um assistente que ajuda um expert de relacionamento de uma casa de apostas a sugerir uma abordagem para reconquistar um lead.
Responda SOMENTE com um JSON válido no formato {"oferta": string, "mensagem": string}, sem nenhum texto fora do JSON e sem markdown.
"oferta" é o nome curto da oferta sugerida. "mensagem" é o texto a ser enviado ao lead, em português brasileiro, com no máximo 400 caracteres, podendo conter o placeholder literal {link}.
Baseie a sugestão apenas nos dados fornecidos abaixo. Nunca peça, mencione ou invente telefone, CPF, e-mail ou sobrenome do lead — use só o primeiro nome dado.`;

  const prompt = `Dados do lead (primeiro nome: ${primeiroNome}):\n${JSON.stringify(resumo)}`;

  return { system, prompt };
}

/** Remove um possível cercado ```json ... ``` antes do JSON.parse. */
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

function parseSuggestion(raw: string): ExpertApproachSuggestion {
  const parsed: unknown = JSON.parse(stripCodeFence(raw));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).oferta !== "string" ||
    typeof (parsed as Record<string, unknown>).mensagem !== "string"
  ) {
    throw new Error("Resposta do modelo fora do formato esperado.");
  }
  const { oferta, mensagem } = parsed as { oferta: string; mensagem: string };
  return { oferta, mensagem: mensagem.slice(0, MENSAGEM_MAX) };
}
