# Trocar domínio nos links — design

Data: 2026-10-27

## Intenção

Quando uma casa troca de domínio (ex.: `casa-antiga.com` → `casa-nova.com`), as
jornadas e os templates que têm a URL **escrita à mão** no texto continuam
mandando o player para o domínio antigo. Hoje não há nada que encontre ou
corrija isso: o admin precisaria abrir item por item.

As mensagens que usam `{link}` / `{link_<chave>}` já seguem `tenants.site_url`
sozinhas (`src/lib/template-vars.server.ts`) e não são o problema.

A ferramenta é **opcional**: as jornadas não passam a ser obrigadas a usar a URL
da casa. Ela só oferece, com confirmação, trocar o domínio antigo pelo novo
onde ele aparece escrito.

## Objetivos

- Ferramenta permanente, disponível em todas as casas, em "Configurar casa" →
  seção do site: **"Trocar domínio nos links"**.
- Duas entradas:
  1. **Manual:** o admin informa o domínio antigo (e o novo, pré-preenchido
     com o host de `site_url`). Cobre a casa que já trocou de domínio antes da
     ferramenta existir.
  2. **Automática:** ao salvar um `site_url` com host diferente do anterior, se
     o host antigo aparece em algum item, a ferramenta abre já preenchida com os
     dois domínios. Se não aparece em nada, nada abre.
- Antes de aplicar, mostra a **prévia**: quantos itens, quais (nome da jornada +
  etapa, nome do template), e um exemplo antes → depois por item. O admin pode
  desmarcar itens.
- Aplicação **atômica**: ou troca tudo o que foi marcado, ou nada.
- Registro em `tenant_audit_logs` (quem, quando, de → para, ids e contagem).

## Não-objetivos

- Não converte URLs escritas em `{link}` (mantém a URL escrita, só troca o
  host).
- Não trocar em todas as casas de uma vez. Cada execução vale para uma casa; o
  super admin usa casa a casa pelo seletor do topo.
- Não mexe em campanhas (enviadas ou agendadas) nem em fluxos SMS legados
  (`sms_flows` / `sms_flow_steps`).
- Não mexe em links de outros domínios (afiliado, Telegram etc.), nem em
  `{link}`.

## Anti-objetivos (seria falha mesmo funcionando)

- Trocar algo de outra casa (vazamento entre tenants — já aconteceu, ver
  `b5df3f9`).
- Casar domínio por substring: `casa.com` não pode atingir `minhacasa.com`,
  `casa.com.br` nem `casa.combo.net`.
- Deixar jornada/template pela metade.
- Mudar o comportamento de envio além do host do link (texto, variantes,
  ordem, rastreio).

## Quem pode usar

Qualquer admin da casa — mesmo guard de `saveHouseSite`: `requireHouseAdmin`
(`src/lib/house-config.functions.ts`, `requireTenantAdmin` + `assertTenantNotDemo`).
Super admin usa via seletor de casa (tenant atual), nunca cross-tenant.

## Onde procurar e trocar (por tenant)

| Origem | Campos |
|---|---|
| `journey_steps` (`step_type = 'sms'`) | `config.content`, `config.variants[]`, `config.template_snapshot.content` |
| `journey_steps` (`step_type = 'email'`) | `config.template_snapshot.subject`, `config.template_snapshot.body_html` |
| `sms_templates` | `content` |
| `email_templates` | `subject`, `preheader`, `body_html`, `body_text` |
| `tenant_quick_links` | `path` quando é URL absoluta (`http(s)://…`) — relativos já seguem `site_url` |
| `shortio_settings.allowed_destination_hosts` | adiciona o host novo (ver abaixo) |

Jornadas: status `draft`, `active`, `paused`. **Arquivadas ficam de fora**
(decisão minha — não enviam mais e alterá-las só poluiria o histórico).

Templates: todos os não arquivados da casa.

Escopo por tenant obrigatório em toda query (`journey_steps` via
`journeys.tenant_id`).

## Regra de casamento e troca

- Domínio de entrada: normalizado com `normalizeHostname`
  (`src/lib/house-config.ts`) — aceita URL colada, tira `www.`, minúsculas.
- Casa **somente URLs** `http(s)://` cujo host, sem `www.`, é **exatamente** o
  domínio antigo. Subdomínios (`m.casa-antiga.com`, `go.casa-antiga.com`) **não**
  são trocados (decisão minha: `go.` costuma ser o encurtador da casa em
  `tenant_domains`, e outros subdomínios podem apontar para serviços diferentes).
- Troca só o host; esquema, caminho, query e fragmento ficam. `www.` é
  preservado se estava no original (`www.casa-antiga.com/x` → `www.casa-nova.com/x`).
  Decisão minha; se o admin preferir sem `www.`, não faz parte desta versão.
- URL dentro de HTML (`href="..."`, texto visível) é tratada igual — a busca é
  textual sobre URLs, sem parser de HTML. Entidades HTML no meio da URL
  (`&amp;`) ficam intactas porque só o host muda.
- Uma função pura (ex.: `replaceLinkDomain(text, from, to) → { text, count }`)
  em módulo compartilhado, com testes de borda: substring de domínio, porta,
  maiúsculas, `www.`, URL no fim de frase com pontuação, várias URLs na mesma
  mensagem, `{link}` ao lado, domínio antigo sem esquema (não troca — só URLs
  com `http(s)://`).

## Jornadas ativas (decisão importante, minha)

