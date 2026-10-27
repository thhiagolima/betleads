/**
 * Readable text of an HTML email body for a card preview: drops <head>,
 * <style>/<script>, tags and entities, and collapses whitespace.
 */
export function emailPreviewText(html: string | null | undefined, max = 180): string {
  if (!html) return "";
  const text = html
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!doctype[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#?\w+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
