// Web push (OneSignal) — Task 12: the house's 4-step activation assistant
// (mockup A). Step order: Arquivo → Script → Jogador → Teste. The wizard
// opens on whichever step the house hasn't finished yet (`initialWizardStep`,
// from the app row's `worker_verified_at` / `script_seen_at` /
// `player_linked_at` / `test_sent_at`), and "Próxima etapa" stays disabled
// until that step's own milestone is reached — except step 3 ("Jogador"),
// which also offers "Pular por enquanto" since identifying players is
// optional. Pure step logic is exported and unit-tested directly (no DOM
// simulation — this repo has no @testing-library/react / jsdom, see
// domain-detail.test.tsx); the stateful container below only wires it up.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { BellOff, Check, Copy, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui-premium/empty-state";
import { cn } from "@/lib/utils";
import {
  listRecentWebpushSubscriptionsFn,
  sendWebpushTestFn,
  verifyWebpushWorkerFn,
} from "@/lib/webpush/webpush.functions";

export type WizardStepId = 1 | 2 | 3 | 4;

export type WorkerCheckFailureReason =
  | "nao_encontrado"
  | "html"
  | "tipo_errado"
  | "conteudo_errado"
  | "inacessivel";

export type WorkerCheckResult = { ok: true } | { ok: false; reason: WorkerCheckFailureReason };

export type AppProgress = {
  workerVerifiedAt: string | null;
  scriptSeenAt: string | null;
  playerLinkedAt: string | null;
  testSentAt: string | null;
};

export const WIZARD_STEP_LABELS: Record<WizardStepId, string> = {
  1: "Arquivo",
  2: "Script",
  3: "Jogador",
  4: "Teste",
};

export const WORKER_VERIFY_MESSAGES: Record<WorkerCheckFailureReason, string> = {
  nao_encontrado:
    "Não encontramos o arquivo nesse endereço. Confira se a pasta é push/onesignal e o nome do arquivo não mudou.",
  html: "O site devolveu uma página em vez do arquivo. Confira se o arquivo foi enviado para a pasta certa.",
  tipo_errado:
    "O arquivo está lá, mas o servidor não o entrega como JavaScript. Peça para servir .js como application/javascript.",
  conteudo_errado: "O arquivo foi alterado. Baixe de novo e envie sem editar.",
  inacessivel: "Não conseguimos acessar o site agora. Tente de novo em alguns minutos.",
};

/** Which step the assistant opens on, from the app's recorded progress. */
export function initialWizardStep(app: AppProgress): WizardStepId {
  if (!app.workerVerifiedAt) return 1;
  if (!app.scriptSeenAt) return 2;
  if (!app.playerLinkedAt) return 3;
  return 4;
}

/** Whether "Próxima etapa" is enabled for the given step. Step 3 can still
 * be bypassed by "Pular por enquanto" even when this is false; step 4 is
 * the last step and never advances on its own. */
export function canAdvanceStep(step: WizardStepId, app: AppProgress): boolean {
  if (step === 1) return Boolean(app.workerVerifiedAt);
  if (step === 2) return Boolean(app.scriptSeenAt);
  if (step === 3) return Boolean(app.playerLinkedAt);
  return false;
}

/** One step forward, clamped — step 4 is the last. */
export function nextWizardStep(step: WizardStepId): WizardStepId {
  return Math.min(step + 1, 4) as WizardStepId;
}

/** The wizard is done once the house has proven the pipeline end to end
 * with a real test push (`sendWebpushTest` flips the app to `ativo`). */
export function isWizardComplete(app: AppProgress): boolean {
  return Boolean(app.testSentAt);
}

function StepIndicator({ step }: { step: WizardStepId }) {
  return (
    <nav aria-label="Etapas da ativação" className="flex flex-wrap items-center gap-2">
      {([1, 2, 3, 4] as WizardStepId[]).map((s) => (
        <span
          key={s}
          className={cn(
            "rounded-full px-3 py-1 text-xs font-semibold",
            s === step ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
          )}
        >
          {s}. {WIZARD_STEP_LABELS[s]}
        </span>
      ))}
    </nav>
  );
}

function copyToClipboard(text: string, message: string) {
  navigator.clipboard.writeText(text);
  toast.success(message);
}

// ============================================================================
// Etapa 1 — Arquivo
// ============================================================================

