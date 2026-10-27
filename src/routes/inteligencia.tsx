import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Sparkles, Send, Loader2, User, Brain } from "lucide-react";
import { AIResponse, type AIAnswer } from "@/components/ai-response";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { DemoDisabledTooltip } from "@/components/demo-disabled-tooltip";
import { useIsDemoTenant } from "@/hooks/use-is-demo-tenant";
import { DEMO_AI_UNAVAILABLE_TEXT } from "@/lib/demo-tenant";

export const Route = createFileRoute("/inteligencia")({
  component: IAPage,
});

// `question` is what the assistant receives (it recognises these exact phrasings);
// `label` is what the operator reads.
const suggestions = [
  { label: "Os 10 que mais depositam", question: "Top 10 depositantes" },
  { label: "Quem está há 7 dias sem jogar?", question: "Quem está 7 dias sem jogar?" },
  { label: "Quem está virando VIP?", question: "Quem está virando VIP?" },
  { label: "Cadastros com mais chance de depositar", question: "Leads quentes" },
  { label: "Cadastros parados", question: "Leads frios" },
  { label: "Jogadores de alto potencial", question: "Players de alto potencial" },
  { label: "Jogadores em risco de abandono", question: "Players em risco de abandono" },
  { label: "VIPs parados", question: "VIPs inativos" },
  { label: "Melhores jogadores", question: "Melhores players" },
  { label: "Quem cresceu esta semana?", question: "Quem cresceu essa semana?" },
  { label: "Quem se cadastrou e não depositou?", question: "Quem cadastrou e não depositou?" },
  { label: "Primeiros depósitos de hoje", question: "FTD hoje" },
  { label: "Cadastros desta semana", question: "Novos cadastros desta semana" },
];

type Msg = { role: "user"; content: string } | { role: "assistant"; content: string | AIAnswer };

