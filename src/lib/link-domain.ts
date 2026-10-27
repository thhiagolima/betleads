// Pure helpers for swapping a house's hand-written-link domain (journeys/templates).
// No server imports: this module is client-safe, same as house-config.ts.

import { normalizeHostname } from "./house-config";

const URL_RE = /\bhttps?:\/\/([^\s/?#"'<>()]+)/gi;

function stripWww(host: string): string {
  return host.startsWith("www.") ? host.slice(4) : host;
}

/** Strips trailing characters that can't be part of a hostname/port (e.g. a
 * comma or period glued onto the URL by surrounding prose), so they stay
 * untouched in the output instead of being swallowed into the host match. */
function splitTrailingPunctuation(hostPort: string): { core: string; trailing: string } {
  let end = hostPort.length;
  while (end > 0 && !/[a-zA-Z0-9]/.test(hostPort[end - 1])) {
    end -= 1;
  }
  return { core: hostPort.slice(0, end), trailing: hostPort.slice(end) };
}

/** Splits a matched "host[:port]" fragment into its host and optional port. */
function splitHostPort(hostPort: string): { host: string; port: string } {
  const colonIndex = hostPort.lastIndexOf(":");
  if (colonIndex === -1) {
    return { host: hostPort, port: "" };
  }
  const maybePort = hostPort.slice(colonIndex + 1);
  if (!/^\d+$/.test(maybePort)) {
    return { host: hostPort, port: "" };
  }
  return { host: hostPort.slice(0, colonIndex), port: hostPort.slice(colonIndex) };
}

/** Normalizes a pasted domain/URL into a bare lower-case hostname without a
 * leading "www.", for use as `from`/`to` in `replaceLinkDomain`. */
export function normalizeLinkDomain(input: string): { ok: true; domain: string } | { ok: false; error: string } {
  const result = normalizeHostname(input);
  if (!result.ok) {
    return result;
  }
  return { ok: true, domain: stripWww(result.hostname) };
}

/** Replaces the host of every `http(s)://` URL in `text` whose host (ignoring
 * a leading "www.") exactly matches `from` with `to`, preserving scheme,
 * "www.", port, path, query and fragment. `from`/`to` must already be
 * normalized (lower-case, no "www."). Returns the rewritten text and how
 * many URLs were changed. */
export function replaceLinkDomain(text: string, from: string, to: string): { text: string; count: number } {
  let count = 0;
  const result = text.replace(URL_RE, (match, rawHostPort: string) => {
    const { core, trailing } = splitTrailingPunctuation(rawHostPort);
    const { host, port } = splitHostPort(core);
    const lowerHost = host.toLowerCase();
    const hasWww = lowerHost.startsWith("www.");
    const bareHost = hasWww ? lowerHost.slice(4) : lowerHost;
    if (bareHost !== from) {
      return match;
    }
    count += 1;
    const scheme = match.slice(0, match.length - rawHostPort.length);
    return `${scheme}${hasWww ? "www." : ""}${to}${port}${trailing}`;
  });
  return { text: result, count };
}

/** Counts `http(s)://` URLs in `text` whose host is a strict subdomain of
 * `from` (i.e. ends with `.${from}`), excluding the bare domain itself and
 * its "www." variant. */
export function countSubdomainLinks(text: string, from: string): number {
  let count = 0;
  const matches = text.matchAll(URL_RE);
  for (const match of matches) {
    const { core } = splitTrailingPunctuation(match[1]);
    const { host } = splitHostPort(core);
    const lowerHost = host.toLowerCase();
    const bareHost = lowerHost.startsWith("www.") ? lowerHost.slice(4) : lowerHost;
    if (bareHost !== from && bareHost.endsWith(`.${from}`)) {
      count += 1;
    }
  }
  return count;
}
