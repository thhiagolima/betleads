import { useBlocker } from "@tanstack/react-router";
import { AlertTriangle, Loader2, Lock, Plus, RefreshCw } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { DemoDisabledTooltip } from "@/components/demo-disabled-tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DataCard } from "@/components/ui-premium/data-card";
import {
  META_TEXTS,
  buildAccountRows,
  buildConnectionCards,
  connectionProgress,
  disconnectImpact,
  headerStatus,
  type AccountFilter,
} from "@/components/integrations/meta-connection-model";
import type { MetaSummary } from "@/components/integrations/meta-summary";
import { AccountSelection } from "./account-selection";
import { ConnectKeyForm, ConnectKeySheet } from "./connect-key-sheet";
import { summaryError, unsavedLeaveConfirm, type ConnectKeyMode } from "./meta-copy";
import { ConnectionCard } from "./connection-card";
import { DisconnectDialog } from "./disconnect-dialog";
import { ToneBadge } from "./meta-badges";
import { ProgressStrip } from "./progress-strip";
import { SyncHistory } from "./sync-history";
import { isStaleSelectionError } from "./use-meta-actions";
import { useSelectionDraft } from "./use-selection-draft";

/** O que a tela pede ao servidor; o painel liga isto às mutações. */
export type MetaViewActions = {
  connect: (token: string) => Promise<unknown>;
  connectPending: boolean;
  saveSelection: (accountIds: string[]) => Promise<unknown>;
  savePending: boolean;
  validate: (connectionId: string) => void;
  validatingConnectionId: string | null;
  rename: (connectionId: string, label: string) => Promise<unknown>;
  renamePending: boolean;
  disconnect: (connectionId: string) => Promise<unknown>;
  disconnectPending: boolean;
  sync: () => void;
  syncPending: boolean;
};

const EMPTY_SUMMARY: MetaSummary = { accounts: [], connections: [], latestBackfill: null };

