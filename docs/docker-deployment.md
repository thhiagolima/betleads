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
JOURNEYS_DISPATCH_ENABLED=false
JOURNEYS_SCANNER_ENABLED=false
JOURNEYS_SCANNER_JOB_LIMIT=3
JOURNEYS_SCANNER_BATCH_SIZE=500
JOURNEYS_DISPATCH_BATCH_SIZE=5
EVOLUTION_API_URL=<evolution-base-url>
EVOLUTION_API_KEY=<evolution-api-key>
EVOLUTION_WEBHOOK_SECRET=<strong-random-webhook-secret>
```

Nunca crie variavel `VITE_` para `SUPABASE_SECRET_KEY`.

## Ativacao do dispatcher de jornadas

O `docker-compose.yml` carrega as variaveis de runtime pelo arquivo `.env` no
mesmo diretorio do compose. `JOURNEYS_DISPATCH_ENABLED` e um kill switch do
servidor: publicar ou ativar uma jornada nao altera essa variavel.

O scanner de elegibilidade possui uma flag independente:

- `JOURNEYS_SCANNER_ENABLED=true`: descobre elegiveis e cria inscricoes; nao envia;
- `JOURNEYS_DISPATCH_ENABLED=true`: processa inscricoes vencidas e chama provedores;
- `JOURNEYS_SCANNER_JOB_LIMIT` e `JOURNEYS_SCANNER_BATCH_SIZE`: controlam o canario;
- `JOURNEYS_DISPATCH_BATCH_SIZE`: controla quantos envios podem ser reivindicados por tick.

Na VPS, a partir do diretorio que contem `docker-compose.yml`, defina:

```env
JOURNEYS_SCANNER_ENABLED=true
JOURNEYS_DISPATCH_ENABLED=false
```

Primeiro libere somente o scanner e confirme que as contagens/cursor avancam
sem erro. Depois do canario autorizado, altere `JOURNEYS_DISPATCH_ENABLED=true`
e recrie novamente o container para liberar os envios.

Nao use prefixo `VITE_`: a flag e exclusivamente server-side. Um simples
`docker compose restart` nao recarrega o `env_file`; recrie o container:

```bash
docker compose up -d --build --force-recreate crm
docker compose exec crm node -e "console.log(process.env.JOURNEYS_DISPATCH_ENABLED)"
docker compose ps
docker compose logs --since=10m crm
```

O segundo comando deve imprimir `true`. O cron `betleads-dispatch-journey`
chama `/api/public/hooks/dispatch?channel=journey` a cada minuto. Uma resposta
com `disabled: true` significa que o container ainda nao recebeu a flag.

### Ativacao segura

Alterar a flag para `true` permite envios reais de todas as jornadas ativas.
Antes de habilitar em uma base com backlog:

1. confirme credencial e saldo do provedor, consentimento e janela de envio;
2. mantenha somente um tenant/jornada piloto ativo ou aplique limites de canario;
3. valide um destinatario autorizado e a idempotencia do envio;
4. acompanhe fila vencida, taxa de erro, latencia e resposta do provedor;
5. amplie o throughput gradualmente.

Rollback operacional: volte a flag para `false` e recrie o container. Isso
interrompe novas reivindicacoes e preserva inscricoes, execucoes e auditoria.
A evolucao completa do processamento esta definida em
[`ESCOPO_FILA_ASSINCRONA_JORNADAS_2026-10-14.md`](./ESCOPO_FILA_ASSINCRONA_JORNADAS_2026-10-14.md).

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
