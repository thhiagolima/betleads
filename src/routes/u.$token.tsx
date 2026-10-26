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
      .select("email, used_at, tenant_id")
      .eq("token", data.token)
      .maybeSingle();
    if (!row) return { ok: false as const, reason: "not_found" as const };
    // The player must know which house they are leaving (F-30).
    let house: string | null = null;
    if (row.tenant_id) {
      const { data: tenant } = await supabaseAdmin
        .from("tenants")
        .select("nome")
        .eq("id", row.tenant_id)
        .maybeSingle();
      house = tenant?.nome?.trim() || null;
    }
    // mascarando o email no retorno (j***@dominio.com)
    const email = row.email as string;
    const [u, dom] = email.split("@");
    const masked = u
      ? `${u[0]}${"*".repeat(Math.max(1, u.length - 2))}${u.slice(-1)}@${dom}`
      : email;
    return {
      ok: true as const,
      masked,
      alreadyUsed: !!row.used_at,
      house,
    };
  });

export const confirmUnsubscribe = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => TokenInput.parse(d))
  .handler(async ({ data }) => {
    // Server-only logic lives in unsubscribe.server.ts, imported only here so
    // client.server and friends never reach the client bundle.
    const { confirmUnsubscribeFor } = await import("@/lib/unsubscribe.server");
    return confirmUnsubscribeFor(data);
  });

// ---- rota ----

export const Route = createFileRoute("/u/$token")({
  head: () => ({
    meta: [{ title: "Descadastrar e-mail" }, { name: "robots", content: "noindex,nofollow" }],
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
        <h1 className={H1}>Link inválido</h1>
        <p className={P}>Este link de descadastro não foi encontrado ou expirou.</p>
      </Shell>
    );
  }

  const from = initial.house ? `de ${initial.house}` : "desta casa";

  if (state === "done") {
    return (
      <Shell>
        <h1 className={H1}>Pronto, você foi descadastrado</h1>
        <p className={P}>
          O e-mail <b>{initial.masked}</b> não receberá mais e-mails {from}.
        </p>
        <p className="text-[13px] leading-relaxed text-zinc-500">
          Pode levar alguns minutos para mensagens já enfileiradas pararem por completo.
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className={H1}>Confirmar descadastro</h1>
      <p className={P}>
        Você quer parar de receber e-mails {from} em <b>{initial.masked}</b>?
      </p>
      <button
        type="button"
        onClick={handle}
        disabled={state === "loading"}
        className="h-10 rounded-lg bg-zinc-900 px-4 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {state === "loading" ? "Processando…" : "Sim, me descadastrar"}
      </button>
      {state === "error" && (
        <p role="alert" className="mt-4 text-sm text-red-700">
          Algo deu errado. Tente recarregar a página.
        </p>
      )}
    </Shell>
  );
}

// Public page opened from an e-mail: light and neutral, outside the CRM theme.
const H1 = "mb-3 text-xl font-semibold";
const P = "mb-4 text-sm leading-relaxed";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 p-6 font-sans text-zinc-900">
      <div className="w-full max-w-[440px] rounded-xl border border-zinc-200 bg-white p-8 shadow-sm">
        {children}
      </div>
    </div>
  );
}
