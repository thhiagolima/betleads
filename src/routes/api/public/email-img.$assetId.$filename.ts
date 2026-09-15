// Proxy público para servir imagens de assets em e-mails.
//
// Por que existe: alguns clientes (Gmail) acessam imagens via proxy
// próprio. As URLs do app (`/__l5e/assets-v1/...`) servem cabeçalhos
// Set-Cookie e cookies de bot management do Cloudflare que podem,
// em alguns IPs do proxy do Gmail, atrasar/bloquear a imagem.
//
// Esta rota busca o asset original e devolve apenas os bytes da
// imagem com cabeçalhos limpos: sem Set-Cookie, sem CSP, com cache
// agressivo. Caminho público (`/api/public/*`) — não exige auth.

import { createFileRoute } from "@tanstack/react-router";

const ASSET_HOST = "https://betleads.io";
const ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
]);

export const Route = createFileRoute(
  "/api/public/email-img/$assetId/$filename",
)({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { assetId, filename } = params as {
          assetId: string;
          filename: string;
        };
        if (!/^[a-f0-9-]{8,64}$/i.test(assetId)) {
          return new Response("invalid asset id", { status: 400 });
        }
        const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
        const upstream = `${ASSET_HOST}/__l5e/assets-v1/${assetId}/${encodeURIComponent(safeName)}`;
        let res: Response;
        try {
          res = await fetch(upstream, {
            redirect: "follow",
            headers: { "User-Agent": "betleads-email-img-proxy/1.0" },
          });
        } catch (err) {
          console.error("email-img proxy fetch failed", {
            upstream,
            error: err instanceof Error ? err.message : String(err),
          });
          return new Response("upstream fetch failed", { status: 502 });
        }
        if (!res.ok || !res.body) {
          return new Response("upstream error", { status: res.status || 502 });
        }
        const ct = res.headers.get("content-type") || "application/octet-stream";
        if (!ALLOWED_TYPES.has(ct.split(";")[0].trim().toLowerCase())) {
          return new Response("unsupported media type", { status: 415 });
        }
        const headers = new Headers();
        headers.set("content-type", ct);
        const len = res.headers.get("content-length");
        if (len) headers.set("content-length", len);
        headers.set("cache-control", "public, max-age=31536000, immutable");
        headers.set("access-control-allow-origin", "*");
        headers.set("x-content-type-options", "nosniff");
        headers.set("referrer-policy", "no-referrer");
        return new Response(res.body, { status: 200, headers });
      },
    },
  },
});