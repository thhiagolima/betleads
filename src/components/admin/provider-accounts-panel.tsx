// Admin → Integrações: provider accounts (SMS/e-mail/voz) and each house's
// account per channel. Super admin only; vendor names never reach a house.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { KeyRound, Pencil, Plug, Plus, Power } from "lucide-react";
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
  adminListProviderAccounts,
  adminSaveProviderAccount,
  adminSetProviderAccountStatus,
  adminSetTenantChannelProvider,
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

const QUERY_KEY = ["admin", "provider-accounts"] as const;
const PLATFORM = "platform";

type Provider = ProviderAccountView["provider"];

const CREDENTIAL_FIELDS: Record<Provider, Array<{ key: string; label: string }>> = {
  short_brasil: [
    { key: "shortcode_token", label: "Token da API Short Code" },
    { key: "usuario", label: "Usuário (API legada)" },
    { key: "chave", label: "Chave (API legada)" },
  ],
  infobip: [{ key: "api_key", label: "API key" }],
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
      key: "voice_from",
      label: "Número de origem das ligações (voz)",
      placeholder: "5511999990000",
    },
  ],
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function ProviderAccountsPanel() {
  const listFn = useServerFn(adminListProviderAccounts);
  const { data, isLoading } = useQuery({ queryKey: QUERY_KEY, queryFn: () => listFn() });
  const [editing, setEditing] = useState<ProviderAccountView | "new" | null>(null);

  return (
    <div className="space-y-4">
      <AccountsCard
        accounts={data?.accounts ?? []}
        loading={isLoading}
        onCreate={() => setEditing("new")}
        onEdit={setEditing}
      />
      <TenantProvidersCard
        accounts={data?.accounts ?? []}
        tenants={data?.tenants ?? []}
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

function AccountsCard({
  accounts,
  loading,
  onCreate,
  onEdit,
}: {
  accounts: ProviderAccountView[];
  loading: boolean;
  onCreate: () => void;
  onEdit: (account: ProviderAccountView) => void;
}) {
  const qc = useQueryClient();
  const statusFn = useServerFn(adminSetProviderAccountStatus);
  const testFn = useServerFn(adminTestProviderAccount);

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
            Contas da BetLeads que as casas podem usar. As duas contas padrão vêm das variáveis de
            ambiente do servidor.
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
              return (
                <TableRow key={account.id}>
                  <TableCell>
                    <div className="font-medium">{account.label}</div>
                    <div className="text-meta text-muted-foreground">
                      {PROVIDER_LABEL[account.provider]}
                      {account.platformDefault ? " · padrão da plataforma" : ""}
                    </div>
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
                    {Object.keys(account.credentialHints).length === 0 ? (
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
                    {account.platformDefault ? "todas sem conta própria" : houses || "—"}
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
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => runTest(account)}
                        disabled={test.isPending}
                      >
                        <Plug className="h-4 w-4" /> Testar
                      </Button>
                      {!account.platformDefault && (
                        <>
                          <Button variant="outline" size="sm" onClick={() => onEdit(account)}>
                            <Pencil className="h-4 w-4" /> Editar
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => toggle(account)}
                            disabled={status.isPending}
                          >
                            <Power className="h-4 w-4" />
                            {account.status === "active" ? "Desativar" : "Ativar"}
                          </Button>
                        </>
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
            As credenciais ficam cifradas no banco e nunca voltam para a tela. Deixe um campo em
            branco para manter o valor atual.
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
            {provider === "infobip" && (
              <p className="text-meta text-muted-foreground">
                SMS pela Infobip ainda não é suportado.
              </p>
            )}
          </div>

          {CONFIG_FIELDS[provider]
            .filter((field) => field.key !== "voice_from" || channels.includes("voice"))
            .map((field) => (
              <div key={field.key} className="space-y-1">
                <Label htmlFor={`cfg-${field.key}`}>{field.label}</Label>
                <Input
                  id={`cfg-${field.key}`}
                  value={config[field.key] ?? ""}
                  onChange={(e) => setConfig((prev) => ({ ...prev, [field.key]: e.target.value }))}
                  placeholder={field.placeholder}
                  className="font-mono text-meta"
                />
              </div>
            ))}

          {CREDENTIAL_FIELDS[provider].map((field) => (
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
          {provider === "short_brasil" && (
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

type TenantRow = {
  id: string;
  nome: string;
  accounts: Record<ProviderChannelName, string | null>;
};

function TenantProvidersCard({
  accounts,
  tenants,
  loading,
}: {
  accounts: ProviderAccountView[];
  tenants: TenantRow[];
  loading: boolean;
}) {
  const qc = useQueryClient();
  const setFn = useServerFn(adminSetTenantChannelProvider);
  const [search, setSearch] = useState("");

  const optionsByChannel = useMemo(() => {
    const out = {} as Record<ProviderChannelName, ProviderAccountView[]>;
    for (const channel of PROVIDER_CHANNELS) {
      out[channel] = accounts.filter(
        (a) =>
          !a.platformDefault &&
          a.status === "active" &&
          a.channels.includes(channel) &&
          SUPPORTED_CHANNELS[a.provider].includes(channel),
      );
    }
    return out;
  }, [accounts]);
  const labelOf = (id: string | null) =>
    id ? (accounts.find((a) => a.id === id)?.label ?? "conta removida") : "Padrão da plataforma";

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

  async function change(tenant: TenantRow, channel: ProviderChannelName, value: string) {
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
                <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                  Carregando…
                </TableCell>
              </TableRow>
            )}
            {visible.map((tenant) => (
              <TableRow key={tenant.id}>
                <TableCell className="font-medium">{tenant.nome}</TableCell>
                {PROVIDER_CHANNELS.map((channel) => {
                  const current = tenant.accounts[channel];
                  const options = optionsByChannel[channel];
                  // Keep a now-disabled current account visible in its own select.
                  const currentMissing = current && !options.some((a) => a.id === current);
                  return (
                    <TableCell key={channel} className="min-w-48">
                      <Select
                        value={current ?? PLATFORM}
                        onValueChange={(value) => void change(tenant, channel, value)}
                        disabled={assign.isPending}
                      >
                        <SelectTrigger className={current ? "border-primary/60" : undefined}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={PLATFORM}>Padrão da plataforma</SelectItem>
                          {currentMissing && (
                            <SelectItem value={current}>{labelOf(current)} (desativada)</SelectItem>
                          )}
                          {options.map((a) => (
                            <SelectItem key={a.id} value={a.id}>
                              {a.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
