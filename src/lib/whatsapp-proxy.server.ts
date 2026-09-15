import net from "net";

export type ProxyTarget = {
  protocol: string;
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
};

/**
 * Stage do teste — usado para mensagens precisas na UI.
 * tcp: falha já no connect TCP
 * protocol: handshake do protocolo (greeting/version) falhou
 * auth: usuário/senha rejeitados
 * connect: proxy aceitou auth mas recusou abrir túnel até o destino
 * ok: handshake completo + CONNECT aceito
 */
export type ProxyTestStage = "tcp" | "protocol" | "auth" | "connect" | "ok";

export type ProxyTestResult = {
  ok: boolean;
  stage: ProxyTestStage;
  error?: string;
};

const TEST_TARGET_HOST = "api.ipify.org";
const TEST_TARGET_PORT = 443;
const HANDSHAKE_TIMEOUT_MS = 8000;

/**
 * Faz handshake real do protocolo + autenticação + CONNECT até um host externo.
 * Garante que credenciais e tipo de proxy estão corretos antes de vincular.
 */
export async function testProxyHandshake(
  target: ProxyTarget,
): Promise<ProxyTestResult> {
  const proto = (target.protocol || "").toLowerCase();
  switch (proto) {
    case "socks5":
      return testSocks5(target);
    case "socks4":
      return testSocks4(target);
    case "http":
    case "https":
      return testHttpConnect(target);
    default:
      return { ok: false, stage: "protocol", error: `Protocolo não suportado: ${target.protocol}` };
  }
}

function openSocket(
  target: ProxyTarget,
): Promise<
  | { ok: true; socket: net.Socket }
  | { ok: false; error: string }
> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (
      r: { ok: true; socket: net.Socket } | { ok: false; error: string },
    ) => {
      if (settled) return;
      settled = true;
      if (!r.ok) {
        try { socket.destroy(); } catch {}
      }
      resolve(r);
    };
    socket.setTimeout(HANDSHAKE_TIMEOUT_MS);
    socket.once("connect", () => {
      socket.setTimeout(HANDSHAKE_TIMEOUT_MS);
      done({ ok: true, socket });
    });
    socket.once("timeout", () => done({ ok: false, error: "Timeout TCP ao conectar no proxy" }));
    socket.once("error", (err) => done({ ok: false, error: err.message }));
    try {
      socket.connect(target.port, target.host);
    } catch (err: any) {
      done({ ok: false, error: err?.message ?? "Erro ao iniciar conexão" });
    }
  });
}

/** Lê do socket até `predicate(buf)` retornar um número > 0 (bytes a consumir) ou erro. */
function readUntil(
  socket: net.Socket,
  predicate: (buf: Buffer) => { done: boolean; error?: string },
): Promise<{ ok: true; data: Buffer } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let settled = false;
    const done = (r: { ok: true; data: Buffer } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
      socket.off("close", onClose);
      resolve(r);
    };
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const r = predicate(buf);
      if (r.error) return done({ ok: false, error: r.error });
      if (r.done) return done({ ok: true, data: buf });
    };
    const onError = (err: Error) => done({ ok: false, error: err.message });
    const onTimeout = () => done({ ok: false, error: "Timeout aguardando resposta do proxy" });
    const onClose = () => done({ ok: false, error: "Proxy fechou a conexão" });
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("timeout", onTimeout);
    socket.on("close", onClose);
  });
}

async function testSocks5(target: ProxyTarget): Promise<ProxyTestResult> {
  const tcp = await openSocket(target);
  if (!tcp.ok) return { ok: false, stage: "tcp", error: tcp.error };
  const socket = tcp.socket;
  try {
    const hasAuth = Boolean(target.username);
    // Greeting: oferece "no auth" (0x00) e, se temos credencial, user/pass (0x02)
    const methods = hasAuth ? [0x00, 0x02] : [0x00];
    socket.write(Buffer.from([0x05, methods.length, ...methods]));

    const greet = await readUntil(socket, (b) =>
      b.length >= 2 ? { done: true } : { done: false },
    );
    if (!greet.ok) return { ok: false, stage: "protocol", error: greet.error };
    if (greet.data[0] !== 0x05)
      return { ok: false, stage: "protocol", error: `Resposta não é SOCKS5 (byte=${greet.data[0]})` };
    const method = greet.data[1];
    if (method === 0xff)
      return { ok: false, stage: "auth", error: "Proxy não aceitou nenhum método de autenticação oferecido" };

    if (method === 0x02) {
      if (!hasAuth)
        return { ok: false, stage: "auth", error: "Proxy exige user/senha mas nenhum foi fornecido" };
      const u = Buffer.from(target.username ?? "", "utf8");
      const p = Buffer.from(target.password ?? "", "utf8");
      if (u.length > 255 || p.length > 255)
        return { ok: false, stage: "auth", error: "Usuário/senha excedem 255 bytes" };
      socket.write(Buffer.concat([
        Buffer.from([0x01, u.length]), u,
        Buffer.from([p.length]), p,
      ]));
      const authRes = await readUntil(socket, (b) =>
        b.length >= 2 ? { done: true } : { done: false },
      );
      if (!authRes.ok) return { ok: false, stage: "auth", error: authRes.error };
      if (authRes.data[1] !== 0x00)
        return { ok: false, stage: "auth", error: "Usuário ou senha inválidos" };
    } else if (method !== 0x00) {
      return { ok: false, stage: "auth", error: `Método de auth não suportado (0x${method.toString(16)})` };
    }

    // CONNECT api.ipify.org:443
    const host = Buffer.from(TEST_TARGET_HOST, "utf8");
    const req = Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
      host,
      Buffer.from([(TEST_TARGET_PORT >> 8) & 0xff, TEST_TARGET_PORT & 0xff]),
    ]);
    socket.write(req);
    const rep = await readUntil(socket, (b) =>
      b.length >= 10 ? { done: true } : { done: false },
    );
    if (!rep.ok) return { ok: false, stage: "connect", error: rep.error };
    const code = rep.data[1];
    if (code !== 0x00) {
      const map: Record<number, string> = {
        0x01: "Falha geral no proxy",
        0x02: "Conexão proibida pela regra do proxy",
        0x03: "Rede inalcançável",
        0x04: "Host inalcançável",
        0x05: "Conexão recusada pelo destino",
        0x06: "TTL expirado",
        0x07: "Comando não suportado",
        0x08: "Tipo de endereço não suportado",
      };
      return { ok: false, stage: "connect", error: map[code] ?? `CONNECT recusado (0x${code.toString(16)})` };
    }
    return { ok: true, stage: "ok" };
  } finally {
    try { socket.destroy(); } catch {}
  }
}

