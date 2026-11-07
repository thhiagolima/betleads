// Conta própria de provedor por casa — Task 13: o assistente de cadastro,
// ativação, teste e ativação. Ordem fixa (brief): provedor -> credenciais
// (+ remetente + custo por SMS, só no canal sms) -> webhook -> testar ->
// ativar (com senha). Short Brasil de conta própria nunca mostra campo de
// URL (endpoints sempre padrão, spec 6.2/global-constraints). Nenhuma
// credencial volta preenchida do servidor: o hint "Salvo — preencha só
// para substituir" é a única pista (nomes, nunca valores). Cada etapa é um
// componente puro (sem estado), recebendo tudo por props, para ser
// renderizável direto em teste com `renderToStaticMarkup` — este repo não
// tem @testing-library/react nem jsdom (ver webpush-setup-wizard.tsx).
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Copy } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { brl } from "@/lib/format";
import { cn } from "@/lib/utils";
import { tourAnchor } from "@/help/anchor";
import {
  activateOwnProvider,
  saveOwnProviderAccount,
  testOwnProviderAccount,
} from "@/lib/own-provider.functions";
import {
  OWN_PROVIDER_CHANNEL_LABEL,
  OWN_PROVIDER_LABEL,
  OWN_PROVIDERS_BY_CHANNEL,
  type OwnProvider,
  type OwnProviderChannel,
} from "@/lib/own-provider.shared";
import type { OwnAccountView, OwnProviderChannelState } from "@/lib/own-provider.server";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Passos do assistente

export type WizardStep = "provedor" | "credenciais" | "webhook" | "testar" | "ativar";

export const WIZARD_STEPS: WizardStep[] = ["provedor", "credenciais", "webhook", "testar", "ativar"];

export const WIZARD_STEP_LABELS: Record<WizardStep, string> = {
  provedor: "Provedor",
  credenciais: "Credenciais",
  webhook: "Webhook",
  testar: "Testar",
  ativar: "Ativar",
};

/** Etapa inicial: uma conta já cadastrada pula direto para o webhook (as
 * credenciais já estão salvas). */
export function initialWizardStep(account: OwnAccountView | null): WizardStep {
  return account ? "webhook" : "provedor";
}

export function nextStep(step: WizardStep): WizardStep {
  const i = WIZARD_STEPS.indexOf(step);
  return WIZARD_STEPS[Math.min(i + 1, WIZARD_STEPS.length - 1)];
}

export function previousStep(step: WizardStep): WizardStep {
  const i = WIZARD_STEPS.indexOf(step);
  return WIZARD_STEPS[Math.max(i - 1, 0)];
}

// ---------------------------------------------------------------------------
// Campos de credencial/config por provedor (restrito: nada de OneSignal nem
// de URL para Short Brasil de conta própria).

export const OWN_CREDENTIAL_FIELDS: Record<OwnProvider, Array<{ key: string; label: string }>> = {
  short_brasil: [
    { key: "shortcode_token", label: "Token da API Short Code" },
    { key: "usuario", label: "Usuário (API legada)" },
    { key: "chave", label: "Chave (API legada)" },
  ],
  infobip: [{ key: "api_key", label: "API key" }],
};

/** Campos de configuração (URL base + remetente): só a Infobip tem — Short
 * Brasil de conta própria usa sempre os endereços padrão. */
export function ownConfigFields(
  provider: OwnProvider,
  channel: OwnProviderChannel,
): Array<{ key: string; label: string; placeholder: string }> {
  if (provider !== "infobip") return [];
  const fields = [{ key: "base_url", label: "URL base", placeholder: "https://xxxx.api.infobip.com" }];
  if (channel === "sms") {
    fields.push({ key: "sms_from", label: "Remetente", placeholder: "Número ou nome aprovado" });
  }
  if (channel === "voice") {
    fields.push({ key: "voice_from", label: "Remetente", placeholder: "5511999990000" });
  }
  return fields;
}

/** "Salvo — preencha só para substituir" quando o nome da credencial já foi
 * gravado; o valor em si nunca volta do servidor. */
export function credentialHint(key: string, credentialsSet: string[]): string | undefined {
  return credentialsSet.includes(key) ? "Salvo — preencha só para substituir" : undefined;
}

