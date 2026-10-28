// AES-GCM para credenciais de provedor guardadas em provider_accounts.
// Mesmo esquema de meta-token.server.ts, com chave própria.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function key(secret: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function providerSecret() {
  const secret = process.env.PROVIDER_CREDENTIALS_ENCRYPTION_KEY?.trim();
  if (!secret || secret.length < 32) {
    throw new Error(
      "Configure PROVIDER_CREDENTIALS_ENCRYPTION_KEY com pelo menos 32 caracteres para usar contas de provedor próprias.",
    );
  }
  return secret;
}

function encode(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64url");
}
function decode(value: string) {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

export async function encryptProviderCredentials(credentials: Record<string, string>) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await key(providerSecret()),
    encoder.encode(JSON.stringify(credentials)),
  );
  return `v1.${encode(iv)}.${encode(new Uint8Array(encrypted))}`;
}

export async function decryptProviderCredentials(value: string): Promise<Record<string, string>> {
  const [version, iv, encrypted] = value.split(".");
  if (version !== "v1" || !iv || !encrypted) {
    throw new Error("Credenciais de provedor em formato inválido.");
  }
  const clear = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decode(iv) },
    await key(providerSecret()),
    decode(encrypted),
  );
  const parsed: unknown = JSON.parse(decoder.decode(clear));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Credenciais de provedor em formato inválido.");
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
  return out;
}
