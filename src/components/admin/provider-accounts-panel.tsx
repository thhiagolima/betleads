// Admin → Integrações: provider accounts (SMS/e-mail/voz) and each house's
// account per channel. Super admin only; vendor names never reach a house.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { KeyRound, Pencil, Plug, Plus, Power, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requestConfirmation, requestTextInput } from "@/components/system-dialog-host";
import {
  adminAddTenantSmsAccountOption,
  adminDeleteProviderAccount,
  adminListProviderAccounts,
  adminRemoveTenantSmsAccountOption,
  adminSaveProviderAccount,
  adminSetPlatformDefault,
  adminSetProviderAccountStatus,
  adminSetTenantChannel,
  adminSetTenantChannelProvider,
  adminTenantChannelImpact,
  adminTestProviderAccount,
} from "@/lib/provider-accounts.functions";
import {
  PROVIDER_CHANNEL_LABEL,
  PROVIDER_CHANNELS,
  PROVIDER_LABEL,
  SUPPORTED_CHANNELS,
  type ProviderChannelName,
  type SaveProviderAccountInput,
} from "@/lib/provider-accounts.shared";
import type { ProviderAccountView } from "@/lib/provider-accounts-admin.server";
import { adminListOwnProviderGrants, adminResolveRevokedOwnProvider, adminSetOwnProviderGrant } from "@/lib/own-provider.functions";
import {
  OWN_PROVIDER_CHANNEL_LABEL,
  OWN_PROVIDER_CHANNELS,
  type OwnProviderChannel,
} from "@/lib/own-provider.shared";
import type { OwnProviderGrantView } from "@/lib/own-provider-admin.server";
import { brl } from "@/lib/format";

const QUERY_KEY = ["admin", "provider-accounts"] as const;
const OWN_GRANTS_QUERY_KEY = ["admin", "own-provider-grants"] as const;
const PLATFORM = "platform";
/** Canais com conta própria, como `Set` para teste O(1) no filtro de colunas. */
const OWN_CHANNEL_SET = new Set<ProviderChannelName>(OWN_PROVIDER_CHANNELS);
/** Valor do item "Re-sincronizar domínios de e-mail" no menu "Tornar padrão". */
const RESYNC_EMAIL = "resync-email";

type Provider = ProviderAccountView["provider"];

const CREDENTIAL_FIELDS: Record<Provider, Array<{ key: string; label: string }>> = {
  short_brasil: [
    { key: "shortcode_token", label: "Token da API Short Code" },
    { key: "usuario", label: "Usuário (API legada)" },
    { key: "chave", label: "Chave (API legada)" },
  ],
  infobip: [{ key: "api_key", label: "API key" }],
  onesignal: [{ key: "org_api_key", label: "Chave da organização" }],
};

const CONFIG_FIELDS: Record<
  Provider,
  Array<{ key: string; label: string; placeholder: string }>