export function WorkerFileStepView({
  workerUrl,
  canAdvance,
  verifying,
  verifyResult,
  onVerify,
  onNext,
}: {
  workerUrl: string;
  canAdvance: boolean;
  verifying: boolean;
  verifyResult: WorkerCheckResult | null;
  onVerify: () => void;
  onNext: () => void;
}) {
  return (
    <div className="space-y-4">
      <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
        <li>Baixe o arquivo sem renomear.</li>
        <li>
          Crie a pasta <code className="font-mono text-foreground/85">push/onesignal</code> na
          raiz do site.
        </li>
        <li>Coloque o arquivo dentro dela.</li>
        <li>Abra o endereço abaixo no navegador e veja uma linha de texto.</li>
      </ol>

      <Button type="button" variant="outline" asChild>
        <a href="/api/public/push/worker.js" download>
          Baixar OneSignalSDKWorker.js
        </a>
      </Button>

      <div className="space-y-1.5">
        <p className="text-label text-muted-foreground">Endereço completo</p>
        <div className="flex gap-2">
          <Input value={workerUrl} readOnly className="font-mono text-meta" />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => copyToClipboard(workerUrl, "Endereço copiado")}
          >
            <Copy className="h-3.5 w-3.5" /> Copiar
          </Button>
        </div>
      </div>

      <Button type="button" variant="outline" disabled={verifying} onClick={onVerify}>
        {verifying ? "Verificando…" : "Verificar agora"}
      </Button>

      {verifyResult && !verifyResult.ok && (
        <p className="text-sm text-danger">{WORKER_VERIFY_MESSAGES[verifyResult.reason]}</p>
      )}
      {verifyResult?.ok && (
        <p className="text-sm text-success">Arquivo encontrado, com o conteúdo certo.</p>
      )}

      <div className="pt-2">
        <Button type="button" disabled={!canAdvance} onClick={onNext}>
          Próxima etapa
        </Button>
      </div>
    </div>
  );
}

// ============================================================================
// Etapa 2 — Script
// ============================================================================

export function ScriptStepView({
  loaderSnippet,
  checking,
  canAdvance,
  onConfirmSeen,
  onNext,
}: {
  loaderSnippet: string;
  checking: boolean;
  canAdvance: boolean;
  onConfirmSeen: () => void;
  onNext: () => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Cole no <code className="font-mono text-foreground/85">&lt;head&gt;</code> de todas as
        páginas do site.
      </p>
      <div className="flex gap-2">
        <Input value={loaderSnippet} readOnly className="font-mono text-meta" />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => copyToClipboard(loaderSnippet, "Script copiado")}
        >
          <Copy className="h-3.5 w-3.5" /> Copiar
        </Button>
      </div>
      <Button type="button" variant="outline" disabled={checking} onClick={onConfirmSeen}>
        {checking ? "Verificando…" : "Já colei, verificar"}
      </Button>
      <div className="pt-2">
        <Button type="button" disabled={!canAdvance} onClick={onNext}>
          Próxima etapa
        </Button>
      </div>
    </div>
  );
}

// ============================================================================
// Etapa 3 — Jogador
// ============================================================================

export function PlayerStepView({
  playerSnippet,
  canAdvance,
  onCopy,
  onSkip,
  onNext,
}: {
  playerSnippet: string;
  canAdvance: boolean;
  onCopy: () => void;
  onSkip: () => void;
  onNext: () => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        O mesmo ID enviado nos webhooks da casa. Defina-o antes do script acima, e só quando o
        jogador estiver logado.
      </p>
      <Input value={playerSnippet} readOnly className="font-mono text-meta" />
      <Button type="button" variant="outline" size="sm" onClick={onCopy}>
        <Copy className="h-3.5 w-3.5" /> Copiar
      </Button>
      <div className="flex flex-wrap gap-2 pt-2">
        <Button type="button" variant="ghost" onClick={onSkip}>
          Pular por enquanto
        </Button>
        <Button type="button" disabled={!canAdvance} onClick={onNext}>
          Próxima etapa
        </Button>
      </div>
    </div>
  );
}

// ============================================================================
// Etapa 4 — Teste
// ============================================================================

type RecentSubscription = {
  id: string;
  createdAt: string | null;
  userAgent: string | null;
  playerLinked: boolean;
};

