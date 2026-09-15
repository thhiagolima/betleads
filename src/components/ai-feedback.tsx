import { useState } from "react";
import { ThumbsUp, ThumbsDown, Check, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

type Props = {
  aiLogId?: string | null;
  pergunta: string;
  respostaSummary?: string;
};

export function AIFeedback({ aiLogId, pergunta, respostaSummary }: Props) {
  const [sent, setSent] = useState<"good" | "bad" | null>(null);
  const [showBad, setShowBad] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [respostaIdeal, setRespostaIdeal] = useState("");
  const [saving, setSaving] = useState(false);

  async function sendGood() {
    if (sent || !aiLogId) {
      if (!aiLogId) toast.error("Resposta sem id (recarregue a página).");
      return;
    }
    await supabase.from("ai_feedback").insert({ ai_log_id: aiLogId, rating: "good" });
    setSent("good");
    toast.success("Obrigado pelo feedback!");
  }

  async function saveBad() {
    if (!aiLogId) return;
    setSaving(true);
    try {
      await supabase.from("ai_feedback").insert({
        ai_log_id: aiLogId, rating: "bad", motivo: motivo || null,
      });
      if (respostaIdeal.trim()) {
        await supabase.from("ai_training_examples").insert({
          pergunta, resposta_ideal: respostaIdeal.trim(),
          fonte: "feedback", ai_log_id: aiLogId, ativo: false,
        });
      }
      setSent("bad");
      setShowBad(false);
      toast.success(respostaIdeal ? "Exemplo salvo como rascunho em Treino IA" : "Feedback enviado");
    } finally {
      setSaving(false);
    }
  }

  if (sent) {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-emerald-400 mt-1">
        <Check className="h-3 w-3" /> feedback registrado
      </div>
    );
  }

  return (
    <div className="mt-2 border-t border-border/30 pt-2">
      {!showBad ? (
        <div className="flex items-center justify-end gap-1 text-muted-foreground">
          <span className="text-[11px] mr-1">Essa resposta ajudou?</span>
          <button
            onClick={sendGood}
            className="p-1.5 rounded-md hover:bg-emerald-500/10 hover:text-emerald-400 transition-colors"
            title="Boa resposta"
          >
            <ThumbsUp className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setShowBad(true)}
            className="p-1.5 rounded-md hover:bg-rose-500/10 hover:text-rose-400 transition-colors"
            title="Resposta ruim"
          >
            <ThumbsDown className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <div className="space-y-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-3">
          <p className="text-xs font-medium">O que estava errado?</p>
          <Textarea
            value={motivo} onChange={(e) => setMotivo(e.target.value)}
            placeholder="Ex: trouxe todos em vez de filtrar pelo expert..."
            rows={2} className="text-xs"
          />
          <p className="text-xs font-medium pt-1">Como deveria ter respondido? (vai virar exemplo de treino)</p>
          <Textarea
            value={respostaIdeal} onChange={(e) => setRespostaIdeal(e.target.value)}
            placeholder="Resposta ideal em texto livre..."
            rows={3} className="text-xs"
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setShowBad(false)} disabled={saving}>
              Cancelar
            </Button>
            <Button size="sm" onClick={saveBad} disabled={saving}>
              {saving && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
              Enviar
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}