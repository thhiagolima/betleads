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

// ESC is part of the GSM-7 alphabet extension marker.
// eslint-disable-next-line no-control-regex
const GSM7_BASIC = /^[\r\n @£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞ\u001bÆæßÉ!"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/;
const GSM7_EXTENSION = new Set(["^", "{", "}", "\\", "[", "~", "]", "|", "€"]);

export type SmsEstimate = { encoding: "GSM-7" | "UCS-2"; characters: number; units: number; parts: number; credits: number };

export function estimateSms(value: string): SmsEstimate {
  const encoding = GSM7_BASIC.test(value) ? "GSM-7" : "UCS-2";
  const characters = Array.from(value).length;
  const units = encoding === "GSM-7" ? Array.from(value).reduce((n, c) => n + (GSM7_EXTENSION.has(c) ? 2 : 1), 0) : characters;
  const single = encoding === "GSM-7" ? 160 : 70;
  const concatenated = encoding === "GSM-7" ? 153 : 67;
  const parts = units === 0 ? 0 : units <= single ? 1 : Math.ceil(units / concatenated);
  return { encoding, characters, units, parts, credits: parts };
}
