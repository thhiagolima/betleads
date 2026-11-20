/**
 * QA-30 — isolamento dos testes (roda antes de CADA arquivo de teste, via
 * `test.setupFiles` no vite.config.ts).
 *
 * 1. Apaga variáveis sensíveis do process.env. A causa raiz (o plugin de env do
 *    TanStack Start copiando o .env inteiro) já é tratada no vite.config.ts; isto
 *    é a segunda barreira, inclusive para segredos exportados no shell de quem
 *    roda os testes. Teste que precisa de um valor deve defini-lo explicitamente
 *    (valor falso) no próprio arquivo — isso roda depois deste setup.
 * 2. Bloqueia rede real: `globalThis.fetch` vira uma função que rejeita com
 *    "network blocked in tests". `vi.stubGlobal("fetch", ...)`, atribuição direta
 *    e `vi.spyOn(globalThis, "fetch").mockResolvedValue(...)` continuam
 *    funcionando, e `vi.unstubAllGlobals()` volta para o bloqueio (não para o
 *    fetch real). Como roda antes de qualquer import do teste, clientes que
 *    capturam `fetch` na criação (supabase-js) também pegam o bloqueio.
 */

const SENSITIVE_ENV_PATTERNS: RegExp[] = [
  /^SUPABASE_/,
  /^VITE_SUPABASE_/,
  /^INFOBIP_/,
  /^SHORT_BRASIL_/,
  /^SHORTIO_/,
  /^META_/,
  /^ONESIGNAL_/,
  /^OPENAI/,
  /^ANTHROPIC/,
  /^SENTRY_/,
  /^UPPER_/,
  /^PAGANO/,
  /^SPACEPAY/,
  /^RESEND_/,
  /^TWILIO_/,
  /^AWS_/,
  /^PG(HOST|USER|PASSWORD|DATABASE|PORT)$/,
  /DATABASE/,
  /DB_URL/,
  /SECRET/,
  /PASSWORD/,
  /_KEY$/,
  /_KEYS$/,
  /_TOKEN$/,
  /^CRON_SECRET$/,
];

for (const key of Object.keys(process.env)) {
  if (SENSITIVE_ENV_PATTERNS.some((re) => re.test(key))) {
    delete process.env[key];
  }
}

export const NETWORK_BLOCKED_MESSAGE = "network blocked in tests";

function describeTarget(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === "object" && "url" in input) {
    return String((input as { url: unknown }).url);
  }
  return String(input);
}

const blockedFetch: typeof fetch = (input) =>
  Promise.reject(
    new Error(
      `${NETWORK_BLOCKED_MESSAGE}: ${describeTarget(input)} — mocke o fetch (vi.stubGlobal) ou o módulo que faz a chamada`,
    ),
  );

// Writable/configurable so vi.stubGlobal / vi.spyOn / direct assignment keep working.
Object.defineProperty(globalThis, "fetch", {
  value: blockedFetch,
  writable: true,
  configurable: true,
  enumerable: true,
});
