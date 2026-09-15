// Server function: gera conteúdo de email (assunto, pré-header, corpo, CTA)
// via Lovable AI Gateway (sem expor chave no cliente).

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const InputSchema = z.object({
  gatilho: z.string().min(1).max(200),
  beneficio: z.string().max(300).default(""),
  tom: z.enum(["amigavel", "urgente", "premium", "direto", "casual"]).default("amigavel"),
  link: z.string().max(300).default(""),
  cupom: z.string().max(60).default(""),
  modelo: z.string().max(40).default("simples"),
});

export const generateEmailContent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => InputSchema.parse(d))
  .handler(async ({ data }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) {
      throw new Error("LOVABLE_API_KEY não configurado.");
    }

    const sys = `Você é um copywriter especialista em email marketing para iGaming (cassino / apostas) no Brasil.
Gere copies CURTAS, em português brasileiro, com tom apropriado.
Use variáveis literais entre chaves quando útil: {primeiro_nome}, {saldo}, {ultimo_login}.
Nunca prometa ganhos garantidos. Sem emojis em excesso (máximo 1 no assunto).`;

    const user = `Gere o conteúdo de um email com base em:
- Objetivo / gatilho: ${data.gatilho}
- Benefício / oferta: ${data.beneficio || "(não informado)"}
- Tom: ${data.tom}
- Modelo visual: ${data.modelo}
- Cupom: ${data.cupom || "(nenhum)"}
- Link de destino: ${data.link || "{link_login}"}

Responda chamando a função "email_copy" com os campos.`;

    const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "email_copy",
              description: "Retorna copy estruturada do email.",
              parameters: {
                type: "object",
                properties: {
                  assunto: { type: "string", description: "Assunto curto, máx 70 chars." },
                  preheader: { type: "string", description: "Pré-header, máx 110 chars." },
                  titulo: { type: "string", description: "Título principal dentro do email." },
                  texto: { type: "string", description: "Corpo do email, 2-3 frases." },
                  cta: { type: "string", description: "Texto do botão, 2-5 palavras." },
                },
                required: ["assunto", "preheader", "titulo", "texto", "cta"],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "email_copy" } },
      }),
    });

    if (resp.status === 429) {
      throw new Error("Limite de requisições atingido. Tente novamente em alguns segundos.");
    }
    if (resp.status === 402) {
      throw new Error("Créditos de IA esgotados. Adicione créditos em Settings → Workspace → Usage.");
    }
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`Erro na IA (${resp.status}): ${t.slice(0, 200)}`);
    }

    const json: any = await resp.json();
    const call = json?.choices?.[0]?.message?.tool_calls?.[0];
    if (!call) throw new Error("IA não retornou estrutura esperada.");
    let args: any;
    try {
      args = JSON.parse(call.function?.arguments ?? "{}");
    } catch {
      throw new Error("IA retornou JSON inválido.");
    }
    return {
      assunto: String(args.assunto ?? ""),
      preheader: String(args.preheader ?? ""),
      titulo: String(args.titulo ?? ""),
      texto: String(args.texto ?? ""),
      cta: String(args.cta ?? "Acessar"),
    };
  });
