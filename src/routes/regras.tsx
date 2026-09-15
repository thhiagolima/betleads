import { createFileRoute } from "@tanstack/react-router";
import {
  Zap,
  Crown,
  TrendingDown,
  Flame,
  Snowflake,
  Star,
  Sparkles,
  RotateCcw,
  Activity,
  Clock,
  Wallet,
  Target,
  LineChart,
  type LucideIcon,
} from "lucide-react";
import { PageHeader } from "@/components/ui-premium/page-header";
import { PriorityBadge, priorityBorder, type Priority } from "@/components/ui-premium/priority-badge";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/regras")({
  component: RegrasPage,
  head: () => ({
    meta: [
      { title: "Regras — BetLeads" },
      { name: "description", content: "Referência dos gatilhos inteligentes e suas regras." },
    ],
  }),
});

type Regra = { nome: string; significado: string; prioridade: Priority; icon: LucideIcon };

const REGRAS: Regra[] = [
  { nome: "Dinheiro parado", significado: "Saldo ≥ R$ 50 e sem jogar há 5+ dias", prioridade: "Crítico", icon: Wallet },
  { nome: "Recuperação VIP", significado: "VIP sem login há 7+ dias", prioridade: "Crítico", icon: Crown },
  { nome: "Frequência de queda", significado: "Frequência de login caiu 50%+", prioridade: "Alto", icon: TrendingDown },
  { nome: "Lead quente esfriando", significado: "Depositava 5+ dias seguidos e parou há 3–7 dias", prioridade: "Alto", icon: Snowflake },
  { nome: "Receita em queda", significado: "Depósitos caíram 50%+ vs período anterior, antes ≥ R$ 200", prioridade: "Alto", icon: LineChart },
  { nome: "VIP esfriando", significado: "VIP sem jogar há 2+ dias", prioridade: "Alto", icon: Star },
  { nome: "Quase VIP", significado: "Total depositado entre R$ 800 e R$ 999", prioridade: "Médio", icon: Sparkles },
  { nome: "Alto potencial", significado: "10+ logins, depósitos crescendo e login recente", prioridade: "Médio", icon: Target },
  { nome: "Reativação em curso", significado: "Voltou a depositar após 14+ dias parado", prioridade: "Médio", icon: RotateCcw },
  { nome: "Engajado sem converter", significado: "8+ logins em 30 dias e sem depósito há 14+ dias", prioridade: "Médio", icon: Activity },
  { nome: "Jogador em momento", significado: "5+ dias seguidos depositando e login nos últimos 2 dias", prioridade: "Baixo", icon: Flame },
  { nome: "Janela ideal de contato", significado: "Joga frequentemente em horário padrão", prioridade: "Baixo", icon: Clock },
];

function RegrasPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Regras"
        subtitle="Referência dos 12 gatilhos inteligentes que disparam fluxos automaticamente."
        icon={<Zap className="h-5 w-5 text-primary-foreground" />}
      />

      <div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
        {REGRAS.map((r) => {
          const Icon = r.icon;
          return (
            <div
              key={r.nome}
              className={cn(
                "card-premium rounded-xl p-5 border-l-4 transition-all",
                priorityBorder(r.prioridade),
              )}
            >
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Icon className="h-4 w-4" />
                  </div>
                  <h3 className="text-sm font-semibold tracking-tight truncate">{r.nome}</h3>
                </div>
                <PriorityBadge priority={r.prioridade} />
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed">{r.significado}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}