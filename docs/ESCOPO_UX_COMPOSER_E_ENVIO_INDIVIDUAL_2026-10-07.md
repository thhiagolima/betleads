# Escopo UX — composer de campanhas e envio individual

**Data:** 07/10/2026  
**Objetivo:** reduzir ambiguidade entre selecionar, criar e editar conteúdo nos canais SMS, e-mail e voz, mantendo um fluxo seguro de disparo.

## Diagnóstico ponderado

| Item observado | Avaliação UX/técnica | Decisão |
| --- | --- | --- |
| Criar template dentro do mesmo modal da campanha | Mistura duas tarefas, alonga o modal e dificulta preservar o rascunho | Abrir editores dedicados em uma segunda área/modal e retornar com o ativo criado já selecionado |
| Envio individual sem criação de template | Faz o operador repetir conteúdo e impede reaproveitamento | Adicionar seleção e criação de template no envio individual |
| SMS com seletor, texto manual e formulário de template simultâneos | Não deixa claro se a edição altera o template ou apenas a campanha | Separar origem do conteúdo; edição na campanha gera uma cópia local e criação usa diálogo próprio |
| E-mail criado por textarea | Não representa o resultado entregue e aumenta risco de HTML inválido | Reutilizar o editor visual real, com preview desktop/mobile, imagens, links e metadados |
| Voz sem upload no composer | Obriga sair do fluxo e contradiz a opção “Áudio fixo” | Oferecer upload direto, validar formato/tamanho e selecionar o áudio finalizado |
| Variáveis ausentes nos três canais | Aumenta erros de sintaxe e memorização desnecessária | Exibir catálogo contextual; inserir no cursor quando há campo editável e usar referência quando o ativo é somente leitura |

## Prioridades e critérios de aceite

### P1 — Variáveis visíveis e consistentes

- Catálogo único e transversal aos canais, sem vínculo exclusivo com SMS.
- Inserção na posição do cursor em mensagens SMS, templates de e-mail e scripts TTS.
- Referência das variáveis aceitas quando um ativo selecionado estiver em modo somente leitura.
- Catálogo presente também nos fluxos de criação rápida enquanto existirem.
- Variáveis desconhecidas continuam bloqueando o disparo.

### P2 — Templates SMS e envio individual

- Criação de template em diálogo próprio, sem expandir o composer.
- Envio individual permite selecionar template ou escrever mensagem manual.
- Envio individual permite criar e selecionar um novo template sem perder destinatário/conteúdo.
- Contagem de caracteres/partes e rastreamento permanecem visíveis.

### P3 — Editor visual de e-mail

- “Criar template” abre o editor visual existente em área ampla e independente.
- Preview desktop/mobile e recursos de imagem/CTA continuam disponíveis.
- Ao salvar, o template é persistido, a lista é atualizada e o novo item fica selecionado na campanha.
- O composer não oferece textarea de HTML como alternativa de criação.

### P4 — Upload de áudio e coerência de voz

- Em “Áudio fixo”, o operador pode selecionar da biblioteca ou fazer upload.
- Formatos, limite e falhas são informados antes/depois do upload.
- O ativo finalizado é atualizado na lista e selecionado automaticamente.
- Em “Script TTS”, criação ocorre em diálogo próprio com variáveis visíveis.

## Melhorias propostas para ciclo seguinte

- Busca nos seletores de ativos quando houver mais de 20 itens.
- Indicador explícito “conteúdo do template foi personalizado nesta campanha”.
- Teste de renderização de e-mail e envio de prova antes de liberar campanha ampla.
- Player de áudio embutido no composer, com duração e tamanho.
- Métrica de tempo para concluir campanha, taxa de abandono e erros por variável/canal.

## Plano de entrega e validação

Cada prioridade deve ter build e testes aprovados, reinício do servidor local, commit e push próprios. O aceite manual ocorre em **Canais → Campanhas**, nos botões **Nova campanha** e **Envio individual / teste**. O arquivo local já modificado `scripts/sync-sortealta-export.mjs` não faz parte deste escopo e deve permanecer intacto.

## Registro da entrega

| Prioridade | Entrega | Evidência |
| --- | --- | --- |
| P1 | Catálogo de variáveis visível e fonte única compartilhada entre SMS, e-mail e voz | Commit `bf974d8`, consolidado em `d2f3c40` após revisão de produto |
| P2 | Criação de template SMS em diálogo dedicado; seleção/criação também no envio individual | Commit `d2f3c40` |
| P3 | Editor visual real de e-mail na campanha e no envio individual, com retorno do template selecionado | Commit `baf1f97` |
| P4 | Upload de áudio fixo e editor dedicado de script TTS na campanha e no envio individual | Commit `5280559` |

### Validação técnica

- `npm run build`: aprovado após cada prioridade funcional.
- `npm test -- --run`: aprovado durante os ciclos de validação.
- Servidor local reiniciado após cada prioridade em `http://127.0.0.1:3000/`.
- Alteração pré-existente em `scripts/sync-sortealta-export.mjs`: preservada e excluída dos commits.

### Roteiro de aceite manual

1. Em **Canais → Campanhas → Nova campanha → SMS**, selecionar, personalizar e criar um template; confirmar inserção de variável no cursor.
2. Em **E-mail**, abrir **Criar novo template**, montar no editor visual, salvar e confirmar seleção automática e preview.
3. Em **Voz → Áudio fixo**, enviar arquivo aceito e confirmar seleção automática; repetir com formato inválido ou acima de 50 MB.
4. Em **Voz → Script TTS**, criar script, inserir variáveis, ajustar voz, salvar e confirmar seleção automática.
5. Repetir os três cenários em **Envio individual / teste** e confirmar que destinatário e conteúdo já preenchidos não são perdidos ao abrir os editores.
