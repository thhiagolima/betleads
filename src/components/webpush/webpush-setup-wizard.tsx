// Web push (OneSignal) — Task 12: the house's activation assistant, now 2
// steps ("Instalação no site" → "Teste"). Houses usually open a single
// support ticket with their platform rather than sending file/script/player
// in separate round trips, so step 1 shows everything the ticket needs at
// once — a one-click "Copiar instruções para o suporte" (plain-text ticket,
// `buildSupportTicketText`) plus the same content visible in three blocks
// (Arquivo / Script / Jogador) — and a status row underneath with the two
// required checks (Arquivo, Script) plus the player identification status
// (informational only, not required to advance). The wizard opens on
// whichever step the house hasn't finished yet (`initialWizardStep`, from
// the app row's `worker_verified_at` / `script_seen_at` / `player_linked_at`
// / `test_sent_at`), and "Próxima etapa" on step 1 stays disabled until both
// worker_verified_at and script_seen_at are set. Pure step logic is exported
// and unit-tested directly (no DOM simulation — this repo has no
// @testing-library/react / jsdom, see domain-detail.test.tsx); the stateful
// container below only wires it up.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { BellOff, Check, Copy, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui-premium/empty-state";
import { cn } from "@/lib/utils";
import { tourAnchor } from "@/help/anchor";
import {
  listRecentWebpushSubscriptionsFn,
  sendWebpushTestFn,
  verifyWebpushWorkerFn,
} from "@/lib/webpush/webpush.functions";

export type WizardStepId = 1 | 2;

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
  1: "Instalação no site",
  2: "Teste",
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
  if (app.workerVerifiedAt && app.scriptSeenAt) return 2;
  return 1;
}

/** Whether "Próxima etapa" is enabled for the given step. Step 1 needs both
 * the worker file and the script confirmed (player identification is
 * informational only, not required); step 2 is the last step and never
 * advances on its own. */
export function canAdvanceStep(step: WizardStepId, app: AppProgress): boolean {
  if (step === 1) return Boolean(app.workerVerifiedAt) && Boolean(app.scriptSeenAt);
  return false;
}

/** One step forward, clamped — step 2 is the last. */
export function nextWizardStep(step: WizardStepId): WizardStepId {
  return Math.min(step + 1, 2) as WizardStepId;
}

/** The wizard is done once the house has proven the pipeline end to end
 * with a real test push (`sendWebpushTest` flips the app to `ativo`) — the
 * worker file and script confirmed, plus a test actually sent. Player
 * identification is informational and not required. */
export function isWizardComplete(app: AppProgress): boolean {
  return Boolean(app.workerVerifiedAt) && Boolean(app.scriptSeenAt) && Boolean(app.testSentAt);
}

/** Derives the CRM's own origin (for the worker file download link sent to
 * the house's support) from the loader snippet's `src` host — the snippet
 * already points at the CRM, not the house's site — falling back to the
 * caller-provided origin (`window.location.origin` in the browser) when the
 * snippet doesn't parse. */
export function buildDownloadUrl(loaderSnippet: string, fallbackOrigin: string): string {
  const match = loaderSnippet.match(/src="(https?:\/\/[^"]+)"/);
  let origin = fallbackOrigin;
  if (match) {
    try {
      origin = new URL(match[1]).origin;
    } catch {
      origin = fallbackOrigin;
    }
  }
  return `${origin}/api/public/push/worker.js`;
}

/** The exact plain-text pt-BR ticket message a house can paste into a
 * single support ticket with their platform (brief: "Ticket text
 * template"). Keep this template verbatim — it's what the house's support
 * actually reads. */
export function buildSupportTicketText(opts: {
  origin: string;
  workerUrl: string;
  downloadUrl: string;
  loaderSnippet: string;
  playerSnippet: string;
}): string {
  const { origin, workerUrl, downloadUrl, loaderSnippet, playerSnippet } = opts;
  return `Olá! Precisamos ativar as notificações (web push) no site ${origin}. São 2 passos obrigatórios e 1 opcional:

1) Arquivo do service worker
Baixe o arquivo em: ${downloadUrl}
Coloque-o, sem renomear nem editar, na pasta push/onesignal na raiz do site.
Ele deve abrir neste endereço (mostrando uma linha de texto): ${workerUrl}
O servidor precisa entregar o arquivo como JavaScript (Content-Type application/javascript).

2) Script
Cole este código no <head> de todas as páginas do site:
${loaderSnippet}

3) Jogador logado (opcional, recomendado)
Quando o jogador estiver logado, defina antes do script acima, com o mesmo ID de jogador enviado nos webhooks:
${playerSnippet}

Obrigado!`;
}

