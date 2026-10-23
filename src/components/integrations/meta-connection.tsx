import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  CheckCircle2,
  Clipboard,
  Link2,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Target,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
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
import { DataCard } from "@/components/ui-premium/data-card";
import { DemoDisabledTooltip } from "@/components/demo-disabled-tooltip";
import { useIsDemoTenant } from "@/hooks/use-is-demo-tenant";
import {
  connectMetaSystemUserToken,
  disconnectMetaConnection,
  updateMetaAccountSelection,
  validateMetaConnection,
} from "@/lib/meta.functions";
import { cn } from "@/lib/utils";
import {
  useMetaConnectionSummary,
  type MarketingIntegration,
  type MetaSummary,
} from "./meta-summary";

// Conexão com a Meta (token do Usuário do Sistema) e montador de UTM. Saiu da
// "Configuração" de Aquisição e LTV (/midia-ltv) para Integrações (/webhooks#meta);
// a lógica e as server functions são as mesmas.

// Só a Meta tem gasto sincronizado. Google, TikTok e Kwai voltam quando houver
// integração (AL5-04); antes disso o gerador prometeria uma medição que não existe.
const META_UTM_PARAMS =
  "utm_source={{site_source_name}}&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&utm_term={{adset.name}}&utm_id={{ad.id}}";

function appendParams(url: string, params: string) {
  const clean = url.trim();
  if (!clean) return params;
  return `${clean}${clean.includes("?") ? "&" : "?"}${params}`;
}

function statusLabel(status?: string) {
  // No connection row at all (Integrações does not load the marketing overview).
  if (!status) return "não conectada";
  if (status === "connected") return "conectada";
  if (status === "configured") return "preparada";
  if (status === "error") return "erro";
  if (status === "disabled") return "pausada";
  return "planejada";
}

