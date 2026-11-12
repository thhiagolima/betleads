// "Gateways de pagamento" (super admin, Admin → Faturamento): credentials of
// Upper and SpacePay (stored encrypted in the database, env vars as fallback)
// and which gateway receives NEW Pix charges. Existing charges always stay on
// the gateway that created them.
//
// Secrets are write-only: the screen only ever shows masked hints, and a blank
// secret field on save means "keep the stored one".
import { useId, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CreditCard, KeyRound, Plug, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  adminDeletePaymentGateway,
  adminListPaymentGateways,
  adminSavePaymentGateway,
  adminSetActivePixProvider,
  adminTestPaymentGateway,
} from "@/lib/billing/payment-gateway-admin.functions";

type PixProvider = "upper" | "spacepay";
type GatewaySource = "database" | "env" | "none";

export type PaymentGatewaysView = {
  activeProvider: PixProvider;
  activeSource: "database" | "env" | "default";
  gateways: Record<
    PixProvider,
    { source: GatewaySource; hints: Record<string, string>; updatedAt: string | null }
  >;
};

type TestResult = { ok: boolean; message: string };

export const PAYMENT_GATEWAYS_QUERY_KEY = ["admin", "billing", "payment-gateways"];
const PIX_FEES_QUERY_KEY = ["admin", "billing", "pix-fees"];

const PROVIDERS: PixProvider[] = ["upper", "spacepay"];

const PROVIDER_LABEL: Record<PixProvider, string> = { upper: "Upper", spacepay: "SpacePay" };

export const SOURCE_LABEL: Record<GatewaySource, string> = {
  database: "Banco",
  env: "Variável de ambiente",
  none: "Não configurado",
};

const HINT_LABEL: Record<string, string> = {
  apiKey: "API key",
  webhookSecret: "Segredo do webhook",
  apiBase: "URL da API",
  gatewayToken: "Token do gateway",
  casinoToken: "Token do cassino",
  callbackSecret: "Segredo do callback",
  payerName: "Pagador",
  payerDocument: "CPF/CNPJ do pagador",
  payerEmail: "E-mail do pagador",
  payerPhone: "Telefone do pagador",
};

const CALLBACK_SECRET_LENGTH = 48;
const SECRET_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** 48 crypto-random alphanumeric characters (rejection sampling, no modulo bias). */
export function generateCallbackSecret(length = CALLBACK_SECRET_LENGTH): string {
  const out: string[] = [];
  const limit = 256 - (256 % SECRET_ALPHABET.length);
  while (out.length < length) {
    const bytes = new Uint8Array(length * 2);
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b < limit && out.length < length) out.push(SECRET_ALPHABET[b % SECRET_ALPHABET.length]);
    }
  }
  return out.join("");
}

/** Public URL of this app (same env the server uses to build callback URLs). */
export function publicAppUrl(): string {
  const fromEnv = (import.meta.env.VITE_PUBLIC_APP_URL as string | undefined) ?? "";
  const base = fromEnv || (typeof window !== "undefined" ? window.location.origin : "");
  return base.replace(/\/+$/, "");
}

export type UpperForm = { apiKey: string; webhookSecret: string; apiBase: string };
export type SpacePayForm = {
  gatewayToken: string;
  casinoToken: string;
  callbackSecret: string;
  apiBase: string;
  payerName: string;
  payerDocument: string;
  payerEmail: string;
  payerPhone: string;
};

const EMPTY_UPPER: UpperForm = { apiKey: "", webhookSecret: "", apiBase: "" };
const EMPTY_SPACEPAY: SpacePayForm = {
  gatewayToken: "",
  casinoToken: "",
  callbackSecret: "",
  apiBase: "",
  payerName: "",
  payerDocument: "",
  payerEmail: "",
  payerPhone: "",
};

/** Form → server input. Blank fields go out blank ("manter o salvo"). */
export function upperPayload(form: UpperForm, clearFields: string[] = []) {
  return {
    provider: "upper" as const,
    credentials: { apiKey: form.apiKey, webhookSecret: form.webhookSecret, apiBase: form.apiBase },
    clearFields: clearFields.filter((f) => f === "webhookSecret" || f === "apiBase") as Array<
      "webhookSecret" | "apiBase"
    >,
  };
}

export function spacePayPayload(form: SpacePayForm, clearFields: string[] = []) {
  return {
    provider: "spacepay" as const,
    credentials: {
      gatewayToken: form.gatewayToken,
      casinoToken: form.casinoToken,
      callbackSecret: form.callbackSecret,
      apiBase: form.apiBase,
      payer: {
        name: form.payerName,
        document: form.payerDocument,
        email: form.payerEmail,
        phone: form.payerPhone,
      },
    },
    clearFields: clearFields.filter((f) => f === "casinoToken" || f === "apiBase") as Array<
      "casinoToken" | "apiBase"
    >,
  };
}

