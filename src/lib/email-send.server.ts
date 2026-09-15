// Integração com a API de Email BusinessCode.
// POST https://dash.businesscode.com.br/api/v1/messaging/email
// Headers: Authorization: Bearer <TOKEN>, Idempotency-Key: <uuid>, Content-Type: application/json
// Body: { to, from, from_name?, reply_to?, subject, content (HTML) }
// O domínio do "from" precisa estar verificado em Configurações > Domínios na BusinessCode.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { augmentEmailHtml, isSuppressed } from "./email-deliverability.server";

export const BUSINESSCODE_EMAIL_URL =
  "https://dash.businesscode.com.br/api/v1/messaging/email";

export const BUSINESSCODE_DISPATCH_URL =
  "https://dash.businesscode.com.br/api/v1/messaging/dispatches";

function normalizeBusinessCodeToken(raw: string): string {
  let t = (raw || "").replace(/[\u200B-\u200D\uFEFF]/g, "");
  t = t.trim().replace(/^['"]+|['"]+$/g, "").trim();
  t = t.replace(/^Authorization\s*:\s*/i, "").trim();
  t = t.replace(/^Bearer\s+/i, "").trim();
  t = t.replace(/\s+/g, "");
  return t;
}

export type SendEmailInput = {
  to: string;
  from: string;
  fromName?: string | null;
  replyTo?: string | null;
  subject: string;
  html: string;
  idempotencyKey?: string;
};

export type SendEmailResult = {
  ok: boolean;
  status: number;
  body: unknown;
  idempotencyKey: string;
  /** true quando a falha é transitória (5xx/erro de rede) e o envio pode ser tentado novamente depois. */
  temporary?: boolean;
};

/** Remove script/iframe/handlers inline e javascript: para reduzir vetor de XSS. */
export function sanitizeEmailHtml(html: string): string {
  if (!html) return "";
  let out = html;
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  out = out.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "");
  out = out.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "");
  out = out.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "");
  out = out.replace(/javascript:/gi, "");
  return out;
}

/**
 * Reescreve URLs relativas em `<img>`, `<a>`, `background`, `srcset` e
 * `url(...)` de `style` para URLs absolutas usando `baseUrl`.
 *
 * Clientes de email (Gmail, Outlook) não têm "documento base", então
 * `src="/algo"` ou `src="./algo"` quebra. Esquemas seguros (`http(s):`,
 * `data:`, `cid:`, `mailto:`, `tel:`) são preservados. `src="blob:..."`
 * é removido (nunca funciona fora do navegador que o criou).
 */
