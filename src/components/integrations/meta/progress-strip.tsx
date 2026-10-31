import { Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowRight, CheckCircle2 } from "lucide-react";

import { Progress } from "@/components/ui/progress";
import type { ProgressStep } from "@/components/integrations/meta-connection-model";
import { cn } from "@/lib/utils";
import { firstReadFailedText, incrementalText } from "./meta-copy";

const STEPS: { step: ProgressStep; label: string }[] = [
  { step: "connect", label: "Conectar" },
  { step: "choose", label: "Escolher contas" },
  { step: "first_read", label: "Primeira leitura" },
  { step: "done", label: "Pronto" },
];

/**
 * Progresso real da conexão (MB3-04): cada passo corresponde a um estado dos dados,
 * não a um clique. "Primeira leitura" mostra o % do backfill; "Pronto" leva ao
 * Aquisição e LTV.
 */
export function ProgressStrip({
  step,
  percent,
  failedAccounts = 0,
  incremental = false,
}: {
  step: ProgressStep;
  percent: number | null;
  /** Contas que falharam no último backfill (parcial/falho): "Pronto" com aviso. */
  failedAccounts?: number;
  /** Backfill de contas novas depois da primeira leitura: nota no "Pronto". */
  incremental?: boolean;
}) {
  const current = STEPS.findIndex((item) => item.step === step);
  return (
    <ol aria-label="Progresso da conexão" className="grid gap-2 sm:grid-cols-4">
      {STEPS.map((item, index) => {
        const done = index < current || (step === "done" && item.step === "done");
        const active = index === current && step !== "done";
        return (
          <li
            key={item.step}
            aria-current={index === current ? "step" : undefined}
            className={cn(
              "flex min-w-0 flex-col gap-2 rounded-lg border border-border/60 px-3 py-2 text-sm",
              active && "border-primary/60 bg-primary/10",
              done && "border-success/30 bg-success/10",
              done &&
                item.step === "done" &&
                failedAccounts > 0 &&
                "border-warning/30 bg-warning/10",
            )}
          >
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-meta font-bold",
                  active && "bg-primary text-primary-foreground",
                  done && "bg-success/20 text-success",
                )}
              >
                {done ? <CheckCircle2 aria-hidden className="h-4 w-4" /> : index + 1}
              </span>
              <span
                className={cn("truncate font-medium", !active && !done && "text-muted-foreground")}
              >
                {item.label}
              </span>
              {item.step === "first_read" && active && percent !== null && (
                <span className="ml-auto text-meta font-semibold text-primary">{percent}%</span>
              )}
            </div>
            {item.step === "first_read" && active && percent !== null && (
              <Progress
                value={percent}
                aria-label="Importação dos últimos 90 dias"
                aria-valuenow={percent}
                className="h-1.5"
              />
            )}
            {item.step === "done" && step === "done" && failedAccounts > 0 && (
              <p className="flex items-start gap-1 text-meta font-medium text-warning">
                <AlertTriangle aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
                {firstReadFailedText(failedAccounts)}
              </p>
            )}
            {item.step === "done" && step === "done" && incremental && percent !== null && (
              <p className="text-meta text-muted-foreground">{incrementalText(percent)}</p>
            )}
            {item.step === "done" && step === "done" && (
              <Link
                to="/midia-ltv"
                className="inline-flex items-center gap-1 text-meta font-semibold text-primary hover:underline"
              >
                Ver Aquisição e LTV <ArrowRight aria-hidden className="h-3 w-3" />
              </Link>
            )}
          </li>
        );
      })}
    </ol>
  );
}