/** True when no field of the form was typed in. */
export function isBlank(form: Record<string, string>): boolean {
  return Object.values(form).every((v) => !v.trim());
}

function formatUpdatedAt(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function PaymentGatewaysCard() {
  const list = useServerFn(adminListPaymentGateways);
  const query = useQuery({
    queryKey: PAYMENT_GATEWAYS_QUERY_KEY,
    queryFn: () => list() as Promise<PaymentGatewaysView>,
  });
  const data = query.data as PaymentGatewaysView | undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CreditCard className="h-5 w-5 text-primary" />
          Gateways de pagamento
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Credenciais da Upper e da SpacePay e qual delas recebe as novas cobranças Pix. Cobranças já
          criadas continuam no gateway em que nasceram. Credenciais salvas aqui valem no lugar das
          variáveis de ambiente.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isLoading ? (
          <p className="text-sm text-muted-foreground">Carregando gateways…</p>
        ) : query.isError || !data ? (
          <p className="text-sm text-destructive">Não foi possível carregar os gateways.</p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {PROVIDERS.map((provider) => (
              <GatewayPanel
                key={provider}
                provider={provider}
                info={data.gateways[provider]}
                active={data.activeProvider === provider}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function GatewayPanel({
  provider,
  info,
  active,
}: {
  provider: PixProvider;
  info: PaymentGatewaysView["gateways"][PixProvider];
  active: boolean;
}) {
  const label = PROVIDER_LABEL[provider];
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<"activate" | "delete" | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: PAYMENT_GATEWAYS_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: PIX_FEES_QUERY_KEY });
  };

  const testFn = useServerFn(adminTestPaymentGateway);
  const testMut = useMutation({
    mutationFn: () => testFn({ data: { provider } }) as Promise<TestResult>,
    onSuccess: (r: TestResult) => setTestResult(r),
    onError: (e: Error) => setTestResult({ ok: false, message: e.message }),
  });

  const activateFn = useServerFn(adminSetActivePixProvider);
  const activateMut = useMutation({
    mutationFn: () => activateFn({ data: { provider } }),
    onSuccess: () => {
      toast.success(`Novas cobranças Pix agora vão para a ${label}.`);
      setConfirm(null);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteFn = useServerFn(adminDeletePaymentGateway);
  const deleteMut = useMutation({
    mutationFn: () => deleteFn({ data: { provider } }),
    onSuccess: () => {
      toast.success(`Credenciais da ${label} removidas do banco.`);
      setConfirm(null);
      setEditing(false);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const onSaved = () => {
    setEditing(false);
    setTestResult(null);
    refresh();
  };

  const hintEntries = Object.entries(info.hints);
  const updated = formatUpdatedAt(info.updatedAt);

  return (
    <div className="space-y-3 rounded-lg border p-4" data-gateway={provider}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{label}</span>
        {active && <Badge variant="default">Ativo</Badge>}
        <Badge variant={info.source === "none" ? "destructive" : "secondary"}>
          {SOURCE_LABEL[info.source]}
        </Badge>
      </div>

      {hintEntries.length > 0 ? (
        <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-sm">
          {hintEntries.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-muted-foreground">{HINT_LABEL[key] ?? key}</dt>
              <dd className="break-all font-mono text-xs leading-5">{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">Nenhuma credencial configurada.</p>
      )}
      {updated && <p className="text-xs text-muted-foreground">Atualizado em {updated}.</p>}

      <GatewayUrlNote provider={provider} />

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setEditing((v) => !v)}>
          <KeyRound className="mr-1 h-4 w-4" />
          {editing ? "Fechar edição" : "Editar credenciais"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={info.source === "none" || testMut.isPending}
          onClick={() => {
            setTestResult(null);
            testMut.mutate();
          }}
        >
          <Plug className="mr-1 h-4 w-4" />
          {testMut.isPending ? "Testando…" : "Testar conexão"}
        </Button>
        {!active && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={info.source === "none"}
            onClick={() => setConfirm("activate")}
          >
            <Star className="mr-1 h-4 w-4" />
            Usar para novas cobranças
          </Button>
        )}
        {info.source === "database" && (
          <Button type="button" variant="outline" size="sm" onClick={() => setConfirm("delete")}>
            <Trash2 className="mr-1 h-4 w-4" />
            Remover do banco
          </Button>
        )}
      </div>

      {testResult && <TestResultLine result={testResult} />}

      {confirm === "activate" && (
        <InlineConfirm
          text={`As novas cobranças Pix de todas as casas passam a ser geradas na ${label}. As cobranças já abertas continuam no gateway atual.`}
          confirmLabel={`Sim, usar a ${label}`}
          pending={activateMut.isPending}
          onConfirm={() => activateMut.mutate()}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm === "delete" && (
        <InlineConfirm
          text={`Apagar as credenciais da ${label} salvas no banco? Se houver variáveis de ambiente, elas voltam a valer.`}
          confirmLabel="Sim, remover"
          destructive
          pending={deleteMut.isPending}
          onConfirm={() => deleteMut.mutate()}
          onCancel={() => setConfirm(null)}
        />
      )}

      {editing &&
        (provider === "upper" ? (
          <UpperEditForm info={info} onSaved={onSaved} />
        ) : (
          <SpacePayEditForm info={info} onSaved={onSaved} />
        ))}
    </div>
  );
}

function GatewayUrlNote({ provider }: { provider: PixProvider }) {
  const base = publicAppUrl() || "https://seu-dominio";
  if (provider === "upper") {
    return (
      <p className="text-xs text-muted-foreground">
        Webhook a cadastrar na Upper:{" "}
        <code className="break-all rounded bg-muted px-1">{`${base}/api/public/upper/webhook`}</code>
      </p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      Não há webhook a cadastrar na SpacePay: cada cobrança leva a própria URL de callback,{" "}
      <code className="break-all rounded bg-muted px-1">{`${base}/api/public/spacepay/webhook/<token>`}</code>
      , assinada com o segredo do callback. Ao trocar o segredo, o anterior continua aceito por 24 h,
      então os Pix já emitidos seguem confirmando normalmente.
    </p>
  );
}

function TestResultLine({ result }: { result: TestResult }) {
  return (
    <p className={`text-sm ${result.ok ? "text-emerald-600" : "text-destructive"}`} role="status">
      {result.message}
    </p>
  );
}

function InlineConfirm({
  text,
  confirmLabel,
  destructive,
  pending,
  onConfirm,
  onCancel,
}: {
  text: string;
  confirmLabel: string;
  destructive?: boolean;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-2 rounded-md border border-dashed p-3" role="alert">
      <p className="text-sm">{text}</p>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant={destructive ? "destructive" : "default"}
          disabled={pending}
          onClick={onConfirm}
        >
          {pending ? "Aguarde…" : confirmLabel}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  secret,
  hint,
  placeholder,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  secret?: boolean;
  hint?: string;
  placeholder?: string;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input
          id={id}
          type={secret ? "password" : "text"}
          autoComplete={secret ? "new-password" : "off"}
          value={value}
          placeholder={hint ? `Salvo: ${hint} (vazio = manter)` : placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        {children}
      </div>
    </div>
  );
}

function ClearToggle({
  field,
  label,
  hints,
  clear,
  setClear,
}: {
  field: string;
  label: string;
  hints: Record<string, string>;
  clear: string[];
  setClear: (v: string[]) => void;
}) {
  if (!hints[field]) return null;
  const checked = clear.includes(field);
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) =>
          setClear(e.target.checked ? [...clear, field] : clear.filter((f) => f !== field))
        }
      />
      Apagar {label} salvo
    </label>
  );
}

function useSaveAndTest(onSaved: () => void) {
  const saveFn = useServerFn(adminSavePaymentGateway);
  const testFn = useServerFn(adminTestPaymentGateway);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const save = useMutation({
    mutationFn: (payload: unknown) => saveFn({ data: payload as never }),
    onSuccess: () => {
      toast.success("Credenciais salvas.");
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const test = useMutation({
    mutationFn: (payload: unknown) => testFn({ data: payload as never }) as Promise<TestResult>,
    onSuccess: (r: TestResult) => setTestResult(r),
    onError: (e: Error) => setTestResult({ ok: false, message: e.message }),
  });
  return { save, test, testResult, setTestResult };
}

function FormActions({
  saving,
  testing,
  onTest,
  onSave,
  testResult,
}: {
  saving: boolean;
  testing: boolean;
  onTest: () => void;
  onSave: () => void;
  testResult: TestResult | null;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" disabled={testing} onClick={onTest}>
          {testing ? "Testando…" : "Testar conexão"}
        </Button>
        <Button type="button" size="sm" disabled={saving} onClick={onSave}>
          {saving ? "Salvando…" : "Salvar"}
        </Button>
      </div>
      {testResult && <TestResultLine result={testResult} />}
    </div>
  );
}

function UpperEditForm({
  info,
  onSaved,
}: {
  info: PaymentGatewaysView["gateways"][PixProvider];
  onSaved: () => void;
}) {
  const stored = info.source === "database";
  const hints = stored ? info.hints : {};
  const [form, setForm] = useState<UpperForm>(EMPTY_UPPER);
  const [clear, setClear] = useState<string[]>([]);
  const { save, test, testResult, setTestResult } = useSaveAndTest(onSaved);
  const set = (key: keyof UpperForm) => (v: string) => setForm((f) => ({ ...f, [key]: v }));

  return (
    <div className="space-y-3 border-t pt-3">
      <EditIntro stored={stored} source={info.source} />
      <Field label="API key" secret value={form.apiKey} onChange={set("apiKey")} hint={hints.apiKey} />
      <Field
        label="Segredo do webhook (opcional)"
        secret
        value={form.webhookSecret}
        onChange={set("webhookSecret")}
        hint={hints.webhookSecret}
      />
      <ClearToggle field="webhookSecret" label="o segredo do webhook" hints={hints} clear={clear} setClear={setClear} />
      <Field
        label="URL da API (opcional)"
        value={form.apiBase}
        onChange={set("apiBase")}
        hint={hints.apiBase}
        placeholder="https://api.uppersc.com.br/v1"
      />
      <ClearToggle field="apiBase" label="a URL da API" hints={hints} clear={clear} setClear={setClear} />
      <FormActions
        saving={save.isPending}
        testing={test.isPending}
        testResult={testResult}
        onTest={() => {
          setTestResult(null);
          // Nothing typed: test what is configured today (banco ou ambiente).
          test.mutate(isBlank(form) ? { provider: "upper" } : upperPayload(form));
        }}
        onSave={() => save.mutate(upperPayload(form, clear))}
      />
    </div>
  );
}

function SpacePayEditForm({
  info,
  onSaved,
}: {
  info: PaymentGatewaysView["gateways"][PixProvider];
  onSaved: () => void;
}) {
  const stored = info.source === "database";
  const hints = stored ? info.hints : {};
  const [form, setForm] = useState<SpacePayForm>(EMPTY_SPACEPAY);
  const [clear, setClear] = useState<string[]>([]);
  const { save, test, testResult, setTestResult } = useSaveAndTest(onSaved);
  const set = (key: keyof SpacePayForm) => (v: string) => setForm((f) => ({ ...f, [key]: v }));

  return (
    <div className="space-y-3 border-t pt-3">
      <EditIntro stored={stored} source={info.source} />
      <Field
        label="Token do gateway"
        secret
        value={form.gatewayToken}
        onChange={set("gatewayToken")}
        hint={hints.gatewayToken}
      />
      <Field
        label="Token do cassino (opcional, usado nas consultas)"
        secret
        value={form.casinoToken}
        onChange={set("casinoToken")}
        hint={hints.casinoToken}
      />
      <ClearToggle field="casinoToken" label="o token do cassino" hints={hints} clear={clear} setClear={setClear} />
      <Field
        label="Segredo do callback (mín. 32 caracteres)"
        secret
        value={form.callbackSecret}
        onChange={set("callbackSecret")}
        hint={hints.callbackSecret}
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => set("callbackSecret")(generateCallbackSecret())}
        >
          Gerar
        </Button>
      </Field>
      <Field
        label="URL da API (opcional)"
        value={form.apiBase}
        onChange={set("apiBase")}
        hint={hints.apiBase}
        placeholder="https://integration.prod.spacedev.pro"
      />
      <ClearToggle field="apiBase" label="a URL da API" hints={hints} clear={clear} setClear={setClear} />
      <p className="text-xs text-muted-foreground">
        Pagador enviado em toda cobrança (dados da empresa, não das casas).
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nome do pagador" value={form.payerName} onChange={set("payerName")} hint={hints.payerName} />
        <Field
          label="CPF ou CNPJ do pagador"
          value={form.payerDocument}
          onChange={set("payerDocument")}
          hint={hints.payerDocument}
        />
        <Field
          label="E-mail do pagador"
          value={form.payerEmail}
          onChange={set("payerEmail")}
          hint={hints.payerEmail}
        />
        <Field
          label="Telefone do pagador (com DDD)"
          value={form.payerPhone}
          onChange={set("payerPhone")}
          hint={hints.payerPhone}
        />
      </div>
      <FormActions
        saving={save.isPending}
        testing={test.isPending}
        testResult={testResult}
        onTest={() => {
          setTestResult(null);
          test.mutate(isBlank(form) ? { provider: "spacepay" } : spacePayPayload(form));
        }}
        onSave={() => save.mutate(spacePayPayload(form, clear))}
      />
    </div>
  );
}

function EditIntro({ stored, source }: { stored: boolean; source: GatewaySource }) {
  return (
    <p className="text-xs text-muted-foreground">
      {stored
        ? "Campos em branco mantêm o valor salvo no banco."
        : source === "env"
          ? "Hoje valem as variáveis de ambiente. Ao salvar, preencha todos os campos obrigatórios: o banco passa a valer no lugar delas."
          : "Preencha os campos obrigatórios para configurar este gateway."}
    </p>
  );
}