export function TestStepView({
  subscriptions,
  sendingId,
  onSendTest,
}: {
  subscriptions: RecentSubscription[];
  sendingId: string | null;
  onSendTest: (subscriptionRowId: string) => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Abra o site da casa neste navegador e aceite as notificações.
      </p>
      {subscriptions.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhuma inscrição ainda.</p>
      ) : (
        <div className="space-y-2">
          {subscriptions.map((sub) => (
            <div
              key={sub.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/30 p-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm">{sub.userAgent ?? "Navegador desconhecido"}</p>
                <p className="text-meta text-muted-foreground">
                  {sub.playerLinked ? "identificado" : "anônimo"}
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={sendingId === sub.id}
                onClick={() => onSendTest(sub.id)}
              >
                {sendingId === sub.id ? "Enviando…" : "Enviar teste"}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Resumo: tudo concluído
// ============================================================================

export type CompletedAppSummary = {
  id: string;
  origin: string;
  status: string;
  activeSubscriptions: number;
  identifiedSubscriptions: number;
};

export function CompletedSummaryView({
  apps,
  onRedo,
}: {
  apps: CompletedAppSummary[];
  onRedo: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {apps.map((app) => (
          <div
            key={app.id}
            className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/30 p-3"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{app.origin}</p>
              <p className="text-meta text-muted-foreground">
                {app.activeSubscriptions} inscritos ativos · {app.identifiedSubscriptions}{" "}
                identificados · {app.status}
              </p>
            </div>
            <Check className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
          </div>
        ))}
      </div>
      <Button type="button" variant="outline" onClick={onRedo}>
        <RotateCcw className="h-3.5 w-3.5" /> Refazer verificação
      </Button>
    </div>
  );
}

// ============================================================================
// Casa sem app ativado (e sem acesso de super admin)
// ============================================================================

export function WebpushNotActivatedView() {
  return (
    <EmptyState
      icon={<BellOff className="h-5 w-5" />}
      title="Web Push ainda não ativado"
      description="O Web Push ainda não foi ativado para esta casa. Fale com a Betleads."
    />
  );
}

// ============================================================================
// O assistente, de ponta a ponta
// ============================================================================

export type WebpushWizardApp = AppProgress & {
  id: string;
  origin: string;
  workerUrl: string;
};

export function WebpushSetupWizard({
  app,
  loaderSnippet,
  playerSnippet,
  onProgress,
}: {
  app: WebpushWizardApp;
  loaderSnippet: string;
  playerSnippet: string;
  /** Called after any server-side progress (verify success, "Já colei,
   * verificar", a sent test push) so the caller can refetch. `testSent:
   * true` additionally tells the caller a real test push just succeeded —
   * the signal "Refazer verificação" should stop hiding the completed
   * summary for (see `reduceRedoing` in webpush-integration-panel.tsx). */
  onProgress: (opts?: { testSent?: boolean }) => void;
}) {
  const [step, setStep] = useState<WizardStepId>(() => initialWizardStep(app));
  const [sendingId, setSendingId] = useState<string | null>(null);

  const verifyWorkerFn = useServerFn(verifyWebpushWorkerFn);
  const listSubsFn = useServerFn(listRecentWebpushSubscriptionsFn);
  const sendTestFn = useServerFn(sendWebpushTestFn);

  const verify = useMutation({
    mutationFn: () => verifyWorkerFn({ data: { appRowId: app.id } }),
    onSuccess: (result: WorkerCheckResult) => {
      if (result.ok) onProgress();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const subscriptions = useQuery({
    queryKey: ["webpush-recent-subscriptions", app.id],
    queryFn: () => listSubsFn({ data: { appRowId: app.id } }),
    enabled: step === 4,
  });

  const sendTest = useMutation({
    mutationFn: (subscriptionRowId: string) => {
      setSendingId(subscriptionRowId);
      return sendTestFn({ data: { subscriptionRowId } });
    },
    onSuccess: () => {
      toast.success("Teste enviado");
      onProgress({ testSent: true });
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => setSendingId(null),
  });

  const advance = () => setStep((s) => nextWizardStep(s));

  return (
    <div className="space-y-5">
      <StepIndicator step={step} />
      {step === 1 && (
        <WorkerFileStepView
          workerUrl={app.workerUrl}
          canAdvance={canAdvanceStep(1, app)}
          verifying={verify.isPending}
          verifyResult={(verify.data as WorkerCheckResult | undefined) ?? null}
          onVerify={() => verify.mutate()}
          onNext={advance}
        />
      )}
      {step === 2 && (
        <ScriptStepView
          loaderSnippet={loaderSnippet}
          checking={false}
          canAdvance={canAdvanceStep(2, app)}
          onConfirmSeen={onProgress}
          onNext={advance}
        />
      )}
      {step === 3 && (
        <PlayerStepView
          playerSnippet={playerSnippet}
          canAdvance={canAdvanceStep(3, app)}
          onCopy={() => copyToClipboard(playerSnippet, "Script copiado")}
          onSkip={advance}
          onNext={advance}
        />
      )}
      {step === 4 && (
        <TestStepView
          subscriptions={subscriptions.data ?? []}
          sendingId={sendingId}
          onSendTest={(subscriptionRowId) => sendTest.mutate(subscriptionRowId)}
        />
      )}
    </div>
  );
}
