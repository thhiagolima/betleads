// Web push (OneSignal) — Task 5: pure validators and constants shared by
// server and client code. No `.server` imports, no node-only APIs: this file
// is imported from client components.

export const WORKER_PATH = "/push/onesignal/OneSignalSDKWorker.js";
export const WORKER_FILE_CONTENT =
  'importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");\n';

const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function isIpLiteral(hostname: string): boolean {
  return IPV4_RE.test(hostname) || hostname.startsWith("[");
}

/**
 * Normalizes a house-provided origin: accepts with or without a scheme
 * (defaults to https), discards path/query/trailing slash, lowercases scheme
 * and host (keeping `www.` as typed), and refuses anything that is not a
 * reachable public https origin (http://, IP literals, localhost, a host
 * without a dot). Returns `https://host[:port]` or `null`.
 */
export function normalizeOrigin(input: string): string | null {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return null;

  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") return null;

  const hostname = url.hostname.toLowerCase();
  if (!hostname || hostname === "localhost") return null;
  if (isIpLiteral(hostname)) return null;
  if (!hostname.includes(".")) return null;

  const port = url.port ? `:${url.port}` : "";
  return `https://${hostname}${port}`;
}

export type PromptConfig = {
  promptText: string;
  acceptLabel: string;
  cancelLabel: string;
  iconUrl: string | null;
};

function requireLength(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") throw new Error(`${field} é obrigatório`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new Error(`${field} deve ter entre ${min} e ${max} caracteres`);
  }
  return trimmed;
}

function requireHttpsUrlOrNull(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^https:\/\//i.test(value)) {
    throw new Error(`${field} deve ser uma URL https`);
  }
  return value;
}

/**
 * Validates the push permission prompt copy: text 1-90 chars, button labels
 * 1-15 chars, an optional https icon. Throws `Error` with a pt-BR message.
 */
export function validatePromptConfig(input: {
  promptText: string;
  acceptLabel: string;
  cancelLabel: string;
  iconUrl?: string | null;
}): PromptConfig {
  const promptText = requireLength(input?.promptText, "O texto do prompt", 1, 90);
  const acceptLabel = requireLength(input?.acceptLabel, "O rótulo de aceitar", 1, 15);
  const cancelLabel = requireLength(input?.cancelLabel, "O rótulo de cancelar", 1, 15);
  const iconUrl = requireHttpsUrlOrNull(input?.iconUrl, "O ícone");

  return { promptText, acceptLabel, cancelLabel, iconUrl };
}

export type CampaignContent = {
  title: string;
  body: string;
  url: string;
  imageUrl: string | null;
};

/**
 * Validates push campaign content: title 1-64 chars, message 1-240 chars, a
 * required https link, an optional https image. Throws `Error` with a pt-BR
 * message.
 */
export function validateCampaignContent(input: {
  title: string;
  body: string;
  url: string;
  imageUrl?: string | null;
}): CampaignContent {
  const title = requireLength(input?.title, "O título", 1, 64);
  const body = requireLength(input?.body, "A mensagem", 1, 240);
  if (typeof input?.url !== "string" || !/^https:\/\//i.test(input.url)) {
    throw new Error("O link deve ser uma URL https");
  }
  const imageUrl = requireHttpsUrlOrNull(input?.imageUrl, "A imagem");

  return { title, body, url: input.url, imageUrl };
}

const GARBAGE_PLAYER_IDS = new Set(["", "undefined", "null", "0", "nan"]);

/**
 * Cleans a player id that came from the OneSignal SDK on the page: a
 * trimmed string of 1-128 chars that is not one of the known garbage values
 * (case-insensitive). Anything else (including non-string input) is `null`.
 */
export function cleanPlayerId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > 128) return null;
  if (GARBAGE_PLAYER_IDS.has(trimmed.toLowerCase())) return null;
  return trimmed;
}