async function testSocks4(target: ProxyTarget): Promise<ProxyTestResult> {
  const tcp = await openSocket(target);
  if (!tcp.ok) return { ok: false, stage: "tcp", error: tcp.error };
  const socket = tcp.socket;
  try {
    // SOCKS4a: IP 0.0.0.x + hostname após USERID. Resolve no proxy.
    const userid = Buffer.from(target.username ?? "", "utf8");
    const host = Buffer.from(TEST_TARGET_HOST, "utf8");
    const req = Buffer.concat([
      Buffer.from([
        0x04, 0x01,
        (TEST_TARGET_PORT >> 8) & 0xff, TEST_TARGET_PORT & 0xff,
        0x00, 0x00, 0x00, 0x01,
      ]),
      userid,
      Buffer.from([0x00]),
      host,
      Buffer.from([0x00]),
    ]);
    socket.write(req);
    const rep = await readUntil(socket, (b) =>
      b.length >= 8 ? { done: true } : { done: false },
    );
    if (!rep.ok) return { ok: false, stage: "connect", error: rep.error };
    const code = rep.data[1];
    if (code === 0x5a) return { ok: true, stage: "ok" };
    const map: Record<number, string> = {
      0x5b: "CONNECT rejeitado pelo proxy",
      0x5c: "Identd não acessível",
      0x5d: "USERID rejeitado",
    };
    return { ok: false, stage: "connect", error: map[code] ?? `Resposta SOCKS4 inesperada (0x${code.toString(16)})` };
  } finally {
    try { socket.destroy(); } catch {}
  }
}

async function testHttpConnect(target: ProxyTarget): Promise<ProxyTestResult> {
  const tcp = await openSocket(target);
  if (!tcp.ok) return { ok: false, stage: "tcp", error: tcp.error };
  const socket = tcp.socket;
  try {
    const lines = [`CONNECT ${TEST_TARGET_HOST}:${TEST_TARGET_PORT} HTTP/1.1`, `Host: ${TEST_TARGET_HOST}:${TEST_TARGET_PORT}`];
    if (target.username) {
      const token = Buffer.from(`${target.username}:${target.password ?? ""}`, "utf8").toString("base64");
      lines.push(`Proxy-Authorization: Basic ${token}`);
    }
    lines.push("Proxy-Connection: keep-alive", "", "");
    socket.write(lines.join("\r\n"));
    const rep = await readUntil(socket, (b) => {
      const s = b.toString("utf8");
      if (s.includes("\r\n\r\n")) return { done: true };
      return { done: false };
    });
    if (!rep.ok) return { ok: false, stage: "protocol", error: rep.error };
    const statusLine = rep.data.toString("utf8").split("\r\n", 1)[0] ?? "";
    const m = statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})/);
    if (!m) return { ok: false, stage: "protocol", error: `Resposta HTTP inválida: ${statusLine.slice(0, 80)}` };
    const status = Number(m[1]);
    if (status === 200) return { ok: true, stage: "ok" };
    if (status === 407) return { ok: false, stage: "auth", error: "Usuário ou senha inválidos (HTTP 407)" };
    if (status === 403) return { ok: false, stage: "connect", error: "Proxy proibiu o destino (HTTP 403)" };
    if (status === 502 || status === 504)
      return { ok: false, stage: "connect", error: `Proxy não alcançou o destino (HTTP ${status})` };
    return { ok: false, stage: "connect", error: `CONNECT recusado (HTTP ${status})` };
  } finally {
    try { socket.destroy(); } catch {}
  }
}

/**
 * Monta o payload de proxy para a Evolution API v2 (POST /proxy/set/{instance}).
 */
export function buildEvolutionProxyPayload(proxy: ProxyTarget | null) {
  if (!proxy) return { enabled: false };
  return {
    enabled: true,
    host: proxy.host,
    port: String(proxy.port),
    protocol: proxy.protocol,
    username: proxy.username || "",
    password: proxy.password || "",
  };
}