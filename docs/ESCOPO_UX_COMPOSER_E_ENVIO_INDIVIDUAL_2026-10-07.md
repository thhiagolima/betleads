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

- Catálogo visível no SMS da campanha e no envio individual, com inserção na posição do cursor.
- Referência das variáveis aceitas ao selecionar templates de e-mail e scripts TTS.
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
