// Versão da Graph/Marketing API usada nas chamadas à Meta.
// Changelog: https://developers.facebook.com/docs/marketing-api/marketing-api-changelog
// v23.0 expirou em 09/06/2026 e v24.0 em 06/10/2026. Ao subir o piso, conferir
// a data de expiração da nova versão e anotar no doc de operação.
export const META_API_DEFAULT_VERSION = "v25.0";
export const META_API_MIN_VERSION = "v25.0";

function parseVersion(value: string) {
  const match = /^v(\d+)\.(\d+)$/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2])] : null;
}

function isOlder(a: number[], b: number[]) {
  return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
}

let warned: string | null = null;

/**
 * Uma versão configurada fora do formato ou abaixo do piso não é usada: a Meta
 * recusa chamadas em versões expiradas e o sync inteiro pararia.
 */
export function resolveMetaApiVersion(configured: string | undefined) {
  const value = configured?.trim();
  if (!value) return META_API_DEFAULT_VERSION;
  const parsed = parseVersion(value);
  const min = parseVersion(META_API_MIN_VERSION)!;
  if (!parsed || isOlder(parsed, min)) {
    if (warned !== value) {
      warned = value;
      console.warn(
        `[meta] META_API_VERSION=${value} é inválida ou expirada; usando ${META_API_DEFAULT_VERSION}.`,
      );
    }
    return META_API_DEFAULT_VERSION;
  }
  return value;
}