function StepIndicator({ step }: { step: WizardStepId }) {
  return (
    <nav aria-label="Etapas da ativação" className="flex flex-wrap items-center gap-2">
      {([1, 2] as WizardStepId[]).map((s) => (
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

export const CLIPBOARD_ERROR_MESSAGE =
  "Não foi possível copiar. Selecione o texto e copie manualmente.";

/** Copies to the clipboard and only reports success once the browser
 * confirms it — `navigator.clipboard.writeText` is async and can reject
 * (permission denied, insecure context) or be entirely absent (older
 * browsers, non-HTTPS), and this now backs the step's primary button
 * ("Copiar instruções para o suporte"), so a silent failure there would
 * tell the house's support contact instructions were sent when they
 * weren't. */
export function copyToClipboard(text: string, message: string) {
  if (!navigator.clipboard) {
    toast.error(CLIPBOARD_ERROR_MESSAGE);
    return;
  }
  navigator.clipboard.writeText(text).then(
    () => toast.success(message),
    () => toast.error(CLIPBOARD_ERROR_MESSAGE),
  );
}

// ============================================================================
// Etapa 1 — Instalação no site (arquivo + script + jogador + status)
// ============================================================================

/** How the house installs web push: `plataforma` = its backoffice platform
 * already ships the worker file and the loader, so the house only pastes its
 * token there; `manual` = the house (or its platform's support) uploads the
 * file and pastes the script by hand. Both end with the same file and script
 * on the site, so the status row and its checks are shared. */
export type InstallMode = "plataforma" | "manual";

export const INSTALL_MODE_LABELS: Record<InstallMode, string> = {
  plataforma: "Minha plataforma já tem integração com a Betleads",
  manual: "Vou instalar manualmente",
};

/** The house's platform already ships the worker file and the loader: the
 * house only pastes its token in the platform's backoffice. */
function PlatformInstallBlock({ origin, publicToken }: { origin: string; publicToken: string }) {
  return (
    <div
      className="space-y-3 rounded-lg border border-border/60 bg-background/30 p-3"
      {...tourAnchor("webhooks.webpush.bloco-token")}
    >
      <p className="text-sm text-muted-foreground">
        O arquivo e o script já vêm com a plataforma. No backoffice dela, ative o web push e cole o
        token abaixo.
      </p>
      <div className="space-y-1.5">
        <p className="text-label text-muted-foreground">Token da casa</p>
        <div className="flex gap-2">
          <Input value={publicToken} readOnly className="font-mono text-meta" />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!publicToken}
            onClick={() => copyToClipboard(publicToken, "Token copiado")}
          >
            <Copy className="h-3.5 w-3.5" /> Copiar
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Depois de salvar, abra <span className="font-mono text-foreground/85">{origin}</span> uma vez
        e confira o status abaixo.
      </p>
    </div>
  );
}

/** Manual install: one support ticket with the file, the script and the
 * player snippet, plus the same content in three blocks. */
function ManualInstallBlock({
  origin,
  workerUrl,
  downloadUrl,
  loaderSnippet,
  playerSnippet,
}: {
  origin: string;
  workerUrl: string;
  downloadUrl: string;
  loaderSnippet: string;
  playerSnippet: string;
}) {
  const ticketText = buildSupportTicketText({
    origin,
    workerUrl,
    downloadUrl,
    loaderSnippet,
    playerSnippet,
  });

  return (
    <>
      <p className="text-sm text-muted-foreground">
        Envie as instruções abaixo para o suporte da plataforma do site em um único chamado.
      </p>

      <Button
        type="button"
        onClick={() => copyToClipboard(ticketText, "Instruções copiadas")}
        {...tourAnchor("webhooks.webpush.copiar-instrucoes")}
      >
        <Copy className="h-3.5 w-3.5" /> Copiar instruções para o suporte
      </Button>

      <div className="space-y-3 rounded-lg border border-border/60 bg-background/30 p-3">
        <div className="space-y-2" {...tourAnchor("webhooks.webpush.bloco-arquivo")}>
          <p className="text-sm font-semibold">1. Arquivo</p>
          <Button type="button" variant="outline" asChild>
            <a href="/api/public/push/worker.js" download>
              Baixar OneSignalSDKWorker.js
            </a>
          </Button>
          <p className="text-sm text-muted-foreground">
            Coloque-o, sem renomear, na pasta{" "}
            <code className="font-mono text-foreground/85">push/onesignal</code> na raiz do site.
          </p>
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
        </div>

        <div className="space-y-2" {...tourAnchor("webhooks.webpush.bloco-script")}>
          <p className="text-sm font-semibold">2. Script</p>
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
        </div>

        <div className="space-y-2" {...tourAnchor("webhooks.webpush.bloco-jogador")}>
          <p className="text-sm font-semibold">3. Jogador logado (opcional)</p>
          <p className="text-sm text-muted-foreground">
            O mesmo ID enviado nos webhooks da casa. Defina-o antes do script acima, e só quando o
            jogador estiver logado.
          </p>
          <div className="flex gap-2">
            <Input value={playerSnippet} readOnly className="font-mono text-meta" />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => copyToClipboard(playerSnippet, "Script copiado")}
            >
              <Copy className="h-3.5 w-3.5" /> Copiar
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

export function InstallationStepView({
  origin,
  workerUrl,
  downloadUrl,
  publicToken,
  installMode,
  onInstallModeChange,
  loaderSnippet,
  playerSnippet,
  canAdvance,
  verifyingWorker,
  workerVerifyResult,
  onVerifyWorker,
  scriptSeen,
  checkingScript,
  onCheckScript,
  playerLinked,
  onNext,
}: {
  origin: string;
  workerUrl: string;
  downloadUrl: string;
  publicToken: string;
  installMode: InstallMode;
  onInstallModeChange: (mode: InstallMode) => void;
  loaderSnippet: string;
  playerSnippet: string;
  canAdvance: boolean;
  verifyingWorker: boolean;
  workerVerifyResult: WorkerCheckResult | null;
  onVerifyWorker: () => void;
  scriptSeen: boolean;
  checkingScript: boolean;
  onCheckScript: () => void;
  playerLinked: boolean;
  onNext: () => void;
}) {
  return (
    <div className="space-y-5">
      <div
        role="radiogroup"
        aria-label="Como instalar"
        className="flex flex-wrap gap-2"
        {...tourAnchor("webhooks.webpush.modo-instalacao")}
      >
        {(["plataforma", "manual"] as InstallMode[]).map((mode) => (
          <Button
            key={mode}
            type="button"
            role="radio"
            aria-checked={installMode === mode}
            variant={installMode === mode ? "default" : "outline"}
            size="sm"
            onClick={() => onInstallModeChange(mode)}
          >
            {INSTALL_MODE_LABELS[mode]}
          </Button>
        ))}
      </div>

      {installMode === "plataforma" ? (
        <PlatformInstallBlock origin={origin} publicToken={publicToken} />
      ) : (
        <ManualInstallBlock
          origin={origin}
          workerUrl={workerUrl}
          downloadUrl={downloadUrl}
          loaderSnippet={loaderSnippet}
          playerSnippet={playerSnippet}
        />
      )}

      <div
        className="grid gap-4 sm:grid-cols-3"
        {...tourAnchor("webhooks.webpush.status")}
      >
        <div className="space-y-1.5">
          <p className="text-label text-muted-foreground">Arquivo</p>
          <Button type="button" variant="outline" size="sm" disabled={verifyingWorker} onClick={onVerifyWorker}>
            {verifyingWorker ? "Verificando…" : "Verificar agora"}
          </Button>
          {workerVerifyResult && !workerVerifyResult.ok && (
            <p className="text-sm text-danger">{WORKER_VERIFY_MESSAGES[workerVerifyResult.reason]}</p>
          )}
          {workerVerifyResult?.ok && (
            <p className="flex items-center gap-1 text-sm text-success">
              <Check className="h-3.5 w-3.5" aria-hidden="true" /> Arquivo encontrado
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <p className="text-label text-muted-foreground">Script</p>
          {scriptSeen ? (
            <p className="flex items-center gap-1 text-sm text-success">
              <Check className="h-3.5 w-3.5" aria-hidden="true" /> Script detectado
            </p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">Aguardando o primeiro acesso ao site</p>
              <Button type="button" variant="outline" size="sm" disabled={checkingScript} onClick={onCheckScript}>
                {checkingScript ? "Verificando…" : "Verificar"}
              </Button>
            </>
          )}
        </div>

        <div className="space-y-1.5">
          <p className="text-label text-muted-foreground">Jogador logado</p>
          <p
            className={cn(
              "text-sm",
              playerLinked ? "flex items-center gap-1 text-success" : "text-muted-foreground",
            )}
          >
            {playerLinked && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
            {playerLinked ? "Jogador identificado" : "Ainda não identificado (opcional)"}
          </p>
        </div>
      </div>

      <div className="pt-2">
        <Button
          type="button"
          disabled={!canAdvance}
          onClick={onNext}
          {...tourAnchor("webhooks.webpush.proxima-etapa")}
        >
          Próxima etapa
        </Button>
      </div>
    </div>
  );
}

// ============================================================================
// Etapa 2 — Teste
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
    <div className="space-y-4" {...tourAnchor("webhooks.webpush.teste")}>
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
    <div className="space-y-4" {...tourAnchor("webhooks.webpush.concluido")}>
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
  publicToken,
  loaderSnippet,
  playerSnippet,
  onProgress,
  onCheckScript,
}: {
  app: WebpushWizardApp;
  publicToken: string;
  loaderSnippet: string;
  playerSnippet: string;
  /** Called after any server-side progress (verify success, a sent test
   * push) so the caller can refetch. `testSent: true` additionally tells
   * the caller a real test push just succeeded — the signal "Refazer
   * verificação" should stop hiding the completed summary for (see
   * `reduceRedoing` in webpush-integration-panel.tsx). */
  onProgress: (opts?: { testSent?: boolean }) => void;
  /** Refetches the integration query so a freshly-recorded `script_seen_at`
   * (set by the house's first page load after pasting the script) shows up
   * without a full page reload — the "Script" status row's "Verificar"
   * button. */
  onCheckScript: () => Promise<unknown>;
}) {
  const [step, setStep] = useState<WizardStepId>(() => initialWizardStep(app));
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [checkingScript, setCheckingScript] = useState(false);
  const [installMode, setInstallMode] = useState<InstallMode>("manual");

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
    enabled: step === 2,
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

  async function handleCheckScript() {
    setCheckingScript(true);
    try {
      await onCheckScript();
    } finally {
      setCheckingScript(false);
    }
  }

  const fallbackOrigin = typeof window !== "undefined" ? window.location.origin : "";
  const downloadUrl = buildDownloadUrl(loaderSnippet, fallbackOrigin);

  return (
    <div className="space-y-5">
      <StepIndicator step={step} />
      {step === 1 && (
        <InstallationStepView
          origin={app.origin}
          workerUrl={app.workerUrl}
          downloadUrl={downloadUrl}
          publicToken={publicToken}
          installMode={installMode}
          onInstallModeChange={setInstallMode}
          loaderSnippet={loaderSnippet}
          playerSnippet={playerSnippet}
          canAdvance={canAdvanceStep(1, app)}
          verifyingWorker={verify.isPending}
          workerVerifyResult={(verify.data as WorkerCheckResult | undefined) ?? null}
          onVerifyWorker={() => verify.mutate()}
          scriptSeen={Boolean(app.scriptSeenAt)}
          checkingScript={checkingScript}
          onCheckScript={handleCheckScript}
          playerLinked={Boolean(app.playerLinkedAt)}
          onNext={advance}
        />
      )}
      {step === 2 && (
        <TestStepView
          subscriptions={subscriptions.data ?? []}
          sendingId={sendingId}
          onSendTest={(subscriptionRowId) => sendTest.mutate(subscriptionRowId)}
        />
      )}
    </div>
  );
}
