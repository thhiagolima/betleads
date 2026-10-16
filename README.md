# Betleads CRM

CRM multi-tenant para casas de apostas. Cada casa envia por webhook os eventos dos jogadores (cadastro, login, depósito, saque). O Betleads mantém a base de jogadores e dispara campanhas e jornadas automáticas por SMS, e-mail e voz, com controle de consentimento, janela de envio e limites de frequência. Também rastreia cliques e atribui depósitos às mensagens. A Central de Resultados mostra recuperação, redepósito, custo e funil por casa.

Fluxo principal: casa → webhook → `webhook_logs` → processamento → `players`/`deposits` → pg_cron chama `/api/public/hooks/*` → scanner e dispatcher de jornadas → provedores → callbacks e cliques → atribuição → Central de Resultados.

## Stack

- **App:** TanStack Start (React 19, TanStack Router e Query), Vite 7, Tailwind 4, shadcn/Radix. Server functions em `src/lib/*.functions.ts` e código de servidor em `src/lib/*.server.ts`.
- **Runtime:** Nitro com preset `node-server`, Node 22, Docker. Sentry carregado por `instrument.mjs`.
- **Banco:** Supabase (Postgres com RLS por tenant, Auth, pg_cron, pg_net, Vault). Migrations em `supabase/migrations/`; edge function em `supabase/functions/`.
- **Provedores:** Short Brasil (SMS), Infobip (e-mail e voz), ElevenLabs (voz), Short.io (links), Meta (anúncios), Evolution (WhatsApp, fora dos canais homologados).
- **Rotas públicas:** `src/routes/api/public/**` (webhooks, clique first-party, ticks de cron, health).

## Rodar localmente

Requisitos: Node 22 e npm 11 (o lockfile é gerado pelo npm 11; o CI e o Dockerfile usam `npm@11.19.0`).

```bash
npm install -g npm@11.19.0
npm ci
cp .env.example .env   # preencha as variáveis (ver abaixo)
npm run dev            # servidor de desenvolvimento (Vite)
```

Variáveis: `.env.example` lista os nomes. O mínimo para subir a aplicação é `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `PUBLIC_APP_URL`, `VITE_PUBLIC_APP_URL` e `CRON_SECRET`. Nunca crie variável `VITE_` para chave secreta. Os workers de jornada ficam desligados por padrão (`JOURNEYS_DISPATCH_ENABLED=false`, `JOURNEYS_SCANNER_ENABLED=false`); não os ligue apontando para o banco de produção.

> Ainda não existe ambiente de homologação (F2-02). Qualquer `.env` com as chaves do Supabase atual aponta para **produção**. Escrita em produção exige aprovação explícita (ver Regras de contribuição).

Outros scripts do `package.json`:

| Comando | O que faz |
|---|---|
| `npm run build` | Build de produção em `.output/` |
| `npm run start` | Sobe o build com `.env` e Sentry (`node --env-file=.env --import ./instrument.mjs .output/server/index.mjs`) |
| `npm run preview` | Preview do build pelo Vite |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run format` | Prettier (reescreve os arquivos) |

No Windows, `scripts/run-local-server.ps1` carrega o `.env` e sobe o build já gerado em `127.0.0.1:3000`.

## Testes

```bash
npm test                                   # vitest run (todos os *.test.ts)
npx vitest run src/lib/journey-p0-rules.db.test.ts   # um arquivo
```

- Testes unitários ficam ao lado do código (`src/**/*.test.ts`).
- Os testes `*.db.test.ts` sobem um Postgres em memória com **PGlite** (`@electric-sql/pglite`) e executam o SQL das migrations de `supabase/migrations/`. Não precisam de banco externo nem de `.env`.
- Matrizes de acesso RLS (também em PGlite), executadas a partir da raiz: `node supabase/tests/rls/con08-matrix.mjs` e `node supabase/tests/rls/sec01-matrix.mjs`. Ainda não rodam no CI (F2-06).

## CI

`.github/workflows/quality.yml` roda em push e em pull request para `main`: `npm ci`, `npm run lint`, `npm run typecheck`, `npm test` e `npm run build`, com Node 22 e npm 11.19.0.

## Deploy

Imagem Docker (`Dockerfile`, `docker-compose.yml`) publicada num VPS atrás de nginx. Passo a passo, variáveis e ativação segura do dispatcher de jornadas: [docs/docker-deployment.md](docs/docker-deployment.md). Observabilidade: [docs/RUNBOOK_OBSERVABILIDADE.md](docs/RUNBOOK_OBSERVABILIDADE.md).

Ainda não há imagem com tag de versão, runbook de rollback nem migrations pelo CI. Isso está previsto em F2-03 e F2-05.

## Documentação

Comece por [docs/INDEX.md](docs/INDEX.md). O índice lista todos os documentos com tipo, data e status (vigente, superado, encerrado ou obsoleto). O status de execução do projeto fica num lugar só: a seção 8 de [docs/ESCOPO_CORRECOES_AUDITORIA_2026-10-16.md](docs/ESCOPO_CORRECOES_AUDITORIA_2026-10-16.md).

A pasta `docs/` é versionada. Material com segredo, credencial ou dado pessoal vai para `docs/private/`, que o git ignora.

## Regras de contribuição

Resumo das regras de execução do [ESCOPO_CORRECOES_AUDITORIA_2026-10-16.md](docs/ESCOPO_CORRECOES_AUDITORIA_2026-10-16.md):

1. **Uma branch e um PR por item** (ou grupo pequeno), com CI verde antes do merge. A `main` será protegida (F2-01).
2. **Segurança e envio entram com teste**: o teste falha antes da correção e passa depois.
3. **Escrita em produção** (dados, configuração ou migration) só com aprovação explícita, plano de rollback e registro em `docs/operacoes/AAAA-MM-DD_<tema>.md`.
4. **Status num lugar só**: a tabela da seção 8 do escopo de correções, com o hash do commit e a evidência de cada item.
5. **Deploy só em horário comercial.** Jornadas novas ou alteradas passam pelo checklist de publicação (F3-05).
6. Nenhuma funcionalidade nova entra até as Fases 0 e 1 estarem aceitas. Código pronto não significa entregue: o item só fecha com a evidência pedida no critério de aceite, registrada no PR.

Convenções: commits no padrão Conventional Commits (`feat:`, `fix:`, `docs:`...), com `user.name` e `user.email` configurados. Nunca commite `.env`, tokens, exportações de jogadores ou outros dados pessoais.