function IAPage() {
  const isDemo = useIsDemoTenant();
  const [input, setInput] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [slow, setSlow] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const mutation = useMutation({
    mutationFn: async (question: string) => {
      // A função valida que o usuário é admin/gestor desta casa e só lê dados dela.
      // O client também manda X-Active-Tenant; o corpo deixa a casa explícita.
      const tenantId = window.localStorage.getItem("betleads:active-tenant");
      const { data, error } = await supabase.functions.invoke("ai-player-insights", {
        body: tenantId ? { question, tenant_id: tenantId } : { question },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return { ...data, question } as {
        answer: AIAnswer | string;
        ai_log_id?: string;
        question: string;
      };
    },
    onSuccess: (res) => {
      const content =
        typeof res.answer === "object"
          ? { ...res.answer, ai_log_id: res.ai_log_id ?? null, pergunta: res.question }
          : res.answer;
      setMsgs((m) => [...m, { role: "assistant", content }]);
    },
    onError: () =>
      setMsgs((m) => [
        ...m,
        {
          role: "assistant",
          content: "Não consegui consultar a IA agora. Tente novamente.",
        },
      ]),
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 999999, behavior: "smooth" });
  }, [msgs, mutation.isPending]);

  useEffect(() => {
    if (!mutation.isPending) {
      setSlow(false);
      return;
    }
    const t = setTimeout(() => setSlow(true), 15000);
    return () => clearTimeout(t);
  }, [mutation.isPending]);

  function send(text?: string, shown?: string) {
    const q = (text ?? input).trim();
    if (!q || mutation.isPending || isDemo) return;
    setMsgs((m) => [...m, { role: "user", content: shown ?? q }]);
    setInput("");
    mutation.mutate(q);
  }

  return (
    <Page>
      <PageHeader subtitle="Pergunte sobre os jogadores da casa. A resposta usa os dados de agora." />
      <div className="grid min-h-[480px] gap-4 lg:h-[calc(100dvh-240px)] lg:min-h-[560px] lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-h-[480px] flex-col overflow-hidden rounded-2xl border border-border bg-card/80">
          <div ref={scrollRef} className="flex-1 space-y-5 overflow-y-auto p-4 sm:p-6">
            {msgs.length === 0 && (
              <div className="h-full flex flex-col items-center justify-center text-center max-w-md mx-auto">
                <div className="mb-3 flex size-10 items-center justify-center rounded-xl bg-secondary text-muted-foreground">
                  <Brain className="size-5" aria-hidden="true" />
                </div>
                <h2 className="text-section">O que você quer saber?</h2>
                <p className="mt-2 text-body text-muted-foreground leading-relaxed">
                  {isDemo
                    ? DEMO_AI_UNAVAILABLE_TEXT
                    : "Escreva uma pergunta ou escolha uma sugestão. Ex.: quem depositou mais esta semana?"}
                </p>
              </div>
            )}
            {msgs.map((m, i) => (
              <div key={i} className={`flex gap-3 ${m.role === "user" ? "justify-end" : ""}`}>
                {m.role === "assistant" && (
                  <div
                    className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground"
                    aria-hidden="true"
                  >
                    <Sparkles className="size-4" />
                  </div>
                )}
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-3 text-body ${
                    m.role === "user"
                      ? "bg-primary/15 border border-primary/30 text-foreground"
                      : "bg-muted/40 border border-border/40"
                  }`}
                >
                  {m.role === "assistant" ? (
                    typeof m.content === "object" ? (
                      <AIResponse data={m.content} />
                    ) : (
                      <div className="prose prose-invert prose-sm max-w-none prose-headings:mb-2 prose-headings:mt-3 prose-p:my-1.5">
                        <ReactMarkdown>{m.content}</ReactMarkdown>
                      </div>
                    )
                  ) : (
                    (m.content as string)
                  )}
                </div>
                {m.role === "user" && (
                  <div
                    className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted"
                    aria-hidden="true"
                  >
                    <User className="size-4" />
                  </div>
                )}
              </div>
            ))}
            {mutation.isPending && (
              <div className="flex gap-3">
                <div
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground"
                  aria-hidden="true"
                >
                  <Sparkles className="size-4" />
                </div>
                <div className="rounded-2xl px-4 py-3 text-body bg-muted/40 border border-border/40 flex flex-col gap-1 text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Consultando os jogadores…
                  </div>
                  {slow && (
                    <p className="text-meta text-warning">
                      Esta consulta está demorando. Tente uma pergunta com período menor.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
          <div className="border-t border-border/60 bg-background/40 p-3">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
              className="flex gap-2 items-end"
            >
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={
                  isDemo ? DEMO_AI_UNAVAILABLE_TEXT : "Pergunte algo sobre os jogadores…"
                }
                rows={1}
                aria-label="Pergunta para o assistente"
                disabled={isDemo}
                className="bg-background/60 resize-none min-h-[44px] max-h-32"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <DemoDisabledTooltip active={isDemo} text={DEMO_AI_UNAVAILABLE_TEXT}>
                <Button
                  type="submit"
                  aria-label="Enviar pergunta"
                  disabled={isDemo || !input.trim() || mutation.isPending}
                  className="h-11 px-4"
                >
                  <Send className="h-4 w-4" aria-hidden="true" />
                </Button>
              </DemoDisabledTooltip>
            </form>
          </div>
        </div>

        <section
          aria-labelledby="ia-suggestions"
          className="order-first flex flex-col overflow-hidden rounded-2xl border border-border bg-card/80 lg:order-none"
        >
          <h2 id="ia-suggestions" className="border-b border-border/60 p-4 text-section">
            Sugestões
          </h2>
          {/* Phone: a row of chips that scrolls sideways; desktop: a list. */}
          <div className="flex flex-1 gap-1.5 overflow-x-auto p-3 lg:flex-col lg:overflow-y-auto lg:overflow-x-visible [scrollbar-width:none]">
            {suggestions.map((s) => (
              <button
                key={s.question}
                type="button"
                onClick={() => send(s.question, s.label)}
                disabled={isDemo || mutation.isPending}
                className="shrink-0 whitespace-nowrap rounded-lg border border-border/40 bg-background/40 px-3 py-2 text-left text-label transition-colors hover:border-primary/40 hover:bg-primary/5 disabled:opacity-50 lg:w-full lg:whitespace-normal"
              >
                {s.label}
              </button>
            ))}
          </div>
        </section>
      </div>
    </Page>
  );
}
