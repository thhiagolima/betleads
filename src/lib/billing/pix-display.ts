// Pure guards for rendering Upper's Pix checkout fields (`qrCodeImage`,
// `paymentUrl`) in the browser (fix round 1, Task 6 review). Both fields
// come straight from the Upper API response and are never validated by a
// schema before reaching the UI; without this guard a compromised/buggy
// Upper response (or a MITM on a misconfigured `UPPER_API_BASE`) could put
// a `javascript:`/`data:text/html` string into an `<img src>` or `<a href>`
// and have the browser execute it. No I/O — safe to unit test directly.

const ALLOWED_IMAGE_DATA_PREFIXES = ["data:image/png;base64,", "data:image/jpeg;base64,"];

/**
 * Only an inline PNG/JPEG data URI or an `https:` URL may be used as the
 * Pix QR `<img src>`. Anything else (including `http:`, `javascript:`, or a
 * `data:` URI of a different MIME type such as `text/html`) returns `null`
 * so the caller can skip rendering the image entirely.
 */
export function safePixImageSrc(src: string | null | undefined): string | null {
  if (!src) return null;
  if (ALLOWED_IMAGE_DATA_PREFIXES.some((prefix) => src.startsWith(prefix))) return src;
  return safeHttpsUrl(src);
}

/** Only an `https:` URL is accepted (e.g. the "Abrir página de pagamento" link). */
export function safeHttpsUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}
