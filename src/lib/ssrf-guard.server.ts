// Outbound request guard (SSRF). Server-only.
//
// Use before the server opens a connection to any address chosen by a user
// (webhook URLs, proxy hosts, ...). It refuses:
//   - non-https URLs (unless explicitly allowed), URLs with credentials;
//   - localhost / *.localhost / *.internal / *.local / single-label names and
//     the cloud metadata names;
//   - IP literals in any form the WHATWG URL parser accepts (decimal, hex,
//     octal, short "127.1", IPv6, IPv4-mapped IPv6) that fall in private,
//     loopback, link-local, CGNAT, multicast, documentation or reserved ranges;
//   - hostnames whose DNS answer contains ANY such address.
//
// Residual risk: DNS rebinding between this check and the connection made by
// fetch() (which resolves again). Callers that open raw sockets should
// connect to one of the addresses returned here instead of the hostname.

export class UnsafeOutboundUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeOutboundUrlError";
  }
}

export type LookupAddress = { address: string; family: number };
export type LookupFn = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<LookupAddress[]>;

export type SsrfGuardOptions = {
  /** Allow plain http:// URLs. Defaults to false (https only). */
  allowHttp?: boolean;
  /** DNS resolver; defaults to node:dns/promises lookup. Injected in tests. */
  lookup?: LookupFn;
};

// ---------------------------------------------------------------------------
// IPv4

type Cidr4 = [number, number]; // [network as uint32, prefix length]

function ip4(a: number, b: number, c: number, d: number) {
  return ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
}

const BLOCKED_V4: Cidr4[] = [
  [ip4(0, 0, 0, 0), 8], // "this" network
  [ip4(10, 0, 0, 0), 8], // private
  [ip4(100, 64, 0, 0), 10], // CGNAT
  [ip4(127, 0, 0, 0), 8], // loopback
  [ip4(169, 254, 0, 0), 16], // link-local (cloud metadata)
  [ip4(172, 16, 0, 0), 12], // private
  [ip4(192, 0, 0, 0), 24], // IETF protocol assignments
  [ip4(192, 0, 2, 0), 24], // TEST-NET-1
  [ip4(192, 88, 99, 0), 24], // 6to4 relay anycast
  [ip4(192, 168, 0, 0), 16], // private
  [ip4(198, 18, 0, 0), 15], // benchmarking
  [ip4(198, 51, 100, 0), 24], // TEST-NET-2
  [ip4(203, 0, 113, 0), 24], // TEST-NET-3
  [ip4(224, 0, 0, 0), 4], // multicast
  [ip4(240, 0, 0, 0), 4], // reserved + broadcast
];

function parseIpv4(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out >>> 0;
}

function isBlockedV4(addr: number): boolean {
  return BLOCKED_V4.some(([net, prefix]) => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return ((addr & mask) >>> 0) === ((net & mask) >>> 0);
  });
}

// ---------------------------------------------------------------------------
// IPv6

function parseIpv6(input: string): number[] | null {
  let value = input.trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);
  if (!value.includes(":")) return null;

  // Embedded dotted IPv4 tail (e.g. ::ffff:127.0.0.1) -> two hex groups.
  const lastColon = value.lastIndexOf(":");
  const maybeV4 = value.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = parseIpv4(maybeV4);
    if (v4 === null) return null;
    value = `${value.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }

  const doubleColon = value.split("::");
  if (doubleColon.length > 2) return null;
  const toGroups = (s: string) => (s === "" ? [] : s.split(":"));
  const hex = (g: string) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN);
  const head = toGroups(doubleColon[0]).map(hex);
  const rest = doubleColon.length === 2 ? toGroups(doubleColon[1]).map(hex) : [];
  if ([...head, ...rest].some(Number.isNaN)) return null;

  const explicit = head.length + rest.length;
  if (doubleColon.length === 1) return explicit === 8 ? head : null;
  if (explicit > 7) return null;
  return [...head, ...new Array<number>(8 - explicit).fill(0), ...rest];
}

function embeddedV4(groups: number[], from: number): number {
  return ((groups[from] << 16) >>> 0) + groups[from + 1];
}

function isBlockedV6(g: number[]): boolean {
  const allZeroUntil = (n: number) => g.slice(0, n).every((x) => x === 0);

  // :: and ::1
  if (allZeroUntil(7) && (g[7] === 0 || g[7] === 1)) return true;
  // IPv4-mapped ::ffff:a.b.c.d
  if (allZeroUntil(5) && g[5] === 0xffff) return isBlockedV4(embeddedV4(g, 6));
  // IPv4-compatible ::a.b.c.d (deprecated, never legitimate on the internet)
  if (allZeroUntil(6)) return true;
  // NAT64 64:ff9b::/96
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isBlockedV4(embeddedV4(g, 6));
  }
  // 6to4 2002::/16 embeds an IPv4 in groups 1-2
  if (g[0] === 0x2002) return isBlockedV4(embeddedV4(g, 1));
  // 100::/64 discard-only
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true;
  // 2001:db8::/32 documentation
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true;
  // fc00::/7 unique local
  if ((g[0] & 0xfe00) === 0xfc00) return true;
  // fe80::/10 link-local, fec0::/10 site-local (deprecated)
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true;
  // ff00::/8 multicast
  if ((g[0] & 0xff00) === 0xff00) return true;
  return false;
}

/**
 * True when `ip` (an IP literal) must not be contacted. Anything that is not
 * a parseable IP literal is treated as blocked (fail closed).
 */
export function isBlockedIp(ip: string): boolean {
  const value = (ip ?? "").trim();
  if (!value) return true;
  const v4 = parseIpv4(value);
  if (v4 !== null) return isBlockedV4(v4);
  const v6 = parseIpv6(value);
  if (v6 !== null) return isBlockedV6(v6);
  return true;
}

function isIpLiteral(host: string): boolean {
  return parseIpv4(host) !== null || parseIpv6(host) !== null;
}

// ---------------------------------------------------------------------------
// Hostnames

const BLOCKED_NAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
]);
const BLOCKED_SUFFIXES = [".localhost", ".internal", ".local", ".localdomain", ".home.arpa"];

export function isBlockedHostname(hostname: string): boolean {
  const host = (hostname ?? "").trim().toLowerCase().replace(/\.+$/, "");
  if (!host) return true;
  if (BLOCKED_NAMES.has(host)) return true;
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  // Single-label names resolve through the server's search domains (intranet).
  if (!host.includes(".") && !isIpLiteral(host)) return true;
  return false;
}

/**
 * Canonicalizes a raw host string the way fetch()/URL would interpret it, so
 * obfuscated IPv4 literals (2130706433, 0x7f000001, 0177.0.0.1, 127.1) become
 * dotted-quad before the checks run.
 */
function canonicalHost(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed || /[\s/?#@\\]/.test(trimmed)) {
    throw new UnsafeOutboundUrlError("Host de destino inválido");
  }
  const bracketed =
    trimmed.includes(":") && !trimmed.startsWith("[") ? `[${trimmed.replace(/%.*$/, "")}]` : trimmed;
  let hostname: string;
  try {
    hostname = new URL(`http://${bracketed}/`).hostname;
  } catch {
    throw new UnsafeOutboundUrlError("Host de destino inválido");
  }
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

