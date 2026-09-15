import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Sparkles, Send, Loader2, User, Brain } from "lucide-react";
import { AIResponse, type AIAnswer } from "@/components/ai-response";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/inteligencia")({
  component: IAPage,
});

const suggestions = [
  "Top 10 depositantes",
  "Quem está 7 dias sem jogar?",
  "Quem está virando VIP?",
  "Leads quentes",
  "Leads frios",
  "Players de alto potencial",
  "Players em risco de abandono",
  "VIPs inativos",
  "Melhores players",
  "Quem cresceu essa semana?",
  "Quem cadastrou e não depositou?",
  "FTD hoje",
  "Novos cadastros desta semana",
];

type Msg =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | AIAnswer };

function IAPage() {
  const [input, setInput] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [slow, setSlow] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const mutation = useMutation({
    mutationFn: async (question: string) => {
      const { data, error } = await supabase.functions.invoke("ai-player-insights", {
        body: { question },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return { ...data, question } as { answer: AIAnswer | string; ai_log_id?: string; question: string };
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
    if (!mutation.isPending) { setSlow(false); return; }
    const t = setTimeout(() => setSlow(true), 15000);
    return () => clearTimeout(t);
  }, [mutation.isPending]);

  function send(text?: string) {
    const q = (text ?? input).trim();
    if (!q || mutation.isPending) return;
    setMsgs((m) => [...m, { role: "user", content: q }]);
    setInput("");
    mutation.mutate(q);
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_300px] lg:h-[calc(100dvh-180px)] min-h-[560px]">
      <div className="card-premium rounded-xl flex flex-col overflow-hidden">
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto p-6 space-y-5"
        >
          {msgs.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center text-center max-w-md mx-auto">
              <div className="h-16 w-16 rounded-2xl bg-gradient-to-br from-primary to-accent flex items-center justify-center glow-blue mb-4">
                <Brain className="h-7 w-7 text-primary-foreground" />
              </div>
              <h2 className="text-2xl font-semibold tracking-tight">
                Inteligência BETLEADS
              </h2>
              <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
                Pergunte qualquer coisa sobre seus players. A IA consulta o banco em tempo real e
                responde em português.
              </p>
              <p className="mt-4 text-[11px] uppercase tracking-[0.16em] text-muted-foreground/70">
                Use uma sugestão à direita para começar
              </p>
            </div>
          )}
          {msgs.map((m, i) => (
            <div
              key={i}
              className={`flex gap-3 ${m.role === "user" ? "justify-end" : ""}`}
            >
              {m.role === "assistant" && (
                <div className="h-8 w-8 shrink-0 rounded-lg bg-gradient-to-br from-primary to-accent flex items-center justify-center">
                  <Sparkles className="h-4 w-4 text-primary-foreground" />
                </div>
              )}
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm ${
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
                <div className="h-8 w-8 shrink-0 rounded-lg bg-muted flex items-center justify-center">
                  <User className="h-4 w-4" />
                </div>
              )}
            </div>
          ))}
          {mutation.isPending && (
            <div className="flex gap-3">
              <div className="h-8 w-8 shrink-0 rounded-lg bg-gradient-to-br from-primary to-accent flex items-center justify-center">
                <Sparkles className="h-4 w-4 text-primary-foreground" />
              </div>
              <div className="rounded-2xl px-4 py-3 text-sm bg-muted/40 border border-border/40 flex flex-col gap-1 text-muted-foreground">
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Analisando dados dos players...
                </div>
                {slow && (
                  <p className="text-xs text-amber-400/90">
                    Essa consulta está pesada. Tente filtrar por período ou limite menor.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
        <div className="border-t border-border/60 p-3 bg-background/40 backdrop-blur">
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
              placeholder="Pergunte algo sobre seus players..."
              rows={1}
              className="bg-background/60 resize-none min-h-[44px] max-h-32"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <Button
              type="submit"
              disabled={!input.trim() || mutation.isPending}
              className={cn(
                "h-11 px-4 bg-gradient-to-r from-primary to-accent text-primary-foreground glow-blue hover:opacity-90 transition-opacity",
              )}
            >
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </div>
      </div>

      <div className="card-premium rounded-xl overflow-hidden flex flex-col">
        <div className="p-4 border-b border-border/60 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Sugestões rápidas
          </p>
        </div>
        <div className="p-3 space-y-1.5 overflow-y-auto flex-1">
          {suggestions.map((s) => (
            <button
              key={s}
              onClick={() => send(s)}
              disabled={mutation.isPending}
              className="w-full text-left rounded-lg border border-border/40 bg-background/40 px-3 py-2 text-xs hover:border-primary/40 hover:bg-primary/5 hover:translate-x-0.5 transition-all duration-200 disabled:opacity-50 disabled:hover:translate-x-0"
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}