/** Aba "Meta Ads" de Integrações: assistente de conexão + montador de UTM. */
export function MetaConnectionPanel({ meta }: { meta?: MarketingIntegration }) {
  const qc = useQueryClient();
  const connectMetaToken = useServerFn(connectMetaSystemUserToken);
  const saveMetaSelection = useServerFn(updateMetaAccountSelection);
  const testMetaConnection = useServerFn(validateMetaConnection);
  const removeMetaConnection = useServerFn(disconnectMetaConnection);
  const [houseUrl, setHouseUrl] = useState("");
  const { data: metaSummary, isLoading: summaryLoading } = useMetaConnectionSummary();

  const connectMetaTokenMutation = useMutation({
    mutationFn: (accessToken: string) => connectMetaToken({ data: { accessToken } }),
    onSuccess: (result) => {
      toast.success(
        `${result.accounts.length} conta(s) encontrada(s). Escolha quais acompanhar e salve.`,
      );
      qc.invalidateQueries({ queryKey: ["meta-connection-summary"] });
      qc.invalidateQueries({ queryKey: ["marketing-overview"] });
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Não foi possível validar o token Meta"),
  });

  const metaSelectionMutation = useMutation({
    mutationFn: (accountIds: string[]) => saveMetaSelection({ data: { accountIds } }),
    onSuccess: (result) => {
      toast.success(`${result.selected} conta(s) selecionada(s)`);
      qc.invalidateQueries({ queryKey: ["meta-connection-summary"] });
      qc.invalidateQueries({ queryKey: ["marketing-overview"] });
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Não foi possível salvar as contas"),
  });

  const validateMetaMutation = useMutation({
    mutationFn: (connectionId: string) => testMetaConnection({ data: { connectionId } }),
    onSuccess: (result) => {
      toast.success(`Conexão validada · ${result.accounts} conta(s) acessíveis`);
      qc.invalidateQueries({ queryKey: ["meta-connection-summary"] });
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Não foi possível validar a conexão");
      qc.invalidateQueries({ queryKey: ["meta-connection-summary"] });
    },
  });

  const disconnectMetaMutation = useMutation({
    mutationFn: (connectionId: string) => removeMetaConnection({ data: { connectionId } }),
    onSuccess: () => {
      toast.success("Conexão Meta removida");
      qc.invalidateQueries({ queryKey: ["meta-connection-summary"] });
      qc.invalidateQueries({ queryKey: ["marketing-overview"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Não foi possível desconectar"),
  });

  const utmParams = META_UTM_PARAMS;
  const fullUrl = useMemo(() => appendParams(houseUrl, utmParams), [houseUrl, utmParams]);

  async function copy(text: string, label = "Copiado") {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(label);
    } catch {
      toast.error("Não foi possível copiar. Selecione o texto e copie manualmente.");
    }
  }

  return (
    <div className="space-y-5">
      {summaryLoading ? (
        // The wizard decides on mount whether to open the token form; wait for the summary.
        <Skeleton className="h-64 rounded-xl" />
      ) : (
        <MetaConnectionWizard
          meta={meta}
          summary={metaSummary}
          onConnect={(token) => connectMetaTokenMutation.mutateAsync(token)}
          connectPending={connectMetaTokenMutation.isPending}
          onSaveSelection={(accountIds) => metaSelectionMutation.mutateAsync(accountIds)}
          selectionPending={metaSelectionMutation.isPending}
          onValidate={(connectionId) => validateMetaMutation.mutateAsync(connectionId)}
          validatingConnectionId={validateMetaMutation.variables ?? null}
          onDisconnect={(connectionId) => disconnectMetaMutation.mutateAsync(connectionId)}
          disconnectPending={disconnectMetaMutation.isPending}
        />
      )}

      <DataCard
        title="Montar marcação"
        description="Copie os parâmetros para os anúncios do Facebook e Instagram."
        icon={<Link2 className="h-4 w-4" />}
      >
        <div className="space-y-2">
          <Label htmlFor="house-url">Link da casa</Label>
          <Input
            id="house-url"
            type="url"
            placeholder="https://sua-casa.com/cadastro"
            value={houseUrl}
            onChange={(e) => setHouseUrl(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            O <code>utm_id</code> leva o ID do anúncio. É ele que liga cada cadastro ao anúncio
            certo, mesmo quando dois anúncios têm o mesmo nome.
          </p>
        </div>
        <div className="mt-5 space-y-4">
          <CopyBlock title="Parâmetros de URL" value={utmParams} onCopy={() => copy(utmParams)} />
          <CopyBlock title="Link completo" value={fullUrl} onCopy={() => copy(fullUrl)} />
        </div>
      </DataCard>
    </div>
  );
}

function StatusBadge({ status }: { status?: string }) {
  const connected = status === "connected";
  const configured = status === "configured" || status === "planned";
  return (
    <Badge
      variant="outline"
      className={cn(
        "border-border/60 text-meta",
        connected && "border-success/30 bg-success/10 text-success",
        configured && "border-info/30 bg-info/10 text-info",
        status === "error" && "border-danger/30 bg-danger/10 text-danger",
      )}
    >
      {statusLabel(status)}
    </Badge>
  );
}

function CopyBlock({ title, value, onCopy }: { title: string; value: string; onCopy: () => void }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/40 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-sm font-semibold">{title}</p>
        <Button variant="outline" size="sm" className="gap-2" onClick={onCopy}>
          <Clipboard className="h-3.5 w-3.5" />
          Copiar
        </Button>
      </div>
      <pre className="overflow-auto rounded-md bg-background/70 p-3 text-xs text-primary">
        {value}
      </pre>
    </div>
  );
}

function MetaConnectionWizard({
  meta,
  summary,
  onConnect,
  connectPending,
  onSaveSelection,
  selectionPending,
  onValidate,
  validatingConnectionId,
  onDisconnect,
  disconnectPending,
}: {
  meta: MarketingIntegration | undefined;
  summary: MetaSummary | undefined;
  onConnect: (token: string) => Promise<unknown>;
  connectPending: boolean;
  onSaveSelection: (accountIds: string[]) => Promise<unknown>;
  selectionPending: boolean;
  onValidate: (connectionId: string) => Promise<unknown>;
  validatingConnectionId: string | null;
  onDisconnect: (connectionId: string) => Promise<unknown>;
  disconnectPending: boolean;
}) {
  const isDemo = useIsDemoTenant();
  const connections = useMemo(() => summary?.connections ?? [], [summary?.connections]);
  const activeConnectionIds = useMemo(
    () => new Set(connections.map((item) => item.id)),
    [connections],
  );
  const accounts = useMemo(
    () =>
      (summary?.accounts ?? []).filter((account) => activeConnectionIds.has(account.connection_id)),
    [summary?.accounts, activeConnectionIds],
  );
  const [token, setToken] = useState("");
  const [showGuide, setShowGuide] = useState(connections.length === 0);
  const [showTokenForm, setShowTokenForm] = useState(connections.length === 0);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [disconnectId, setDisconnectId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedIds(accounts.filter((account) => account.selected).map((account) => account.id));
  }, [accounts]);

  useEffect(() => {
    if (connections.length === 0) setShowTokenForm(true);
  }, [connections.length]);

  const persistedSelectedCount = accounts.filter((account) => account.selected).length;
  const legacyConnections = connections.filter(
    (connection) => connection.auth_type === "legacy_oauth",
  );
  const currentStep = connections.length === 0 ? 1 : persistedSelectedCount === 0 ? 2 : 3;
  const connectionStatus = connections.some((connection) => connection.status === "error")
    ? "error"
    : connections.length > 0
      ? "connected"
      : meta?.status;

  return (
    <DataCard
      title="Meta Ads"
      description="Conecte sua conta, escolha o que deseja acompanhar e valide o acesso."
      icon={<Target className="h-4 w-4" />}
      actions={<StatusBadge status={connectionStatus} />}
    >
      <div className="mb-5 grid gap-2 sm:grid-cols-3">
        {["Conectar", "Escolher contas", "Validar acesso"].map((label, index) => {
          const step = index + 1;
          const complete = step < currentStep;
          const active = step === currentStep;
          return (
            <div
              key={label}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
                active && "border-primary/60 bg-primary/10",
                complete && "border-success/30 bg-success/10",
              )}
            >
              <span
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-bold",
                  active && "bg-primary text-primary-foreground",
                  complete && "bg-success/20 text-success",
                )}
              >
                {complete ? <CheckCircle2 className="h-4 w-4" /> : step}
              </span>
              <span className={cn("font-medium", !active && !complete && "text-muted-foreground")}>
                {label}
              </span>
            </div>
          );
        })}
      </div>

      <Button variant="outline" size="sm" onClick={() => setShowGuide((value) => !value)}>
        {showGuide ? "Esconder preparação" : "Como preparar a conta"}
      </Button>
      {legacyConnections.length > 0 && (
        <div className="mt-4 rounded-xl border border-warning/30 bg-warning/10 p-4 text-sm">
          <p className="font-semibold text-warning">Conexão antiga precisa ser substituída</p>
          <p className="mt-1 text-muted-foreground">
            A integração anterior usava o app compartilhado da plataforma. Gere um token no app da
            sua operação e conecte abaixo; os dados já importados serão preservados.
          </p>
        </div>
      )}
      {showGuide && (
        <div className="mt-3 grid gap-2 text-xs text-muted-foreground md:grid-cols-2">
          {[
            "Abra as Configurações do negócio no Business Manager.",
            "Crie um Usuário do Sistema para esta operação.",
            "Atribua somente as contas de anúncio necessárias.",
            "Gere um token no app da operação com ads_read.",
          ].map((step, index) => (
            <div key={step} className="flex gap-2 rounded-lg bg-muted/40 p-3">
              <span className="font-bold text-primary">{index + 1}</span>
              <span>{step}</span>
            </div>
          ))}
        </div>
      )}

      {(showTokenForm || connections.length === 0) && (
        <div className="mt-5 rounded-xl border border-border/60 bg-background/40 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-semibold">
                {connections.length ? "Atualizar credencial" : "Conectar sua conta Meta"}
              </p>
              <p className="text-xs text-muted-foreground">
                O token é criptografado no servidor e não volta a aparecer.
              </p>
            </div>
            {connections.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowTokenForm(false);
                  setToken("");
                }}
              >
                Cancelar
              </Button>
            )}
          </div>
          <Label className="mt-4 block" htmlFor="meta-system-token">
            Token do Usuário do Sistema
          </Label>
          <Input
            id="meta-system-token"
            className="mt-2"
            type="password"
            autoComplete="off"
            placeholder="EAAG..."
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <DemoDisabledTooltip active={isDemo}>
            <Button
              className="mt-3 gap-2"
              disabled={isDemo || connectPending || token.trim().length < 40}
              onClick={async () => {
                try {
                  await onConnect(token.trim());
                  setToken("");
                  setShowTokenForm(false);
                } catch {
                  // A mensagem de erro é exibida pela mutation; mantenha o token para nova tentativa.
                }
              }}
            >
              {connectPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="h-4 w-4" />
              )}
              Validar token e buscar contas
            </Button>
          </DemoDisabledTooltip>
        </div>
      )}

      {connections.length > 0 && !showTokenForm && (
        <div className="mt-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-semibold">Conexões encontradas</p>
              <p className="text-xs text-muted-foreground">
                Revise a origem antes de escolher as contas de anúncio.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setShowTokenForm(true)}>
              Atualizar token
            </Button>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            {connections.map((connection) => (
              <div
                key={connection.id}
                className={cn(
                  "rounded-xl border p-4",
                  connection.status === "error"
                    ? "border-danger/30 bg-danger/5"
                    : "border-border/60 bg-background/40",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">
                      {connection.connection_label ?? connection.app_name ?? "Conta Meta"}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      App {connection.app_name ?? connection.app_id ?? "identificado"} · token{" "}
                      {connection.token_hint ?? "protegido"}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Usuário: {connection.meta_user_name ?? "Usuário do Sistema"}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {connection.auth_type === "system_user_token"
                        ? "App próprio da operação"
                        : "Conexão antiga do app compartilhado"}
                    </p>
                  </div>
                  <StatusBadge status={connection.status} />
                </div>
                {connection.last_error && (
                  <p className="mt-3 rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">
                    {connection.last_error}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <DemoDisabledTooltip active={isDemo}>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-2"
                      disabled={isDemo || validatingConnectionId === connection.id}
                      onClick={() => onValidate(connection.id)}
                    >
                      {validatingConnectionId === connection.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                      )}{" "}
                      Testar acesso
                    </Button>
                  </DemoDisabledTooltip>
                  <DemoDisabledTooltip active={isDemo}>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-2 text-danger hover:text-danger/80"
                      disabled={isDemo}
                      onClick={() => setDisconnectId(connection.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Desconectar
                    </Button>
                  </DemoDisabledTooltip>
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-border/60 bg-background/40 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-semibold">Contas que entram nos relatórios</p>
                <p className="text-xs text-muted-foreground">
                  Somente as contas marcadas serão sincronizadas.
                </p>
              </div>
              <span className="text-sm font-semibold text-primary">
                {selectedIds.length} de {accounts.length} selecionadas
              </span>
            </div>
            <div className="app-scrollbar mt-3 max-h-64 space-y-2 overflow-y-auto pr-1">
              {accounts.map((account) => (
                <label
                  key={account.id}
                  className="flex cursor-pointer items-center gap-3 rounded-lg border border-border/50 px-3 py-3 hover:bg-muted/30"
                >
                  <Checkbox
                    checked={selectedIds.includes(account.id)}
                    onCheckedChange={(checked) =>
                      setSelectedIds((current) =>
                        checked
                          ? [...current, account.id]
                          : current.filter((id) => id !== account.id),
                      )
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">
                      {account.name ?? account.account_id}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {account.meta_ad_account_id}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground">{account.currency ?? ""}</span>
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-meta",
                      account.sync_status === "healthy" && "border-success/30 text-success",
                      account.sync_status === "warning" && "border-warning/30 text-warning",
                      account.sync_status === "error" && "border-danger/30 text-danger",
                    )}
                    title={account.last_error ?? undefined}
                  >
                    {account.sync_status === "healthy"
                      ? "dados atualizados"
                      : account.sync_status === "syncing"
                        ? "sincronizando"
                        : account.sync_status === "queued"
                          ? "aguardando"
                          : account.sync_status === "error"
                            ? "erro"
                            : account.sync_status === "warning"
                              ? "atenção"
                              : "sem leitura"}
                  </Badge>
                </label>
              ))}
              {accounts.length === 0 && (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  Nenhuma conta de anúncio foi encontrada.
                </p>
              )}
            </div>
            <div className="mt-4 flex justify-end">
              <DemoDisabledTooltip active={isDemo}>
                <Button
                  disabled={isDemo || selectionPending || accounts.length === 0}
                  onClick={() => onSaveSelection(selectedIds)}
                >
                  {selectionPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Salvar
                  contas
                </Button>
              </DemoDisabledTooltip>
            </div>
          </div>
        </div>
      )}

      <AlertDialog
        open={Boolean(disconnectId)}
        onOpenChange={(open) => !open && !disconnectPending && setDisconnectId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Desconectar esta conta Meta?</AlertDialogTitle>
            <AlertDialogDescription>
              O token armazenado será removido e as contas vinculadas deixarão de sincronizar. Os
              relatórios já importados serão preservados.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disconnectPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={disconnectPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async (event) => {
                event.preventDefault();
                if (!disconnectId) return;
                try {
                  await onDisconnect(disconnectId);
                  setDisconnectId(null);
                } catch {
                  // O diálogo permanece aberto e a mutation informa o erro.
                }
              }}
            >
              {disconnectPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Desconectar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DataCard>
  );
}