export function absolutizeEmailUrls(html: string, baseUrl: string): string {
  if (!html) return "";
  const base = baseUrl.replace(/\/+$/, "");
  const isAbsolute = (u: string) =>
    /^(https?:|data:|cid:|mailto:|tel:|#)/i.test(u);
  const toEmailImg = (u: string): string => {
    // Reescreve qualquer URL que aponte para o storage de assets
    // (`/__l5e/assets-v1/<id>/<file>`) — em qualquer host — para o
    // proxy público `/api/public/email-img/<id>/<file>`, que serve
    // bytes limpos sem cookies/CSP para clientes de email.
    try {
      const m = u.match(/__l5e\/assets-v1\/([^\/?#]+)\/([^?#]+)/i);
      if (!m) return u;
      const [, assetId, rawName] = m;
      const safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, "_");
      return `${base}/api/public/email-img/${assetId}/${encodeURIComponent(safeName)}`;
    } catch {
      return u;
    }
  };
  const toAbs = (u: string): string => {
    const v = u.trim();
    if (!v) return v;
    if (v.startsWith("//")) return toEmailImg(`https:${v}`);
    if (isAbsolute(v)) return toEmailImg(v);
    if (v.startsWith("blob:")) return ""; // sinaliza remoção
    if (v.startsWith("/")) return toEmailImg(`${base}${v}`);
    // caminhos relativos ./algo, algo.png
    return toEmailImg(`${base}/${v.replace(/^\.?\/?/, "")}`);
  };
  const rewriteAttr = (attr: string) =>
    new RegExp(`(\\s${attr}\\s*=\\s*)(["'])([^"']*)\\2`, "gi");

  let out = html;

  // src / href / background / poster
  for (const attr of ["src", "href", "background", "poster"]) {
    out = out.replace(rewriteAttr(attr), (_m, p, q, v) => {
      const abs = toAbs(v);
      if (abs === "" && v.startsWith("blob:")) {
        console.warn("Email image with blob: URL removed", { snippet: v.slice(0, 80) });
        return `${p}${q}${q}`;
      }
      return `${p}${q}${abs}${q}`;
    });
  }

  // srcset="url1 1x, url2 2x"
  out = out.replace(rewriteAttr("srcset"), (_m, p, q, v) => {
    const parts = v
      .split(",")
      .map((part: string) => {
        const trimmed = part.trim();
        const [u, ...rest] = trimmed.split(/\s+/);
        return `${toAbs(u)}${rest.length ? " " + rest.join(" ") : ""}`;
      })
      .join(", ");
    return `${p}${q}${parts}${q}`;
  });

  // url(...) em atributos style
  out = out.replace(
    /url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi,
    (_m, q, v) => `url(${q}${toAbs(v)}${q})`,
  );

  return out;
}

function getEmailBaseUrl(): string {
  return (
    process.env.PUBLIC_APP_URL ||
    process.env.VITE_PUBLIC_APP_URL ||
    "https://betleads.io"
  ).replace(/\/+$/, "");
}

/**
 * Blindagem global contra Gmail mobile / dark mode forçando fundo claro.
 *
 * - Injeta <meta color-scheme> e <style> de proteção no <head>.
 * - Força bgcolor + style inline em <html> e <body>.
 * - Garante um wrapper externo (table.email-bg) com fundo escuro.
 *
 * Não altera textos, banners, links, assunto ou pré-header — apenas
 * adiciona atributos/CSS de fundo para impedir que o Gmail mobile inverta
 * as cores do template.
 */
export function shieldDarkEmailHtml(html: string): string {
  // Revertido: nenhuma transformacao global de cor/fundo. O HTML do
  // template eh enviado exatamente como veio (apos sanitize). Isso
  // restaura o visual aprovado no desktop. Ajustes para Gmail mobile
  // devem ser feitos no proprio template, nao aqui.
  return html || "";
}

export async function callBusinessCodeEmail(
  input: SendEmailInput,
): Promise<SendEmailResult> {
  const smsToken = process.env.BUSINESSCODE_SMS_TOKEN;
  const emailToken = process.env.BUSINESSCODE_EMAIL_TOKEN;
  const token = emailToken || smsToken;
  const normalizedToken = token ? normalizeBusinessCodeToken(token) : "";
  const tokenSource = emailToken
    ? "BUSINESSCODE_EMAIL_TOKEN"
    : smsToken
    ? "BUSINESSCODE_SMS_TOKEN"
    : "none";
  if (!normalizedToken) {
    console.error("Email BusinessCode token missing");
    return {
      ok: false,
      status: 0,
      body: { error: "BUSINESSCODE_EMAIL_TOKEN não configurado" },
      idempotencyKey: "",
    };
  }
  const tokenPreview =
    normalizedToken.length > 8
      ? `${normalizedToken.slice(0, 4)}…${normalizedToken.slice(-4)}(len=${normalizedToken.length})`
      : `len=${normalizedToken.length}`;
  const idempotencyKey = input.idempotencyKey || crypto.randomUUID();
  // Bloqueia envio para emails na suppression list (descadastrados / bounces).
  // Fail-open: se a checagem der erro, segue.
  try {
    if (await isSuppressed(input.to)) {
      console.info("Email skip (suprimido)", { to: input.to });
      return {
        ok: false,
        status: 200,
        body: { suppressed: true, reason: "recipient_in_suppression_list" },
        idempotencyKey,
        temporary: false,
      };
    }
  } catch {
    /* fail-open */
  }

  // Aumenta o HTML com rodapé de descadastro + marcador único por destinatário.
  const { html: augmentedHtml } = await augmentEmailHtml(input.html, {
    email: input.to,
  });

  const payload: Record<string, unknown> = {
    to: input.to,
    from: input.from,
    subject: input.subject,
    content: shieldDarkEmailHtml(
      absolutizeEmailUrls(sanitizeEmailHtml(augmentedHtml), getEmailBaseUrl()),
    ),
  };
  if (input.fromName) payload.from_name = input.fromName;
  if (input.replyTo) payload.reply_to = input.replyTo;

  // DEBUG: log do HTML final enviado para investigar fundo branco no Gmail mobile.
  // Mostra tamanho, primeiros 1500 chars e ultimos 800 chars para confirmar se ha
  // algum wrapper adicionado por fora do template original.
  try {
    const finalHtml = String(payload.content ?? "");
    const imgSrcs = Array.from(
      finalHtml.matchAll(/<img[^>]+src=["']([^"']+)["']/gi),
    ).map((m) => m[1]);
    console.info("Email BusinessCode FINAL HTML preview", {
      to: input.to,
      subject: input.subject,
      htmlLength: finalHtml.length,
      inputHtmlLength: (input.html || "").length,
      changedBySanitize: finalHtml !== (input.html || ""),
      imgCount: imgSrcs.length,
      imgSrcs,
      htmlStart: finalHtml.slice(0, 1500),
      htmlEnd: finalHtml.slice(-800),
    });
  } catch {}

  let res: Response;
  const maxAttempts = 6;
  let attempt = 0;
  let lastErr: unknown = null;
  // Retry em falhas transitórias do provedor (5xx, ex.: 526 SSL/Cloudflare)
  // e erros de rede. 4xx não tenta de novo (são determinísticos).
  while (true) {
    attempt++;
    try {
      console.info("Email BusinessCode request", {
        to: input.to,
        idempotencyKey,
        tokenSource,
        tokenPreview,
        attempt,
      });
      res = await fetch(BUSINESSCODE_EMAIL_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${normalizedToken}`,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      lastErr = err;
      console.error("Email BusinessCode failed before response", {
        to: input.to,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 800 * attempt));
        continue;
      }
      return {
        ok: false,
        status: 0,
        body: { error: err instanceof Error ? err.message : String(err), attempts: attempt },
        idempotencyKey,
        temporary: true,
      };
    }
    if (res.status >= 500 && res.status <= 599 && attempt < maxAttempts) {
      console.warn("Email BusinessCode 5xx — retrying", {
        to: input.to,
        idempotencyKey,
        status: res.status,
        attempt,
      });
      await new Promise((r) => setTimeout(r, 800 * attempt));
      continue;
    }
    break;
  }
  void lastErr;

  let body: unknown = null;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = {
      non_json: true,
      content_type: res.headers.get("content-type") ?? null,
      snippet: text.slice(0, 400),
    };
  }
  // Enriquecer body com info de tentativas e mensagem clara quando 526/5xx persistir.
  if (!res.ok && res.status >= 500) {
    const note =
      res.status === 526
        ? "Falha temporária na BusinessCode (526 — handshake TLS/SSL com o endpoint dash.businesscode.com.br falhou). Tentado " +
          attempt +
          " vezes sem sucesso. Vamos tentar de novo automaticamente."
        : "BusinessCode retornou " + res.status + " após " + attempt + " tentativas.";
    body = {
      provider_error: note,
      status: res.status,
      attempts: attempt,
      endpoint: BUSINESSCODE_EMAIL_URL,
      raw: body,
    };
  }
  console.info("Email BusinessCode response", {
    to: input.to,
    idempotencyKey,
    status: res.status,
    ok: res.ok,
    tokenSource,
    attempts: attempt,
  });
  const temporary =
    !res.ok && (res.status === 0 || res.status >= 500 || res.status === 401 || res.status === 403 || res.status === 429);
  return { ok: res.ok, status: res.status, body, idempotencyKey, temporary };
}

/**
 * Envia 1 email (mesmo subject + html) para N destinatários em uma única
 * chamada HTTP usando /messaging/dispatches da BusinessCode.
 */
export async function callBusinessCodeEmailDispatch(args: {
  subject: string;
  html: string;
  from: string;
  fromName?: string | null;
  replyTo?: string | null;
  recipients: string[];
  idempotencyKey?: string;
}): Promise<{
  ok: boolean;
  status: number;
  body: unknown;
  idempotencyKey: string;
  dispatchId: string | null;
  temporary?: boolean;
}> {
  const smsToken = process.env.BUSINESSCODE_SMS_TOKEN;
  const emailToken = process.env.BUSINESSCODE_EMAIL_TOKEN;
  const token = emailToken || smsToken;
  const normalizedToken = token ? normalizeBusinessCodeToken(token) : "";
  if (!normalizedToken) {
    return {
      ok: false,
      status: 0,
      body: { error: "BUSINESSCODE_EMAIL_TOKEN não configurado" },
      idempotencyKey: "",
      dispatchId: null,
    };
  }
  const idempotencyKey = args.idempotencyKey || crypto.randomUUID();
  // Filtra destinatários na suppression list (fail-open).
  let recipients = args.recipients;
  try {
    const checks = await Promise.all(
      args.recipients.map(async (r) => ({ r, sup: await isSuppressed(r) })),
    );
    recipients = checks.filter((c) => !c.sup).map((c) => c.r);
    const removed = args.recipients.length - recipients.length;
    if (removed > 0) {
      console.info("Email bulk dispatch — suprimidos removidos", { removed, total: args.recipients.length });
    }
    if (recipients.length === 0) {
      return {
        ok: false,
        status: 200,
        body: { suppressed_all: true, removed },
        idempotencyKey,
        dispatchId: null,
        temporary: false,
      };
    }
  } catch {
    /* fail-open: usa lista original */
  }

  const payload: Record<string, unknown> = {
    to: recipients,
    from: args.from,
    subject: args.subject,
    content: shieldDarkEmailHtml(
      absolutizeEmailUrls(sanitizeEmailHtml(args.html), getEmailBaseUrl()),
    ),
    channel: "email",
  };
  if (args.fromName) payload.from_name = args.fromName;
  if (args.replyTo) payload.reply_to = args.replyTo;

  const maxAttempts = 3;
  let attempt = 0;
  let res: Response;
  while (true) {
    attempt++;
    try {
      res = await fetch(BUSINESSCODE_DISPATCH_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${normalizedToken}`,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
        continue;
      }
      return {
        ok: false,
        status: 0,
        body: { error: err instanceof Error ? err.message : String(err), attempts: attempt },
        idempotencyKey,
        dispatchId: null,
        temporary: true,
      };
    }
    if (res.status >= 500 && res.status <= 599 && attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
      continue;
    }
    break;
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { non_json: true, snippet: text.slice(0, 300) };
  }
  let dispatchId: string | null = null;
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    const cand =
      o.dispatch_id ??
      o.dispatchId ??
      o.id ??
      (o.data && typeof o.data === "object"
        ? (o.data as Record<string, unknown>).dispatch_id ??
          (o.data as Record<string, unknown>).id
        : null);
    if (typeof cand === "string" || typeof cand === "number") dispatchId = String(cand);
  }
  console.info("Email BusinessCode bulk dispatch", {
    status: res.status,
    ok: res.ok,
    recipients: args.recipients.length,
    dispatchId,
    attempts: attempt,
  });
  const temporary =
    !res.ok && (res.status === 0 || res.status >= 500 || res.status === 401 || res.status === 403 || res.status === 429);
  return { ok: res.ok, status: res.status, body, idempotencyKey, dispatchId, temporary };
}

/**
 * Resolve remetente.
 *
 * Ordem de prioridade:
 * 1. Se `smtpId` for um UUID válido, busca em `email_smtp_configs` por esse id.
 * 2. Tenta o remetente padrão em `email_senders` (entidade dedicada — ideal
 *    para uso com a API BusinessCode, sem precisar de SMTP).
 * 3. Fallback: SMTP marcado como padrão (compatibilidade retroativa).
 */
export async function resolveSender(
  smtpId?: string | null,
  tenantId?: string | null,
): Promise<{
  fromEmail: string;
  fromName: string | null;
  replyTo: string | null;
} | null> {
  // 1) SMTP específico por id
  if (smtpId) {
    const { data, error } = await supabaseAdmin
      .from("email_smtp_configs")
      .select("from_email, from_name, config")
      .eq("id", smtpId)
      .maybeSingle();
    if (!error && data) {
      const cfg = (data.config ?? {}) as { replyTo?: string };
      return {
        fromEmail: data.from_email,
        fromName: data.from_name ?? null,
        replyTo: cfg.replyTo || null,
      };
    }
  }

  // 2) Remetente padrão da nova tabela email_senders (filtrado por tenant)
  const senderQuery = supabaseAdmin
    .from("email_senders")
    .select("from_email, from_name, reply_to")
    .eq("is_default", true)
    .limit(1);
  if (tenantId) {
    senderQuery.eq("tenant_id", tenantId);
  }
  const { data: sender } = await senderQuery.maybeSingle();
  if (sender) {
    return {
      fromEmail: sender.from_email,
      fromName: sender.from_name ?? null,
      replyTo: sender.reply_to ?? null,
    };
  }

  // 3) Fallback: SMTP padrão (filtrado por tenant)
  const smtpQuery = supabaseAdmin
    .from("email_smtp_configs")
    .select("from_email, from_name, config")
    .eq("is_default", true)
    .limit(1);
  if (tenantId) {
    smtpQuery.eq("tenant_id", tenantId);
  }
  const { data: smtp } = await smtpQuery.maybeSingle();
  if (smtp) {
    const cfg = (smtp.config ?? {}) as { replyTo?: string };
    return {
      fromEmail: smtp.from_email,
      fromName: smtp.from_name ?? null,
      replyTo: cfg.replyTo || null,
    };
  }

  return null;
}