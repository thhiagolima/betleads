const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function key() {
  const secret = process.env.META_TOKEN_ENCRYPTION_KEY ?? process.env.SUPABASE_SECRET_KEY;
  if (!secret) throw new Error("Chave de proteção dos tokens Meta não configurada.");
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function encode(bytes: Uint8Array) { return Buffer.from(bytes).toString("base64url"); }
function decode(value: string) { return new Uint8Array(Buffer.from(value, "base64url")); }

export async function encryptMetaToken(token: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), encoder.encode(token));
  return `v1.${encode(iv)}.${encode(new Uint8Array(encrypted))}`;
}

export async function decryptMetaToken(value: string) {
  const [version, iv, encrypted] = value.split(".");
  if (version !== "v1" || !iv || !encrypted) throw new Error("Token Meta protegido em formato inválido.");
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(iv) }, await key(), decode(encrypted));
  return decoder.decode(clear);
}

export function metaTokenHint(token: string) {
  return token.length <= 8 ? "••••" : `${token.slice(0, 4)}••••${token.slice(-4)}`;
}
