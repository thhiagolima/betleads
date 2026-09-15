# Docker deployment

## Status atual

- O app gera build Nitro com preset `node-server`.
- A imagem Docker serve `.output/server/index.mjs` na porta `3000`.
- As migrations do Supabase ja foram aplicadas no projeto remoto.
- O usuario `thiago@businesscode.com.br` ja foi promovido a `super_admin` global e `owner` do tenant `betleads-original`.

## Variaveis obrigatorias

No `.env` da VPS, mantenha as variaveis abaixo:

```env
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_PUBLISHABLE_KEY=<anon-or-publishable-key>
SUPABASE_SECRET_KEY=<sb_secret_or_service_role_key>
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<same-public-key>
PUBLIC_APP_URL=https://crm.example.com
VITE_PUBLIC_APP_URL=https://crm.example.com
CRON_SECRET=<strong-random-secret>
EVOLUTION_API_URL=<evolution-base-url>
EVOLUTION_API_KEY=<evolution-api-key>
EVOLUTION_WEBHOOK_SECRET=<strong-random-webhook-secret>
```

Nunca crie variavel `VITE_` para `SUPABASE_SECRET_KEY`.

## Build local ou na VPS

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f crm
```

O healthcheck consulta `http://localhost:3000/` dentro do container.

## Nginx recomendado

```nginx
server {
  listen 80;
  server_name crm.example.com;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Depois aplique TLS com Certbot ou outro provedor.

## Checklist de validacao

1. `npm run build`
2. `npm audit --omit=dev`
3. `docker compose up -d --build`
4. Acessar `PUBLIC_APP_URL`.
5. Criar/sincronizar usuario no Supabase Auth.
6. Testar login com `thiago@businesscode.com.br`.
7. Validar uma rota autenticada do CRM.
8. Validar webhooks com `EVOLUTION_WEBHOOK_SECRET`, preferencialmente via header.