// ---------------------------------------------------------------------------
// Webhook

export type WebhookStepContent = { url: string | null; note: string | null };

/** Short Brasil: URL própria (com botão copiar) a configurar no painel do
 * provedor. Infobip: nenhuma URL para configurar — vai em cada envio. */
export function webhookStepContent(
  provider: OwnProvider,
  callbackUrl: string | null,
): WebhookStepContent {
  if (provider === "infobip") {
    return { url: null, note: "A URL vai automaticamente em cada envio." };
  }
  return { url: callbackUrl, note: null };
}

// ---------------------------------------------------------------------------
// Confirmação de ativação

/** Lista exata (brief) mostrada antes de confirmar a ativação. */
export function ownProviderActivationMessages(
  channel: OwnProviderChannel,
  monthlyFeeCents: number,
): string[] {
  const messages = [
    "Sem troca automática: se sua conta falhar, os envios deste canal pausam.",
    `A BetLeads deixa de cobrar por envio neste canal; a taxa mensal de ${brl(
      monthlyFeeCents / 100,
    )} entra na próxima fatura.`,
  ];
  if (channel === "email") {
    messages.push("Seus domínios de e-mail voltam a pendente e precisam dos novos registros DNS.");
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Custo por unidade (só SMS): texto livre -> número ou undefined (mantém) ou
// null (inválido).

export function parseOwnUnitCostInput(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed.replace(",", "."));
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export const CLIPBOARD_ERROR_MESSAGE =
  "Não foi possível copiar. Selecione o texto e copie manualmente.";

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

// ---------------------------------------------------------------------------
// Indicador de etapas

export function StepIndicator({ step }: { step: WizardStep }) {
  return (
    <nav aria-label="Etapas do assistente" className="flex flex-wrap items-center gap-2">
      {WIZARD_STEPS.map((s) => (
        <span
          key={s}
          className={cn(
            "rounded-full px-3 py-1 text-xs font-semibold",
            s === step ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
          )}
        >
          {WIZARD_STEP_LABELS[s]}
        </span>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Etapa 1 — Provedor

export function ProviderStepView({
  channel,
  providers,
  provider,
  label,
  lockProvider,
  onProviderChange,
  onLabelChange,
  onNext,
}: {
  channel: OwnProviderChannel;
  providers: readonly OwnProvider[];
  provider: OwnProvider;
  label: string;
  lockProvider: boolean;
  onProviderChange: (provider: OwnProvider) => void;
  onLabelChange: (label: string) => void;
  onNext: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label>Provedor</Label>
        <Select value={provider} onValueChange={(v) => onProviderChange(v as OwnProvider)} disabled={lockProvider}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {providers.map((p) => (
              <SelectItem key={p} value={p}>
                {OWN_PROVIDER_LABEL[p]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="own-provider-label">Nome da conta</Label>
        <Input
          id="own-provider-label"
          value={label}
          onChange={(e) => onLabelChange(e.target.value)}
          placeholder={`Ex.: ${OWN_PROVIDER_CHANNEL_LABEL[channel]} da casa`}
        />
      </div>
      <Button type="button" onClick={onNext} disabled={!label.trim()}>
        Continuar
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Etapa 2 — Credenciais / remetente / custo (SMS) / senha

export function CredentialsStepView({
  channel,
  provider,
  config,
  credentials,
  credentialsSet,
  ownUnitCost,
  password,
  saving,
  onConfigChange,
  onCredentialsChange,
  onOwnUnitCostChange,
  onPasswordChange,
  onSubmit,
}: {
  channel: OwnProviderChannel;
  provider: OwnProvider;
  config: Record<string, string>;
  credentials: Record<string, string>;
  credentialsSet: string[];
  ownUnitCost: string;
  password: string;
  saving: boolean;
  onConfigChange: (key: string, value: string) => void;
  onCredentialsChange: (key: string, value: string) => void;
  onOwnUnitCostChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {ownConfigFields(provider, channel).map((field) => (
        <div key={field.key} className="space-y-1">
          <Label htmlFor={`own-cfg-${field.key}`}>{field.label}</Label>
          <Input
            id={`own-cfg-${field.key}`}
            value={config[field.key] ?? ""}
            onChange={(e) => onConfigChange(field.key, e.target.value)}
            placeholder={field.placeholder}
            className="font-mono text-meta"
          />
        </div>
      ))}
      {OWN_CREDENTIAL_FIELDS[provider].map((field) => (
        <div key={field.key} className="space-y-1">
          <Label htmlFor={`own-cred-${field.key}`}>{field.label}</Label>
          <Input
            id={`own-cred-${field.key}`}
            type="password"
            autoComplete="off"
            value={credentials[field.key] ?? ""}
            onChange={(e) => onCredentialsChange(field.key, e.target.value)}
            placeholder={credentialHint(field.key, credentialsSet)}
            className="font-mono text-meta"
          />
        </div>
      ))}
      {channel === "sms" && (
        <div className="space-y-1">
          <Label htmlFor="own-unit-cost">Custo por SMS na sua conta (R$)</Label>
          <Input
            id="own-unit-cost"
            value={ownUnitCost}
            onChange={(e) => onOwnUnitCostChange(e.target.value)}
            placeholder="0,00"
            className="font-mono text-meta"
          />
        </div>
      )}
      <div className="space-y-1">
        <Label htmlFor="own-save-password">Sua senha</Label>
        <Input
          id="own-save-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => onPasswordChange(e.target.value)}
          required
        />
      </div>
      <Button type="submit" disabled={saving || !password}>
        {saving ? "Salvando…" : "Salvar e continuar"}
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Etapa 3 — Webhook

export function WebhookStepView({
  provider,
  callbackUrl,
  onNext,
}: {
  provider: OwnProvider;
  callbackUrl: string | null;
  onNext: () => void;
}) {
  const webhook = webhookStepContent(provider, callbackUrl);
  return (
    <div className="space-y-4" {...tourAnchor("webhooks.canais.webhook")}>
      {webhook.url && (
        <div className="space-y-1.5">
          <Label>URL do webhook</Label>
          <div className="flex gap-2">
            <Input value={webhook.url} readOnly className="font-mono text-meta" />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => copyToClipboard(webhook.url as string, "URL copiada")}
            >
              <Copy className="h-3.5 w-3.5" /> Copiar
            </Button>
          </div>
        </div>
      )}
      {webhook.note && <p className="text-sm text-muted-foreground">{webhook.note}</p>}
      <Button type="button" onClick={onNext}>
        Continuar
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Etapa 4 — Testar

export function TestStepView({
  provider,
  testPhone,
  testing,
  onTestPhoneChange,
  onTest,
  onNext,
}: {
  provider: OwnProvider;
  testPhone: string;
  testing: boolean;
  onTestPhoneChange: (value: string) => void;
  onTest: () => void;
  onNext: () => void;
}) {
  return (
    <div className="space-y-4">
      {provider === "short_brasil" && (
        <div className="space-y-1">
          <Label htmlFor="own-test-phone">Celular que recebe o teste</Label>
          <Input
            id="own-test-phone"
            value={testPhone}
            onChange={(e) => onTestPhoneChange(e.target.value)}
            placeholder="(11) 99999-0000"
          />
        </div>
      )}
      <Button type="button" onClick={onTest} disabled={testing}>
        {testing ? "Testando…" : "Testar"}
      </Button>
      <div>
        <Button type="button" variant="outline" onClick={onNext}>
          Continuar
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Etapa 5 — Ativar

export function ActivateStepView({
  channel,
  monthlyFeeCents,
  password,
  activating,
  onPasswordChange,
  onSubmit,
}: {
  channel: OwnProviderChannel;
  monthlyFeeCents: number;
  password: string;
  activating: boolean;
  onPasswordChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        {ownProviderActivationMessages(channel, monthlyFeeCents).map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
      <div className="space-y-1">
        <Label htmlFor="own-activate-password">Sua senha</Label>
        <Input
          id="own-activate-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => onPasswordChange(e.target.value)}
          required
        />
      </div>
      <Button type="submit" disabled={activating || !password}>
        {activating ? "Ativando…" : "Ativar"}
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// O assistente, de ponta a ponta (contêiner com estado)

export function OwnProviderWizard({
  state,
  onDone,
}: {
  state: OwnProviderChannelState;
  onDone: () => void;
}) {
  const { channel, account, monthlyFeeCents, callbackUrl } = state;
  const providers = OWN_PROVIDERS_BY_CHANNEL[channel];

  const [step, setStep] = useState<WizardStep>(initialWizardStep(account));
  const [provider, setProvider] = useState<OwnProvider>(account?.provider ?? providers[0]);
  const [label, setLabel] = useState(account?.label ?? "");
  const [config, setConfig] = useState<Record<string, string>>({
    base_url: account?.baseUrl ?? "",
    sms_from: account?.smsFrom ?? "",
    voice_from: account?.voiceFrom ?? "",
  });
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [ownUnitCost, setOwnUnitCost] = useState(
    account?.ownUnitCost != null ? String(account.ownUnitCost) : "",
  );
  const [savePassword, setSavePassword] = useState("");
  const [activatePassword, setActivatePassword] = useState("");
  const [testPhone, setTestPhone] = useState("");

  const saveFn = useServerFn(saveOwnProviderAccount);
  const testFn = useServerFn(testOwnProviderAccount);
  const activateFn = useServerFn(activateOwnProvider);

  const save = useMutation({
    mutationFn: () => {
      const cost = channel === "sms" ? parseOwnUnitCostInput(ownUnitCost) : undefined;
      return saveFn({
        data: {
          channel,
          provider,
          label,
          config: provider === "short_brasil" ? {} : config,
          credentials,
          ownUnitCost: cost === null ? undefined : cost,
          password: savePassword,
        },
      });
    },
    onSuccess: () => {
      toast.success("Conta salva");
      setSavePassword("");
      setCredentials({});
      setStep("webhook");
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const test = useMutation({
    mutationFn: () =>
      testFn({ data: { channel, phone: provider === "short_brasil" ? testPhone : undefined } }),
    onSuccess: (result: { ok: boolean; message: string }) =>
      result.ok ? toast.success(result.message) : toast.error(result.message),
    onError: (error) => toast.error(errorMessage(error)),
  });

  const activate = useMutation({
    mutationFn: () => activateFn({ data: { channel, password: activatePassword } }),
    onSuccess: () => {
      toast.success("Conta própria ativada");
      setActivatePassword("");
      onDone();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <div className="space-y-5">
      <StepIndicator step={step} />

      {step === "provedor" && (
        <ProviderStepView
          channel={channel}
          providers={providers}
          provider={provider}
          label={label}
          lockProvider={Boolean(account)}
          onProviderChange={setProvider}
          onLabelChange={setLabel}
          onNext={() => setStep("credenciais")}
        />
      )}

      {step === "credenciais" && (
        <CredentialsStepView
          channel={channel}
          provider={provider}
          config={config}
          credentials={credentials}
          credentialsSet={account?.credentialsSet ?? []}
          ownUnitCost={ownUnitCost}
          password={savePassword}
          saving={save.isPending}
          onConfigChange={(key, value) => setConfig((prev) => ({ ...prev, [key]: value }))}
          onCredentialsChange={(key, value) =>
            setCredentials((prev) => ({ ...prev, [key]: value }))
          }
          onOwnUnitCostChange={setOwnUnitCost}
          onPasswordChange={setSavePassword}
          onSubmit={() => save.mutate()}
        />
      )}

      {step === "webhook" && (
        <WebhookStepView
          provider={provider}
          callbackUrl={callbackUrl}
          onNext={() => setStep("testar")}
        />
      )}

      {step === "testar" && (
        <TestStepView
          provider={provider}
          testPhone={testPhone}
          testing={test.isPending}
          onTestPhoneChange={setTestPhone}
          onTest={() => test.mutate()}
          onNext={() => setStep("ativar")}
        />
      )}

      {step === "ativar" && (
        <ActivateStepView
          channel={channel}
          monthlyFeeCents={monthlyFeeCents}
          password={activatePassword}
          activating={activate.isPending}
          onPasswordChange={setActivatePassword}
          onSubmit={() => activate.mutate()}
        />
      )}
    </div>
  );
}
