const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function key(secret: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function dedicatedSecret() {
  const secret = process.env.META_TOKEN_ENCRYPTION_KEY?.trim();
  if (!secret || secret.length < 32) {
    throw new Error(
      "Configure META_TOKEN_ENCRYPTION_KEY com pelo menos 32 caracteres antes de conectar uma conta Meta.",
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

export async function encryptMetaToken(token: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await key(dedicatedSecret()),
    encoder.encode(token),
  );
  return `v2.primary.${encode(iv)}.${encode(new Uint8Array(encrypted))}`;
}

export async function decryptMetaToken(value: string) {
  const parts = value.split(".");
  let secret: string;
  let iv: string | undefined;
  let encrypted: string | undefined;

  if (parts[0] === "v2") {
    [, , iv, encrypted] = parts;
    secret = dedicatedSecret();
  } else if (parts[0] === "v1") {
    [, iv, encrypted] = parts;
    secret = process.env.SUPABASE_SECRET_KEY?.trim() ?? "";
    if (!secret) throw new Error("Chave legada do token Meta não está configurada.");
  } else {
    throw new Error("Token Meta protegido em formato inválido.");
  }

  if (!iv || !encrypted) throw new Error("Token Meta protegido em formato inválido.");
  const clear = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decode(iv) },
    await key(secret),
    decode(encrypted),
  );
  return decoder.decode(clear);
}

export function metaTokenHint(token: string) {
  return token.length <= 8 ? "••••" : `${token.slice(0, 4)}••••${token.slice(-4)}`;
}