`save_journey_draft` não edita jornada não-rascunho: cria uma revisão
(`revision_of`, "· revisão vN"). Se a ferramenta seguisse esse caminho, a casa
teria que publicar cada revisão e os enrollments em andamento continuariam no
domínio antigo.

Por isso a ferramenta **atualiza `journey_steps.config` no lugar**, inclusive em
jornadas ativas e pausadas, via service role numa única função SQL
transacional. Justificativa: a troca de host não muda a lógica da jornada
(mesmas etapas, mesmos ids, mesmo `step_id` nos enrollments); os envios
pendentes já saem com o domínio novo. O antes/depois de cada campo vai para
`tenant_audit_logs.before_data/after_data`, então dá para auditar e reverter
manualmente.

Templates: atualização normal; os triggers existentes sobem `version`
(`bump_sms_template_version`, `bump_email_template_version`). Os
`template_snapshot` das etapas são trocados pelo próprio fluxo (tabela acima),
sem re-snapshot; a `version` do snapshot não é alterada.

## Limites de tamanho

Domínio novo maior pode estourar limites: `sms_templates.content` ≤ 480,
`journey` SMS `content`/variantes ≤ 1600. A prévia calcula o novo tamanho; item
que estouraria aparece **desmarcado e bloqueado** com o motivo. Se o rastreio
de links estiver desligado na etapa (`track_links = false`), a prévia avisa
quando o texto passa a ocupar mais segmentos SMS (custo).

## Rastreio de cliques

Se `shortio_settings.allowed_destination_hosts` da casa não estiver vazia e
não contiver o domínio novo, `isShortioEligibleUrl`
(`src/lib/shortio.server.ts`) deixa de encurtar os links novos (e com
`fallback_mode = 'block'` o envio pode ser bloqueado). Isso vale também para
`{link}`, que passa a usar o domínio novo assim que `site_url` muda.

Regra (decisão minha): **adiciona** o domínio novo à lista, **mantém** o antigo.
Remover o antigo quebraria o encurtamento do que fica de fora da ferramenta
(subdomínios, campanhas agendadas, fluxos legados, itens desmarcados). Aparece
na prévia como um item a mais ("Domínios permitidos do rastreio"), marcado por
padrão, na mesma transação.

- Lista vazia → nada a fazer (vazia = tudo permitido).
- Lista não vazia sem o domínio novo → oferece adicionar, contenha ou não o
  antigo.
- Esse item sozinho já basta para a entrada automática abrir o diálogo.

## O que fica de fora, mas é mostrado

A prévia tem uma seção só de leitura, "Ainda com `casa-antiga.com` (não
trocados aqui)", com contagem e nomes de: campanhas SMS/e-mail **agendadas**
(ainda não enviadas), fluxos SMS legados **ativos**, e ocorrências em
**subdomínios** do domínio antigo nos itens do escopo. Jornadas arquivadas não
aparecem. Objetivo: o admin não sair achando que "trocou tudo". Decisão minha.

## Fluxo de tela

1. Seção do site em "Configurar casa" (`house-site-section.tsx`) ganha o botão
   "Trocar domínio nos links".
2. Diálogo, passo 1: campos "Domínio antigo" e "Domínio novo" (pré-preenchido
   com o host de `site_url`) → "Procurar". Validação: os dois válidos e
   diferentes.
3. Passo 2: prévia agrupada (Jornadas / Templates de SMS / Templates de e-mail /
   Rastreio), checkbox por item, exemplo antes → depois com o host destacado,
   itens bloqueados com motivo. Vazio → "Nenhum link com `casa-antiga.com`
   encontrado".
4. "Trocar N itens" → confirmação → toast com o resultado.
5. Entrada automática: depois que `saveHouseSite` salva um host diferente, a UI
   chama a prévia com (host antigo → host novo); se houver ≥ 1 item, abre o
   diálogo direto no passo 2.

## Servidor

- `previewLinkDomainChange({ fromDomain, toDomain })` — server fn, só leitura,
  retorna itens com id, tipo, nome, campos afetados, contagem de trocas,
  exemplo, tamanho novo e bloqueio.
- `applyLinkDomainChange({ fromDomain, toDomain, items: ids[] })` — recalcula
  no servidor (nunca confia em texto vindo do cliente), chama uma RPC
  transacional que aplica as atualizações e grava o audit log. Se algum item
  mudou entre a prévia e a aplicação, recalcula; se agora estourar limite, falha
  a operação inteira com mensagem clara.
- `saveHouseSite` passa a retornar também o host anterior, para a entrada
  automática. Aproveitar para limpar o cache de `loadHouseLinks`
  (`src/lib/house-links.server.ts`, TTL 60 s) do tenant ao salvar, e também
  depois de `applyLinkDomainChange` (links rápidos mudam).
- `assertTenantNotDemo` vale (casa demo não altera).

## Fica a critério de quem implementar

- Organização dos componentes do diálogo e do agrupamento da prévia.
- Paginação/limite da prévia (casas têm dezenas de jornadas, não milhares).
- Se a RPC recebe o texto final calculado pelo servidor Node ou faz a troca em
  SQL — desde que a regra de casamento seja uma só e testada.
- Nome exato do `action` no audit log (sugestão: `house.link_domain_changed`).

## Verificação

- Testes unitários da função de troca (bordas acima).
- Teste de banco: escopo por tenant (outra casa com o mesmo domínio não é
  tocada), atomicidade, jornada ativa atualizada no lugar sem criar revisão,
  `version` dos templates sobe, audit log gravado.
- `npm run build` antes do merge (pega vazamento de `*.server` no bundle).