async function defaultLookup(hostname: string): Promise<LookupAddress[]> {
  // Keep Node DNS out of client bundles (functions files are also analysed
  // during the browser build).
  const { lookup } = await import(/* @vite-ignore */ "node:dns/promises");
  return lookup(hostname, { all: true, verbatim: true });
}

/**
 * Validates a host (name or IP literal, no port) and returns the addresses the
 * caller may connect to. Throws UnsafeOutboundUrlError otherwise.
 */
export async function assertSafeOutboundHost(
  rawHost: string,
  options: Pick<SsrfGuardOptions, "lookup"> = {},
): Promise<string[]> {
  const host = canonicalHost(rawHost);
  if (isIpLiteral(host)) {
    if (isBlockedIp(host)) {
      throw new UnsafeOutboundUrlError("Destino aponta para um endereço interno ou reservado");
    }
    return [host];
  }
  if (isBlockedHostname(host)) {
    throw new UnsafeOutboundUrlError("Destino aponta para um endereço interno ou reservado");
  }
  let resolved: LookupAddress[];
  try {
    resolved = options.lookup
      ? await options.lookup(host, { all: true, verbatim: true })
      : await defaultLookup(host);
  } catch {
    throw new UnsafeOutboundUrlError("Não foi possível resolver o host de destino");
  }
  if (!resolved || resolved.length === 0) {
    throw new UnsafeOutboundUrlError("Não foi possível resolver o host de destino");
  }
  if (resolved.some(({ address }) => isBlockedIp(address))) {
    throw new UnsafeOutboundUrlError("Destino resolve para um endereço interno ou reservado");
  }
  return resolved.map(({ address }) => address);
}

/** Validates a full URL for an outbound request. */
export async function assertSafeOutboundUrl(
  raw: string,
  options: SsrfGuardOptions = {},
): Promise<{ url: URL; addresses: string[] }> {
  let url: URL;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    throw new UnsafeOutboundUrlError("URL de destino inválida");
  }
  const allowed = options.allowHttp ? ["https:", "http:"] : ["https:"];
  if (!allowed.includes(url.protocol)) {
    throw new UnsafeOutboundUrlError(
      options.allowHttp ? "A URL deve usar http(s)" : "A URL deve usar https://",
    );
  }
  if (url.username || url.password) {
    throw new UnsafeOutboundUrlError("A URL não pode conter usuário ou senha");
  }
  const addresses = await assertSafeOutboundHost(url.hostname, options);
  return { url, addresses };
}

/**
 * fetch() for user-chosen destinations: validates the URL first, never
 * follows redirects (a 3xx is returned as-is) and aborts after `timeoutMs`.
 */
export async function safeOutboundFetch(
  raw: string,
  init: RequestInit = {},
  options: SsrfGuardOptions & { timeoutMs?: number } = {},
): Promise<Response> {
  const { url } = await assertSafeOutboundUrl(raw, options);
  return fetch(url.toString(), {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
}