/** Aba Meta Ads de Integrações (MB3): chaves, progresso e contas por BM. */
export function MetaConnectionView({
  summary,
  readOnly,
  isDemo,
  actions,
  now: nowProp,
  initialFilter,
  loadError,
}: {
  summary: MetaSummary | undefined;
  readOnly: boolean;
  isDemo: boolean;
  actions: MetaViewActions;
  now?: Date;
  initialFilter?: AccountFilter;
  /** O resumo não carregou (e não há dado anterior): erro com "Tentar novamente". */
  loadError?: { retry: () => void; retrying: boolean } | null;
}) {
  const data = summary ?? EMPTY_SUMMARY;
  // O relógio anda a cada leitura do resumo (o polling de 30 s), não a cada render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => nowProp ?? new Date(), [nowProp, summary]);
  const locked = readOnly || isDemo;
  const cards = useMemo(() => buildConnectionCards(data, now), [data, now]);
  const rows = useMemo(() => buildAccountRows(data, now), [data, now]);
  const progress = connectionProgress(summary);
  const status = headerStatus(summary, now);
  const persistedIds = useMemo(
    () => data.accounts.filter((account) => account.selected).map((account) => account.id),
    [data.accounts],
  );
  // Com as linhas da tela, a marcação não salva de uma conta que sumiu sai do rascunho.
  const visibleIds = useMemo(() => rows.map((row) => row.account.id), [rows]);
  const selection = useSelectionDraft(persistedIds, visibleIds);
  const dirty = selection.diff.dirty && !readOnly;
  // Navegação dentro do app (outra página, outra aba de Integrações pelo hash, voltar)
  // com alterações não salvas: pergunta no diálogo da tela. O fechar/recarregar
  // fica com o `beforeunload` do rascunho.
  const shouldBlock = useCallback(() => true, []);
  const blocker = useBlocker({
    shouldBlockFn: shouldBlock,
    disabled: !dirty,
    enableBeforeUnload: false,
    withResolver: true,
  });
  const [sheetMode, setSheetMode] = useState<ConnectKeyMode | null>(null);
  const [disconnectId, setDisconnectId] = useState<string | null>(null);
  const [staleNotice, setStaleNotice] = useState(false);

  const hasConnections = cards.length > 0;
  const legacy = data.connections.some((connection) => connection.auth_type === "legacy_oauth");
  const disconnectCard = cards.find((card) => card.connection.id === disconnectId) ?? null;
  const disconnectTarget = disconnectCard
    ? {
        connectionId: disconnectCard.connection.id,
        title: disconnectCard.title,
        impact: disconnectImpact(data, disconnectCard.connection.id),
      }
    : null;

  async function saveSelection(accountIds: string[]) {
    try {
      await actions.saveSelection(accountIds);
      setStaleNotice(false);
    } catch (error) {
      // A mutation já mostrou o toast e releu o resumo; o aviso fica na tela.
      if (isStaleSelectionError(error)) setStaleNotice(true);
    }
  }

  if (loadError && !summary) {
    return (
      <DataCard
        title="Meta Ads"
        description="Conecte as chaves das suas BMs e escolha as contas que entram nos relatórios."
        className="min-w-0"
      >
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm"
        >
          <p className="flex items-start gap-2 font-medium text-danger">
            <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            {summaryError}
          </p>
          <Button
            size="sm"
            variant="outline"
            className="gap-2"
            disabled={loadError.retrying}
            onClick={() => loadError.retry()}
          >
            {loadError.retrying ? (
              <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw aria-hidden className="h-4 w-4" />
            )}
            Tentar novamente
          </Button>
        </div>
      </DataCard>
    );
  }

  const statusBadge = (className: string) => (
    // Texto longo ("3 BMs · 12 contas · atualizado há 8 min"): quebra em vez de
    // empurrar a tela em 375 px.
    <ToneBadge tone={status.tone} className={`max-w-full whitespace-normal ${className}`}>
      {status.text}
    </ToneBadge>
  );

  return (
    <DataCard
      title="Meta Ads"
      description="Conecte as chaves das suas BMs e escolha as contas que entram nos relatórios."
      // No celular o status vai para baixo do título (no corpo); do sm para cima, à direita.
      actions={statusBadge("hidden sm:inline-flex")}
      className="min-w-0"
    >
      <div className="space-y-5">
        <div className="sm:hidden">{statusBadge("")}</div>
        {readOnly && (
          <p className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-meta text-muted-foreground">
            <Lock aria-hidden className="h-3.5 w-3.5 shrink-0" />
            {META_TEXTS.readOnly}
          </p>
        )}

        {!readOnly && hasConnections && (
          <div className="flex flex-wrap gap-2">
            <DemoDisabledTooltip active={isDemo}>
              <Button
                size="sm"
                className="gap-2"
                disabled={locked}
                onClick={() => setSheetMode({ kind: "add" })}
              >
                <Plus aria-hidden className="h-4 w-4" />
                Adicionar Usuário do Sistema
              </Button>
            </DemoDisabledTooltip>
            <DemoDisabledTooltip active={isDemo}>
              <Button
                size="sm"
                variant="outline"
                className="gap-2"
                disabled={locked || persistedIds.length === 0 || actions.syncPending}
                onClick={() => actions.sync()}
              >
                {actions.syncPending ? (
                  <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw aria-hidden className="h-4 w-4" />
                )}
                Sincronizar agora
              </Button>
            </DemoDisabledTooltip>
          </div>
        )}

        <ProgressStrip
          step={progress.step}
          percent={progress.percent}
          failedAccounts={progress.failedAccounts}
          incremental={progress.incremental}
        />

        {legacy && (
          <div className="rounded-xl border border-warning/30 bg-warning/10 p-4 text-sm">
            <p className="font-semibold text-warning">Conexão antiga precisa ser substituída</p>
            <p className="mt-1 text-muted-foreground">
              A integração anterior usava o app compartilhado da plataforma. Gere uma chave no app
              da sua operação e conecte; os dados já importados ficam.
            </p>
          </div>
        )}

        {!hasConnections &&
          (readOnly ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              A Meta ainda não está conectada nesta casa.
            </p>
          ) : (
            <div className="rounded-xl border border-border/60 bg-background/40 p-4">
              <p className="font-semibold">Conectar a primeira chave</p>
              <p className="mb-4 text-meta text-muted-foreground">
                Prepare um Usuário do Sistema no Business Manager e cole a chave dele aqui.
              </p>
              <ConnectKeyForm
                locked={locked}
                isDemo={isDemo}
                pending={actions.connectPending}
                onConnect={actions.connect}
              />
            </div>
          ))}

        {hasConnections && (
          <>
            <section aria-label="Chaves conectadas" className="grid gap-3 lg:grid-cols-2">
              {cards.map((card) => (
                <ConnectionCard
                  key={card.connection.id}
                  card={card}
                  readOnly={readOnly}
                  isDemo={isDemo}
                  actions={{
                    onValidate: actions.validate,
                    validatingConnectionId: actions.validatingConnectionId,
                    onRename: actions.rename,
                    renamePending: actions.renamePending,
                    onReplaceKey: (target) =>
                      setSheetMode({ kind: "replace", connectionTitle: target.title }),
                    onDisconnect: setDisconnectId,
                  }}
                />
              ))}
            </section>

            <AccountSelection
              rows={rows}
              selection={selection}
              readOnly={readOnly}
              isDemo={isDemo}
              savePending={actions.savePending}
              onSave={saveSelection}
              onDiscard={() => setStaleNotice(false)}
              staleNotice={staleNotice}
              initialFilter={initialFilter}
            />

            <SyncHistory />
          </>
        )}
      </div>

      <ConnectKeySheet
        mode={sheetMode}
        onOpenChange={(open) => !open && setSheetMode(null)}
        locked={locked}
        isDemo={isDemo}
        pending={actions.connectPending}
        onConnect={actions.connect}
      />
      <AlertDialog
        open={blocker.status === "blocked"}
        onOpenChange={(open) => {
          if (!open) blocker.reset?.();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sair sem salvar?</AlertDialogTitle>
            <AlertDialogDescription>{unsavedLeaveConfirm}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => blocker.reset?.()}>
              Continuar editando
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => blocker.proceed?.()}>
              Sair sem salvar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <DisconnectDialog
        target={disconnectTarget}
        pending={actions.disconnectPending}
        onClose={() => setDisconnectId(null)}
        onConfirm={actions.disconnect}
      />
    </DataCard>
  );
}
