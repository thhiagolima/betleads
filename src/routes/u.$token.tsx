import { createFileRoute, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { createServerFn } from "@tanstack/react-start";
import { useServerFn } from "@tanstack/react-start";
import { z } from "zod";

// ---- server fns (sem auth — público) ----

const TokenInput = z.object({ token: z.string().min(8).max(128) });

export const lookupUnsubscribe = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => TokenInput.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row } = await supabaseAdmin
      .from("email_unsubscribe_tokens")
      .select("email, used_at")
      .eq("token", data.token)
      .maybeSingle();
    if (!row) return { ok: false as const, reason: "not_found" as const };
    // mascarando o email no retorno (j***@dominio.com)
    const email = row.email as string;
    const [u, dom] = email.split("@");
    const masked = u ? `${u[0]}${"*".repeat(Math.max(1, u.length - 2))}${u.slice(-1)}@${dom}` : email;
    return {
      ok: true as const,
      masked,
      alreadyUsed: !!row.used_at,
    };
  });

export const confirmUnsubscribe = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => TokenInput.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { suppressEmail } = await import("@/lib/email-deliverability.server");
    const { data: row } = await supabaseAdmin
      .from("email_unsubscribe_tokens")
      .select("email, tenant_id, used_at")
      .eq("token", data.token)
      .maybeSingle();
    if (!row) return { ok: false as const, reason: "not_found" as const };
    if (!row.used_at) {
      await supabaseAdmin
        .from("email_unsubscribe_tokens")
        .update({ used_at: new Date().toISOString() })
        .eq("token", data.token);
    }
    await suppressEmail(row.email as string, "unsubscribe", (row.tenant_id as string | null) ?? null, "user clicked unsubscribe link");
    return { ok: true as const };
  });

// ---- rota ----

export const Route = createFileRoute("/u/$token")({
  head: () => ({
    meta: [
      { title: "Descadastrar email" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  loader: async ({ params }) => lookupUnsubscribe({ data: { token: params.token } }),
  component: UnsubscribePage,
});

function UnsubscribePage() {
  const { token } = useParams({ from: "/u/$token" });
  const initial = Route.useLoaderData();
  const confirm = useServerFn(confirmUnsubscribe);
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">(
    initial.ok && initial.alreadyUsed ? "done" : "idle",
  );

  const handle = async () => {
    setState("loading");
    try {
      const r = await confirm({ data: { token } });
      setState(r.ok ? "done" : "error");
    } catch {
      setState("error");
    }
  };

  if (!initial.ok) {
    return (
      <Shell>
        <h1 style={H1}>Link inválido</h1>
        <p style={P}>Este link de descadastro não foi encontrado ou expirou.</p>
      </Shell>
    );
  }

  if (state === "done") {
    return (
      <Shell>
        <h1 style={H1}>Pronto, você foi descadastrado</h1>
        <p style={P}>
          O email <b>{initial.masked}</b> não receberá mais nossas mensagens.
        </p>
        <p style={{ ...P, color: "#6b7280", fontSize: 13 }}>
          Pode levar alguns minutos para mensagens já enfileiradas pararem por completo.
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 style={H1}>Confirmar descadastro</h1>
      <p style={P}>
        Você quer parar de receber emails em <b>{initial.masked}</b>?
      </p>
      <button onClick={handle} disabled={state === "loading"} style={BTN}>
        {state === "loading" ? "Processando…" : "Sim, me descadastrar"}
      </button>
      {state === "error" && (
        <p style={{ ...P, color: "#b91c1c" }}>
          Algo deu errado. Tente recarregar a página.
        </p>
      )}
    </Shell>
  );
}

const SHELL: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
  background: "#f9fafb",
  fontFamily: "-apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
  color: "#111827",
};
const CARD: React.CSSProperties = {
  maxWidth: 440,
  width: "100%",
  background: "#ffffff",
  border: "1px solid #e5e7eb",
  borderRadius: 12,
  padding: 32,
  boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
};
const H1: React.CSSProperties = { fontSize: 20, fontWeight: 600, margin: "0 0 12px" };
const P: React.CSSProperties = { fontSize: 14, lineHeight: 1.6, margin: "0 0 16px" };
const BTN: React.CSSProperties = {
  background: "#111827",
  color: "#ffffff",
  border: "none",
  padding: "10px 16px",
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 500,
  cursor: "pointer",
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={SHELL}>
      <div style={CARD}>{children}</div>
    </div>
  );
}