> = {
  short_brasil: [
    {
      key: "shortcode_url",
      label: "URL da API Short Code (opcional)",
      placeholder: "https://api.shortcode.com.br/messages",
    },
    {
      key: "single_url",
      label: "URL de envio individual (opcional)",
      placeholder: "http://lp01-short.painelsms.com/bot/single-sms.php",
    },
    {
      key: "bulk_url",
      label: "URL de envio em lote (opcional)",
      placeholder: "http://lp01-short.painelsms.com/bot/bulk-sms.php",
    },
  ],
  infobip: [
    { key: "base_url", label: "URL base", placeholder: "https://xxxxx.api.infobip.com" },
    {
      key: "sms_from",
      label: "Remetente do SMS (opcional: número ou nome aprovado na Infobip)",
      placeholder: "Em branco = remetente padrão da conta",
    },
    {
      key: "voice_from",
      label: "Número de origem das ligações (voz)",
      placeholder: "5511999990000",
    },
  ],
  onesignal: [
    {
      key: "org_id",
      label: "ID da organização (opcional)",
      placeholder: "Em branco = sem organization_id nas chamadas",
    },
  ],
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function ProviderAccountsPanel() {
  const listFn = useServerFn(adminListProviderAccounts);
  const { data, isLoading } = useQuery({ queryKey: QUERY_KEY, queryFn: () => listFn() });
  const grantsFn = useServerFn(adminListOwnProviderGrants);
  const { data: grants } = useQuery({
    queryKey: OWN_GRANTS_QUERY_KEY,
    queryFn: () => grantsFn(),
  });
  const [editing, setEditing] = useState<ProviderAccountView | "new" | null>(null);

  return (
    <div className="space-y-4">
      <AccountsCard
        accounts={data?.accounts ?? []}
        tenants={data?.tenants ?? []}
        verifiedEmailDomainsOnDefault={data?.verifiedEmailDomainsOnDefault ?? 0}
        loading={isLoading}
        onCreate={() => setEditing("new")}
        onEdit={setEditing}
      />
      <TenantProvidersCard
        accounts={data?.accounts ?? []}
        tenants={data?.tenants ?? []}
        defaults={data?.defaults ?? ({} as Record<ProviderChannelName, string>)}
        grants={grants ?? []}
        loading={isLoading}
      />
      {editing && (
        <AccountDialog
          account={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

// ─── Contas ─────────────────────────────────────────────────────────────────

export function AccountsCard({
  accounts,
  tenants,
  verifiedEmailDomainsOnDefault,
  loading,
  onCreate,
  onEdit,
}: {
  accounts: ProviderAccountView[];
  tenants: TenantProvidersRow[];
  verifiedEmailDomainsOnDefault: number;
  loading: boolean;
  onCreate: () => void;
  onEdit: (account: ProviderAccountView) => void;
}) {
  const qc = useQueryClient();
  const statusFn = useServerFn(adminSetProviderAccountStatus);
  const testFn = useServerFn(adminTestProviderAccount);
  const setDefaultFn = useServerFn(adminSetPlatformDefault);
  const deleteFn = useServerFn(adminDeleteProviderAccount);

  const status = useMutation({
    mutationFn: (input: { id: string; status: "active" | "disabled" }) => statusFn({ data: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
    onError: (error) => toast.error(errorMessage(error)),
  });
  const test = useMutation({
    mutationFn: (input: { id: string; phone?: string }) => testFn({ data: input }),
    onSuccess: (result) =>
      result.ok ? toast.success(result.message) : toast.error(result.message),
    onError: (error) => toast.error(errorMessage(error)),
  });
  const setDefault = useMutation({
    mutationFn: (input: { channel: ProviderChannelName; accountId: string; resync?: boolean }) =>
      setDefaultFn({ data: { channel: input.channel, accountId: input.accountId } }),
    onSuccess: (result, input) => {
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
      if (input.resync) {
        toast.success(
          result.emailDomains.length > 0
            ? "Domínios de e-mail re-sincronizados com a conta padrão."
            : "Todos os domínios de e-mail já estão na conta padrão.",
        );
      } else {
        toast.success(`Conta agora é a padrão de ${PROVIDER_CHANNEL_LABEL[input.channel]}.`);
      }
      if (result.emailDomains.length > 0) {
        const pending = result.emailDomains.filter((d) => d.status !== "verified");
        toast.warning(
          `${result.emailDomains.length} domínio(s) de e-mail recadastrado(s) na conta nova; ${pending.length} aguardam a casa publicar os DNS novos.`,
        );
      }
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const remove = useMutation({
    mutationFn: (input: { id: string }) => deleteFn({ data: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
      toast.success("Conta excluída");
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  async function toggle(account: ProviderAccountView) {
    const disabling = account.status === "active";
    const inUse = PROVIDER_CHANNELS.reduce((n, c) => n + account.houses[c], 0);
    if (disabling) {
      const ok = await requestConfirmation({
        title: `Desativar "${account.label}"?`,
        description:
          inUse > 0
            ? `${inUse} vínculo(s) de casa usam esta conta. Essas casas param de enviar pelos canais dela (não há troca automática para a conta padrão) até a conta voltar ou a casa mudar de conta.`
            : "Nenhuma casa usa esta conta agora.",
        confirmLabel: "Desativar",
        destructive: true,
      });
      if (!ok) return;
    }
    status.mutate({ id: account.id, status: disabling ? "disabled" : "active" });
  }

  /** Salvar de novo a mesma padrão de e-mail retoma uma troca que parou no
   * meio: só os domínios que ainda não estão nesta conta são recadastrados. */
  async function resyncEmailDomains(account: ProviderAccountView) {
    const ok = await requestConfirmation({
      title: "Re-sincronizar domínios de e-mail?",
      description: `Os domínios de e-mail das casas sem conta própria que ainda não estão em "${account.label}" serão recadastrados nela e voltam a pendente até a casa publicar os DNS novos.`,
      confirmLabel: "Re-sincronizar",
    });
    if (!ok) return;
    setDefault.mutate({ channel: "email", accountId: account.id, resync: true });
  }

  async function makeDefault(account: ProviderAccountView, channel: ProviderChannelName) {
    // Computed client-side from the tenants list already in the query cache
    // (no conta própria no canal + canal ligado) — same data the server
    // used to build `houses`, no extra round-trip needed.
    const n = tenants.filter((t) => !t.accounts[channel] && t.channels[channel]).length;
    const ok = await requestConfirmation({
      title: `Tornar "${account.label}" a padrão de ${PROVIDER_CHANNEL_LABEL[channel]}?`,
      description: `"${account.label}" passa a ser a padrão de ${PROVIDER_CHANNEL_LABEL[channel]} para ${n} casa(s) sem conta própria.`,
      confirmLabel: "Tornar padrão",
    });
    if (!ok) return;
    if (channel === "email" && verifiedEmailDomainsOnDefault > 0) {
      const ok2 = await requestConfirmation({
        title: "Trocar a padrão de e-mail?",
        description: `${verifiedEmailDomainsOnDefault} domínios de e-mail voltam a pendente e essas casas ficam sem enviar e-mail até o DNS ser revalidado na conta nova. E-mails da plataforma (faturas, convites) continuam na conta do ambiente.`,
        confirmLabel: "Trocar mesmo assim",
        destructive: true,
      });
      if (!ok2) return;
    }
    setDefault.mutate({ channel, accountId: account.id });
  }

  async function deleteAccount(account: ProviderAccountView) {
    const ok = await requestConfirmation({
      title: `Excluir "${account.label}"?`,
      description:
        "Esta ação não pode ser desfeita. Só é possível excluir uma conta que não é padrão de nenhum canal e que nenhuma casa usa.",
      confirmLabel: "Excluir",
      destructive: true,
    });
    if (!ok) return;
    remove.mutate({ id: account.id });
  }

  const tenantNameById = useMemo(() => new Map(tenants.map((t) => [t.id, t.nome])), [tenants]);

  async function runTest(account: ProviderAccountView) {
    if (account.provider === "short_brasil") {
      const phone = await requestTextInput({
        title: "Testar conta Short Brasil",
        description:
          "A Short Brasil não tem consulta de saldo: o teste envia 1 SMS real por esta conta (não cobrado da casa).",
        label: "Celular que recebe o teste",
        placeholder: "(11) 99999-0000",
        confirmLabel: "Enviar teste",
      });
      if (!phone) return;
      test.mutate({ id: account.id, phone });
    } else {
      test.mutate({ id: account.id });
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-primary" /> Contas de provedor
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Contas da BetLeads que as casas podem usar. Contas do ambiente usam as credenciais do
            servidor; escolha a padrão de cada canal com "Tornar padrão".
          </p>
        </div>
        <Button size="sm" onClick={onCreate}>
          <Plus className="h-4 w-4" /> Nova conta
        </Button>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Conta</TableHead>
              <TableHead>Canais</TableHead>
              <TableHead>Credenciais</TableHead>
              <TableHead>Casas</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <TableRow>
                <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                  Carregando…
                </TableCell>
              </TableRow>
            )}
            {accounts.map((account) => {
              const houses = PROVIDER_CHANNELS.filter((c) => account.houses[c] > 0)
                .map((c) => `${PROVIDER_CHANNEL_LABEL[c]}: ${account.houses[c]}`)
                .join(" · ");
              const eligibleForDefault = account.channels.filter(
                (c) => !account.defaultFor.includes(c),
              );
              const canToggleOff = !(account.status === "active" && account.defaultFor.length > 0);
              return (
                <TableRow key={account.id}>
                  <TableCell>
                    <div className="font-medium">{account.label}</div>
                    <div className="text-meta text-muted-foreground">
                      {PROVIDER_LABEL[account.provider]}
                      {account.envAccount ? " · conta do ambiente" : ""}
                    </div>
                    {account.defaultFor.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {account.defaultFor.map((c) => (
                          <Badge key={c} variant="default">
                            padrão de {PROVIDER_CHANNEL_LABEL[c]}
                          </Badge>
                        ))}
                      </div>
                    )}
                    {account.ownerTenantId && (
                      <div className="mt-1">
                        <Badge variant="outline">
                          Conta da casa {tenantNameById.get(account.ownerTenantId) ?? "desconhecida"}
                        </Badge>
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {account.channels.map((c) => (
                        <Badge key={c} variant="secondary">
                          {PROVIDER_CHANNEL_LABEL[c]}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-meta">
                    {account.ownerTenantId ? (
                      <span className="text-muted-foreground">conta da casa</span>
                    ) : Object.keys(account.credentialHints).length === 0 ? (
                      <span className="text-destructive">nenhuma</span>
                    ) : (
                      Object.entries(account.credentialHints).map(([key, value]) => (
                        <div key={key}>
                          {key}: {value}
                        </div>
                      ))
                    )}
                  </TableCell>
                  <TableCell className="text-meta">
                    {account.defaultFor.length > 0 ? "todas sem conta própria" : houses || "—"}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      <Badge variant={account.status === "active" ? "default" : "outline"}>
                        {account.status === "active" ? "ativa" : "desativada"}
                      </Badge>
                      {!account.configured && <Badge variant="destructive">incompleta</Badge>}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap justify-end gap-1">
                      {!account.ownerTenantId && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => runTest(account)}
                          disabled={test.isPending}
                        >
                          <Plug className="h-4 w-4" /> Testar
                        </Button>
                      )}
                      {!account.ownerTenantId && (
                        <Button variant="outline" size="sm" onClick={() => onEdit(account)}>
                          <Pencil className="h-4 w-4" /> Editar
                        </Button>
                      )}
                      {!account.ownerTenantId &&
                        account.status === "active" &&
                        (eligibleForDefault.length > 0 || account.defaultFor.includes("email")) && (
                        <Select
                          value=""
                          onValueChange={(value) =>
                            value === RESYNC_EMAIL
                              ? void resyncEmailDomains(account)
                              : void makeDefault(account, value as ProviderChannelName)
                          }
                          disabled={setDefault.isPending}
                        >
                          <SelectTrigger className="h-8 w-auto gap-1 px-2 text-meta">
                            <Star className="h-3.5 w-3.5" />
                            <SelectValue placeholder="Tornar padrão" />
                          </SelectTrigger>
                          <SelectContent>
                            {eligibleForDefault.map((c) => (
                              <SelectItem key={c} value={c}>
                                Tornar padrão de {PROVIDER_CHANNEL_LABEL[c]}
                              </SelectItem>
                            ))}
                            {account.defaultFor.includes("email") && (
                              <SelectItem value={RESYNC_EMAIL}>
                                Re-sincronizar domínios de e-mail
                              </SelectItem>
                            )}
                          </SelectContent>
                        </Select>
                      )}
                      {canToggleOff && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => toggle(account)}
                          disabled={status.isPending}
                        >
                          <Power className="h-4 w-4" />
                          {account.status === "active" ? "Desativar" : "Reativar"}
                        </Button>
                      )}
                      {!account.ownerTenantId && !account.envAccount && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => deleteAccount(account)}
                          disabled={remove.isPending}
                        >
                          <Trash2 className="h-4 w-4" /> Excluir
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function AccountDialog({
  account,
  onClose,
}: {
  account: ProviderAccountView | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const saveFn = useServerFn(adminSaveProviderAccount);
  const isEnv = Boolean(account?.envAccount);
  const [provider, setProvider] = useState<Provider>(account?.provider ?? "infobip");
  const [label, setLabel] = useState(account?.label ?? "");
  const [channels, setChannels] = useState<ProviderChannelName[]>(
    account?.channels ?? [...SUPPORTED_CHANNELS[account?.provider ?? "infobip"]],
  );
  const [config, setConfig] = useState<Record<string, string>>(account?.config ?? {});
  const [credentials, setCredentials] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: () => {
      const input: SaveProviderAccountInput = {
        id: account?.id,
        provider,
        label,
        channels,
        config,
        credentials,
      };
      return saveFn({ data: input });
    },
    onSuccess: () => {
      toast.success(account ? "Conta atualizada" : "Conta criada");
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
      onClose();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const changeProvider = (next: Provider) => {
    setProvider(next);
    setChannels([...SUPPORTED_CHANNELS[next]]);
    setConfig({});
    setCredentials({});
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {account ? `Editar "${account.label}"` : "Nova conta de provedor"}
          </DialogTitle>
          <DialogDescription>
            {isEnv
              ? "Esta conta usa as credenciais das variáveis de ambiente do servidor: edite aqui só o nome e os canais."
              : "As credenciais ficam cifradas no banco e nunca voltam para a tela. Deixe um campo em branco para manter o valor atual."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Provedor</Label>
              <Select
                value={provider}
                onValueChange={(v) => changeProvider(v as Provider)}
                disabled={Boolean(account)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="infobip">Infobip</SelectItem>
                  <SelectItem value="short_brasil">Short Brasil</SelectItem>
                  <SelectItem value="onesignal">OneSignal</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="provider-account-label">Nome</Label>
              <Input
                id="provider-account-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Ex.: Infobip Casa X"
                required
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Canais</Label>
            <div className="flex flex-wrap gap-4">
              {SUPPORTED_CHANNELS[provider].map((channel) => (
                <label key={channel} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={channels.includes(channel)}
                    onCheckedChange={(checked) =>
                      setChannels((prev) =>
                        checked ? [...prev, channel] : prev.filter((c) => c !== channel),
                      )
                    }
                  />
                  {PROVIDER_CHANNEL_LABEL[channel]}
                </label>
              ))}
            </div>
          </div>

          {!isEnv &&
            CONFIG_FIELDS[provider]
              .filter(
                (field) =>
                  (field.key !== "voice_from" || channels.includes("voice")) &&
                  (field.key !== "sms_from" || channels.includes("sms")),
              )
              .map((field) => (
                <div key={field.key} className="space-y-1">
                  <Label htmlFor={`cfg-${field.key}`}>{field.label}</Label>
                  <Input
                    id={`cfg-${field.key}`}
                    value={config[field.key] ?? ""}
                    onChange={(e) =>
                      setConfig((prev) => ({ ...prev, [field.key]: e.target.value }))
                    }
                    placeholder={field.placeholder}
                    className="font-mono text-meta"
                  />
                </div>
              ))}

          {!isEnv &&
            CREDENTIAL_FIELDS[provider].map((field) => (
              <div key={field.key} className="space-y-1">
                <Label htmlFor={`cred-${field.key}`}>{field.label}</Label>
                <Input
                  id={`cred-${field.key}`}
                  type="password"
                  autoComplete="off"
                  value={credentials[field.key] ?? ""}
                  onChange={(e) =>
                    setCredentials((prev) => ({ ...prev, [field.key]: e.target.value }))
                  }
                  placeholder={
                    account?.credentialHints[field.key]
                      ? `atual: ${account.credentialHints[field.key]}`
                      : ""
                  }
                  className="font-mono text-meta"
                />
              </div>
            ))}
          {!isEnv && provider === "short_brasil" && (
            <p className="text-meta text-muted-foreground">
              Informe o token da API Short Code ou o usuário e a chave da API legada. O envio em
              lote só funciona com a API legada.
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? "Salvando…" : "Salvar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Provedor por casa ──────────────────────────────────────────────────────

export type TenantProvidersRow = {
  id: string;
  nome: string;
  accounts: Record<ProviderChannelName, string | null>;
  channels: Record<ProviderChannelName, boolean>;
  /** Extra SMS accounts the house may pick per campaign (besides its default). */
  smsOptions?: Array<{ accountId: string; displayName: string }>;
};

/**
 * Opções do seletor de conta por casa de um canal: só contas da plataforma
 * (ativas, atendem o canal) — conta com dono (de qualquer casa, inclusive a
 * própria) nunca aparece aqui. O super admin nunca liga/desliga uma conta
 * com dono por este seletor; isso é coisa da casa (ativar/"voltar para a
 * rota da BetLeads") ou da revogação (adminResolveRevokedOwnProvider), e o
 * servidor (adminSetTenantChannelProviderFor) já recusa a tentativa.
 */
export function tenantChannelAccountOptions(
  accounts: ProviderAccountView[],
  channel: ProviderChannelName,
): ProviderAccountView[] {
  return accounts.filter(
    (a) =>
      a.status === "active" &&
      !a.ownerTenantId &&
      a.channels.includes(channel) &&
      SUPPORTED_CHANNELS[a.provider].includes(channel),
  );
}

/** "Plataforma" / "Conta da casa: {label}" / "Pausado: aguardando decisão" — o estado da
 * concessão de conta própria de um canal, exibido na linha da casa. */
export function ownProviderStateLabel(grant: OwnProviderGrantView | undefined): string {
  if (grant?.pendingDecision) return "Pausado: aguardando decisão";
  if (grant?.active && grant.account) return `Conta da casa: ${grant.account.label}`;
  return "Plataforma";
}

/** Mensagem de confirmação ao desligar "Permitir conta própria" de um canal já liberado. */
export function ownProviderPauseConfirmMessage(channel: OwnProviderChannel): string {
  return `Os envios de ${OWN_PROVIDER_CHANNEL_LABEL[channel]} desta casa vão pausar e a equipe da casa verá um aviso. Nada sai pela rota da BetLeads até você decidir.`;
}

/** "R$" em texto livre (vírgula ou ponto) -> centavos inteiros, `null` se inválido (vazio, não
 * numérico, ou negativo). "0" é válido: a taxa pode ser zero. */
export function parseFeeInputCents(raw: string): number | null {
  const trimmed = raw.trim().replace(",", ".");
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** Mensagem de confirmação ao salvar a taxa mensal de um canal (fix round 1: toda mudança de
 * valor cobrado pede confirmação, como as outras ações de cobrança do painel). */
export function ownProviderFeeConfirmMessage(channel: OwnProviderChannel, cents: number): string {
  return `A taxa mensal de ${OWN_PROVIDER_CHANNEL_LABEL[channel]} desta casa passa a ser ${brl(cents / 100)} a partir da próxima fatura.`;
}

type SetOwnGrantVars = {
  tenantId: string;
  channel: OwnProviderChannel;
  allowed: boolean;
  monthlyFeeCents: number;
};

/**
 * O que o Switch "Permitir conta própria" chama ao mudar (fix round 1): ligar pede a taxa mensal
 * na hora (sem ela a concessão nunca teria um valor digitado) e manda os dois juntos; desligar
 * pede a confirmação de pausa de sempre. Função pura e exportada (independente de estado do
 * componente) para ser testável sem simular um evento de DOM — este repo não tem
 * @testing-library/react nem jsdom (ver link-domain-dialog.test.tsx).
 */
export function createOwnProviderToggleHandler(opts: {
  tenant: TenantProvidersRow;
  channel: OwnProviderChannel;
  feeCents: number;
  feeDraft: string;
  onSetGrant: (vars: SetOwnGrantVars) => void;
}) {
  return async (next: boolean) => {
    const { tenant, channel, feeCents, feeDraft, onSetGrant } = opts;
    if (next) {
      const typed = await requestTextInput({
        title: `Permitir conta própria de ${OWN_PROVIDER_CHANNEL_LABEL[channel]} para ${tenant.nome}?`,
        description:
          "A casa poderá ligar a conta própria deste canal. Defina a taxa mensal cobrada da casa por isso (pode ser 0).",
        label: "Taxa mensal (R$)",
        placeholder: "0,00",
        initialValue: feeDraft,
        confirmLabel: "Permitir",
      });
      if (typed === null) return;
      const cents = parseFeeInputCents(typed);
      if (cents === null) {
        toast.error("Informe uma taxa válida em R$ (0 ou mais).");
        return;
      }
      onSetGrant({ tenantId: tenant.id, channel, allowed: true, monthlyFeeCents: cents });
    } else {
      const ok = await requestConfirmation({
        title: `Desligar conta própria de ${OWN_PROVIDER_CHANNEL_LABEL[channel]} para ${tenant.nome}?`,
        description: ownProviderPauseConfirmMessage(channel),
        confirmLabel: "Desligar",
        destructive: true,
      });
      if (!ok) return;
      onSetGrant({ tenantId: tenant.id, channel, allowed: false, monthlyFeeCents: feeCents });
    }
  };
}

/**
 * O que o botão "Salvar" da taxa mensal chama (fix round 1: nunca grava no blur — toda troca de
 * valor cobrado pede confirmação antes). Mesma razão de ser exportada/pura que o toggle acima.
 */
export function createOwnProviderSaveFeeHandler(opts: {
  tenant: TenantProvidersRow;
  channel: OwnProviderChannel;
  allowed: boolean;
  draftCents: number | null;
  onSetGrant: (vars: SetOwnGrantVars) => void;
}) {
  return async () => {
    const { tenant, channel, allowed, draftCents, onSetGrant } = opts;
    if (draftCents === null) {
      toast.error("Informe uma taxa válida em R$ (0 ou mais).");
      return;
    }
    const ok = await requestConfirmation({
      title: `Taxa mensal de ${OWN_PROVIDER_CHANNEL_LABEL[channel]}`,
      description: ownProviderFeeConfirmMessage(channel, draftCents),
      confirmLabel: "Salvar",
    });
    if (!ok) return;
    onSetGrant({ tenantId: tenant.id, channel, allowed, monthlyFeeCents: draftCents });
  };
}

function OwnProviderGrantCell({
  tenant,
  channel,
  grant,
  onSetGrant,
  onResolve,
  pending,
}: {
  tenant: TenantProvidersRow;
  channel: OwnProviderChannel;
  grant: OwnProviderGrantView | undefined;
  onSetGrant: (vars: SetOwnGrantVars) => void;
  onResolve: (vars: {
    tenantId: string;
    channel: OwnProviderChannel;
    action: "use_default" | "keep_paused";
  }) => void;
  pending: boolean;
}) {
  const allowed = grant?.allowed ?? false;
  const feeCents = grant?.monthlyFeeCents ?? 0;
  const [feeDraft, setFeeDraft] = useState(String(feeCents / 100));
  useEffect(() => {
    setFeeDraft(String(feeCents / 100));
  }, [feeCents]);

  const draftCents = parseFeeInputCents(feeDraft);
  const feeChanged = draftCents !== null && draftCents !== feeCents;

  const toggleAllowed = createOwnProviderToggleHandler({
    tenant,
    channel,
    feeCents,
    feeDraft,
    onSetGrant,
  });
  const saveFee = createOwnProviderSaveFeeHandler({
    tenant,
    channel,
    allowed,
    draftCents,
    onSetGrant,
  });

  return (
    <div className="mt-2 space-y-1.5 border-t pt-2">
      <label className="flex items-center justify-between gap-2 text-meta">
        <span>Permitir conta própria</span>
        <Switch
          checked={allowed}
          onCheckedChange={(checked) => void toggleAllowed(checked)}
          disabled={pending}
        />
      </label>
      {allowed && (
        <div className="flex items-center gap-2">
          <Label htmlFor={`own-fee-${tenant.id}-${channel}`} className="text-meta">
            Taxa mensal (R$)
          </Label>
          <Input
            id={`own-fee-${tenant.id}-${channel}`}
            type="number"
            min={0}
            step="0.01"
            value={feeDraft}
            onChange={(e) => setFeeDraft(e.target.value)}
            className="h-7 w-24 text-meta"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!feeChanged || pending}
            onClick={() => void saveFee()}
          >
            Salvar
          </Button>
        </div>
      )}
      <div className="text-meta text-muted-foreground">{ownProviderStateLabel(grant)}</div>
      {grant?.pendingDecision && (
        <div className="flex flex-wrap gap-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onResolve({ tenantId: tenant.id, channel, action: "use_default" })}
          >
            Voltar para a padrão
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onResolve({ tenantId: tenant.id, channel, action: "keep_paused" })}
          >
            Manter pausado
          </Button>
        </div>
      )}
    </div>
  );
}

export function TenantProvidersCard({
  accounts,
  tenants,
  defaults,
  grants,
  loading,
}: {
  accounts: ProviderAccountView[];
  tenants: TenantProvidersRow[];
  defaults: Record<ProviderChannelName, string>;
  grants: OwnProviderGrantView[];
  loading: boolean;
}) {
  const qc = useQueryClient();
  const setFn = useServerFn(adminSetTenantChannelProvider);
  const impactFn = useServerFn(adminTenantChannelImpact);
  const setChannelFn = useServerFn(adminSetTenantChannel);
  const setOwnGrantFn = useServerFn(adminSetOwnProviderGrant);
  const resolveOwnGrantFn = useServerFn(adminResolveRevokedOwnProvider);
  const [search, setSearch] = useState("");
  const [smsOptionsTenantId, setSmsOptionsTenantId] = useState<string | null>(null);
  const smsOptionsTenant = tenants.find((t) => t.id === smsOptionsTenantId) ?? null;

  const optionsByChannel = useMemo(() => {
    const out = {} as Record<ProviderChannelName, ProviderAccountView[]>;
    for (const channel of PROVIDER_CHANNELS) {
      out[channel] = tenantChannelAccountOptions(accounts, channel);
    }
    return out;
  }, [accounts]);
  const grantsByKey = useMemo(() => {
    const map = new Map<string, OwnProviderGrantView>();
    for (const g of grants) map.set(`${g.tenantId}:${g.channel}`, g);
    return map;
  }, [grants]);
  const labelOf = (id: string | null) =>
    id ? (accounts.find((a) => a.id === id)?.label ?? "conta removida") : "a conta padrão";
  const defaultLabelOf = (channel: ProviderChannelName) => labelOf(defaults[channel] ?? null);

  const setOwnGrant = useMutation({
    mutationFn: (input: {
      tenantId: string;
      channel: OwnProviderChannel;
      allowed: boolean;
      monthlyFeeCents: number;
    }) => setOwnGrantFn({ data: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: OWN_GRANTS_QUERY_KEY }),
    onError: (error) => toast.error(errorMessage(error)),
  });
  const resolveOwnGrant = useMutation({
    mutationFn: (input: {
      tenantId: string;
      channel: OwnProviderChannel;
      action: "use_default" | "keep_paused";
    }) => resolveOwnGrantFn({ data: input }),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: OWN_GRANTS_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
      if (result.emailDomains.length > 0) {
        const pending = result.emailDomains.filter((d) => d.status !== "verified");
        toast.warning(
          `${result.emailDomains.length} domínio(s) de e-mail recadastrado(s) na conta padrão; ${pending.length} aguardam a casa publicar os DNS novos.`,
        );
      }
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const assign = useMutation({
    mutationFn: (input: {
      tenantId: string;
      channel: ProviderChannelName;
      accountId: string | null;
    }) => setFn({ data: input }),
    onSuccess: (result, input) => {
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
      toast.success(`${PROVIDER_CHANNEL_LABEL[input.channel]}: ${labelOf(input.accountId)}`);
      if (result.emailDomains.length > 0) {
        const pending = result.emailDomains.filter((d) => d.status !== "verified");
        toast.warning(
          `${result.emailDomains.length} domínio(s) de e-mail recadastrado(s) na conta nova; ${pending.length} aguardam a casa publicar os DNS novos.`,
        );
      }
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  async function change(tenant: TenantProvidersRow, channel: ProviderChannelName, value: string) {
    const accountId = value === PLATFORM ? null : value;
    if (accountId === tenant.accounts[channel]) return;
    const ok = await requestConfirmation({
      title: `${PROVIDER_CHANNEL_LABEL[channel]} de ${tenant.nome}`,
      description: [
        `Os próximos envios de ${PROVIDER_CHANNEL_LABEL[channel]} desta casa passam a sair por "${labelOf(accountId)}". Se essa conta cair, a casa para de enviar (não há troca automática para outra conta).`,
        channel === "email"
          ? "Os domínios de e-mail da casa serão recadastrados na conta nova e voltam a pendente: o e-mail da casa fica bloqueado até ela publicar os DNS novos e o domínio verificar."
          : "",
      ]
        .filter(Boolean)
        .join(" "),
      confirmLabel: "Trocar conta",
      destructive: channel === "email",
    });
    if (!ok) return;
    assign.mutate({ tenantId: tenant.id, channel, accountId });
  }

  const setChannel = useMutation({
    mutationFn: (input: { tenantId: string; channel: ProviderChannelName; enabled: boolean }) =>
      setChannelFn({ data: input }),
    onSuccess: (result, input) => {
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
      toast.success(
        input.enabled
          ? `${PROVIDER_CHANNEL_LABEL[input.channel]} ligado.`
          : `${PROVIDER_CHANNEL_LABEL[input.channel]} desligado${result.cancelled > 0 ? ` (${result.cancelled} envio(s) cancelado(s))` : ""}.`,
      );
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  async function toggleChannel(
    tenant: TenantProvidersRow,
    channel: ProviderChannelName,
    enabled: boolean,
  ) {
    if (!enabled) {
      let impact: { activeJourneys: number; scheduledCampaigns: number };
      try {
        impact = await impactFn({ data: { tenantId: tenant.id, channel } });
      } catch (error) {
        toast.error(errorMessage(error));
        return;
      }
      const ok = await requestConfirmation({
        title: `Desligar ${PROVIDER_CHANNEL_LABEL[channel]} para ${tenant.nome}?`,
        description: `${impact.activeJourneys} jornada(s) ativa(s) vão pular esses passos e ${impact.scheduledCampaigns} envio(s) agendado(s) serão cancelados. O pessoal da casa verá um aviso.`,
        confirmLabel: "Desligar",
        destructive: true,
      });
      if (!ok) return;
    }
    setChannel.mutate({ tenantId: tenant.id, channel, enabled });
  }

  const visible = tenants.filter((t) => t.nome.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>Provedor por casa</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Sem escolha, a casa usa a conta padrão da plataforma. A troca vale em até 30 segundos.
          </p>
        </div>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar casa"
          className="max-w-56"
        />
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Casa</TableHead>
              {PROVIDER_CHANNELS.map((c) => (
                <TableHead key={c}>{PROVIDER_CHANNEL_LABEL[c]}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <TableRow>
                <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                  Carregando…
                </TableCell>
              </TableRow>
            )}
            {!loading && visible.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                  Nenhuma casa encontrada.
                </TableCell>
              </TableRow>
            )}
            {visible.map((tenant) => (
              <TableRow key={tenant.id}>
                <TableCell className="font-medium">{tenant.nome}</TableCell>
                {PROVIDER_CHANNELS.map((channel) => {
                  const current = tenant.accounts[channel];
                  const options = optionsByChannel[channel];
                  const enabled = tenant.channels[channel];
                  // Keep a current account missing from `options` visible in its own select —
                  // either it's disabled, or (now that `options` never lists an owned account)
                  // it's the house's own account, activated by its admin.
                  const currentMissing = current && !options.some((a) => a.id === current);
                  const currentAccountRow = current
                    ? accounts.find((a) => a.id === current) ?? null
                    : null;
                  const missingSuffix = currentAccountRow?.ownerTenantId
                    ? " (conta própria da casa)"
                    : " (desativada)";
                  const isOwnChannel = OWN_CHANNEL_SET.has(channel);
                  return (
                    <TableCell key={channel} className="min-w-52">
                      <div className="mb-1.5 flex items-center gap-2">
                        <Switch
                          checked={enabled}
                          onCheckedChange={(checked) =>
                            void toggleChannel(tenant, channel, checked)
                          }
                          disabled={setChannel.isPending}
                        />
                        <span className="text-meta text-muted-foreground">
                          {enabled ? "ligado" : "desligado"}
                        </span>
                      </div>
                      <Select
                        value={current ?? PLATFORM}
                        onValueChange={(value) => void change(tenant, channel, value)}
                        disabled={assign.isPending || !enabled}
                      >
                        <SelectTrigger className={current ? "border-primary/60" : undefined}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={PLATFORM}>Padrão ({defaultLabelOf(channel)})</SelectItem>
                          {currentMissing && (
                            <SelectItem value={current}>
                              {labelOf(current)}
                              {missingSuffix}
                            </SelectItem>
                          )}
                          {options.map((a) => (
                            <SelectItem key={a.id} value={a.id}>
                              {a.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {isOwnChannel && (
                        <OwnProviderGrantCell
                          tenant={tenant}
                          channel={channel as OwnProviderChannel}
                          grant={grantsByKey.get(`${tenant.id}:${channel}`)}
                          onSetGrant={setOwnGrant.mutate}
                          onResolve={resolveOwnGrant.mutate}
                          pending={setOwnGrant.isPending}
                        />
                      )}
                      {channel === "sms" && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="mt-1 h-7 px-2 text-meta"
                          onClick={() => setSmsOptionsTenantId(tenant.id)}
                        >
                          Contas extras ({tenant.smsOptions?.length ?? 0})
                        </Button>
                      )}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
      <TenantSmsOptionsDialog
        tenant={smsOptionsTenant}
        accounts={accounts}
        smsAccounts={optionsByChannel.sms}
        defaultAccountId={
          smsOptionsTenant ? (smsOptionsTenant.accounts.sms ?? defaults.sms ?? null) : null
        }
        onClose={() => setSmsOptionsTenantId(null)}
      />
    </Card>
  );
}

/**
 * Extra SMS accounts of one house: the house picks one of them (or its default)
 * when it sends an SMS campaign or test, and only ever sees `displayName`.
 */
export function TenantSmsOptionsDialog({
  tenant,
  accounts,
  smsAccounts,
  defaultAccountId,
  onClose,
}: {
  tenant: TenantProvidersRow | null;
  accounts: ProviderAccountView[];
  /** Active accounts that can send SMS. */
  smsAccounts: ProviderAccountView[];
  /** Account the house's "Padrão da casa" resolves to today. */
  defaultAccountId: string | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const addFn = useServerFn(adminAddTenantSmsAccountOption);
  const removeFn = useServerFn(adminRemoveTenantSmsAccountOption);
  const [accountId, setAccountId] = useState("");
  const [displayName, setDisplayName] = useState("");

  const options = tenant?.smsOptions ?? [];
  const labelOf = (id: string) => accounts.find((a) => a.id === id)?.label ?? "conta removida";
  const available = smsAccounts.filter(
    (a) => a.id !== defaultAccountId && !options.some((o) => o.accountId === a.id),
  );

  const add = useMutation({
    mutationFn: (input: { tenantId: string; accountId: string; displayName: string }) =>
      addFn({ data: input }),
    onSuccess: (_result, input) => {
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
      toast.success(`Conta extra "${input.displayName}" adicionada.`);
      setAccountId("");
      setDisplayName("");
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: (input: { tenantId: string; accountId: string }) => removeFn({ data: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
      toast.success("Conta extra removida.");
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  async function confirmRemove(option: { accountId: string; displayName: string }) {
    if (!tenant) return;
    const ok = await requestConfirmation({
      title: `Remover "${option.displayName}"?`,
      description: `${tenant.nome} deixa de poder escolher esta conta nos envios de SMS. Campanhas agendadas, em andamento ou pausadas nesta conta impedem a remoção.`,
      confirmLabel: "Remover",
      destructive: true,
    });
    if (!ok) return;
    remove.mutate({ tenantId: tenant.id, accountId: option.accountId });
  }

  function close() {
    setAccountId("");
    setDisplayName("");
    onClose();
  }

  const trimmedName = displayName.trim();

  return (
    <Dialog open={tenant !== null} onOpenChange={(next) => !next && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Contas extras de SMS{tenant ? ` · ${tenant.nome}` : ""}</DialogTitle>
          <DialogDescription>
            Além da conta padrão, a casa pode escolher estas contas ao enviar SMS. Ela vê só o nome
            definido aqui, nunca o fornecedor.
          </DialogDescription>
        </DialogHeader>

        {options.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhuma conta extra.</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {options.map((option) => (
              <li
                key={option.accountId}
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{option.displayName}</p>
                  <p className="truncate text-meta text-muted-foreground">
                    {labelOf(option.accountId)}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remover ${option.displayName}`}
                  disabled={remove.isPending}
                  onClick={() => void confirmRemove(option)}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <form
          className="space-y-3 border-t border-border pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!tenant || !accountId || !trimmedName) return;
            add.mutate({ tenantId: tenant.id, accountId, displayName: trimmedName });
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="sms-option-account">Conta</Label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger id="sms-option-account">
                <SelectValue
                  placeholder={
                    available.length === 0 ? "Nenhuma conta disponível" : "Escolha a conta"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {available.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="sms-option-name">Nome que a casa vê</Label>
            <Input
              id="sms-option-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Ex.: Rota principal"
              maxLength={60}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Fechar
            </Button>
            <Button type="submit" disabled={add.isPending || !accountId || !trimmedName}>
              <Plus /> {add.isPending ? "Adicionando…" : "Adicionar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
