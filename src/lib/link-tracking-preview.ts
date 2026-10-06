const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;

export const LINK_TRACKING_PREVIEW_URL = "bmkt.click/abc123";

export function messageUrls(value: string) {
  return Array.from(value.matchAll(URL_PATTERN), (match) => match[0]);
}

/**
 * Uses a deterministic placeholder only in the editor. Real Short.io links are
 * created at dispatch time, per recipient, so drafts never create orphan links.
 */
export function previewTrackedText(value: string, enabled: boolean) {
  if (!enabled) return value;
  return value.replace(URL_PATTERN, LINK_TRACKING_PREVIEW_URL);
}

export function smsPartsForLength(length: number) {
  if (!length) return 0;
  return length <= 160 ? 1 : Math.ceil(length / 153);
}
