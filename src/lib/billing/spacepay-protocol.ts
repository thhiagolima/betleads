// SpacePay protocol details not in their docs, shared by the server client
// (spacepay-pix.server.ts) and the admin connection test. No imports.
//
// X-Platform-Id: required on every request. Its value comes from SpacePay's
// /create_gateway_token; until we know whether it is the issued token itself
// or a separate field, the configured platformId wins and, when blank, the
// gateway token is sent.
//
// Error bodies, as really returned by the API (not the documented
// {statusCode,timestamp,path,message,detail} shape):
//   {"success":false,"message":"Requisição inválida","data":{"errors":["..."]}}
// Only the first data.errors entry is ever surfaced, sanitized and capped, so
// a response body never leaks whole into last_error, logs or the admin UI.

/** X-Platform-Id value: the configured platformId, else the gateway token itself (null when neither). */
export function effectivePlatformId(
  config: { platformId?: string | null; gatewayToken?: string | null } | null | undefined,
): string | null {
  return config?.platformId?.trim() || config?.gatewayToken?.trim() || null;
}

export const SPACEPAY_ERROR_MAX_CHARS = 160;

/** Collapses whitespace/control chars, redacts the given secrets, caps the length. */
export function sanitizeSpacePayErrorText(
  text: string,
  secrets: Array<string | null | undefined> = [],
): string | null {
  // eslint-disable-next-line no-control-regex
  let out = text.replace(/[\u0000-\u001f\u007f]+/g, " ");
  for (const secret of secrets) {
    const s = secret?.trim();
    if (s && s.length >= 4) out = out.split(s).join("••••");
  }
  out = out.replace(/\s+/g, " ").trim();
  if (!out) return null;
  return out.length > SPACEPAY_ERROR_MAX_CHARS
    ? `${out.slice(0, SPACEPAY_ERROR_MAX_CHARS - 1)}…`
    : out;
}

/** Every string in body.data.errors (empty when the shape doesn't match). */
export function spacePayErrorList(body: unknown): string[] {
  if (typeof body !== "object" || body === null) return [];
  const data = (body as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return [];
  const errors = (data as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return [];
  return errors.filter((e): e is string => typeof e === "string" && e.trim() !== "");
}

/** First data.errors entry, sanitized (≤160 chars), or null. */
export function firstSpacePayError(
  body: unknown,
  secrets: Array<string | null | undefined> = [],
): string | null {
  const first = spacePayErrorList(body)[0];
  return first ? sanitizeSpacePayErrorText(first, secrets) : null;
}

/** A 404 caused by an unknown X-Platform-Id (not a missing transaction). */
export function isSpacePayPlatformNotFound(status: number, body: unknown): boolean {
  return status === 404 && spacePayErrorList(body).some((e) => /platform\s*-?\s*id/i.test(e));
}
