# Auditoria de design — tela Públicos (2026-11-20)

**Fontes analisadas**
- O print enviado (bravabet365, super admin, desktop).
- O código de [publicos.tsx](../src/routes/publicos.tsx) e de [audience-parts.tsx](../src/components/audiences/audience-parts.tsx), na branch `feat` do worktree `betleads-publicos` (commit `b4822b99`, com os públicos "Cadastrou ontem" e "Só fez o 1º depósito").

**O que a tela precisa resolver, por ordem de frequência**
1. Escolher um público pronto ou salvo e mandar campanha para ele.
2. Saber o tamanho de cada público antes de escolher.
3. Criar ou ajustar um público.

**Como ela está hoje:** a tela trata a tarefa 3 como a principal. O editor fica sempre aberto, ocupando metade da tela. A tarefa 2 nem é atendida.

---

## 1. Hierarquia

| # | Problema | Onde | Efeito |
|---|---|---|---|
| H1 | Editor e biblioteca têm o mesmo peso: dois cartões lado a lado, e o editor vem antes. No celular o editor vem primeiro e é preciso rolar o formulário inteiro para ver os públicos. | `publicos.tsx:222` | A tarefa mais comum (usar um público) fica em segundo plano. |
| H2 | Cada cartão tem um "Usar na campanha" em cor primária cheia. São mais de 10 botões azuis iguais na mesma tela. | `audience-parts.tsx:164` | O olho não tem onde parar, e a cor de destaque perde o sentido. |
| H3 | Nomes cortados: "Todos os jogado…" e "Leads mortos (sem res…". O botão e o "⋯" ocupam a largura do cartão na grade de 2 colunas, e o título usa `truncate`. | `audience-parts.tsx:141, 147`; grade `xl:grid-cols-2` em `:734` | A informação mais importante do cartão, o nome, é a que some. |
| H4 | Os níveis Bronze, Prata, Ouro, Diamante e Black VIP ocupam 5 cartões grandes, cada um com uma descrição que só repete o nome ("Jogadores classificados no nível Bronze"). | `sms-audience-criteria.ts:108-135` | Muito espaço para pouca informação. |
| H5 | O "⋯" aparece só em alguns cartões automáticos (só em "Todos"). | `publicos.tsx:744-756` | Os botões ficam desalinhados entre cartões vizinhos. |

## 2. Quantidade de leads

| # | Problema | Onde |
|---|---|---|
| Q1 | **Nenhum público, nem salvo nem automático, mostra quantos jogadores tem.** A única contagem da tela fica na prévia do editor. Para saber o tamanho de "Ouro", é preciso montar o filtro à mão. | `AudienceCard` não recebe contagem |
| Q2 | O subtítulo de "Seus públicos" diz "As quantidades são recalculadas no momento do envio", mas a tela não mostra quantidade nenhuma. | `publicos.tsx:578` |
| Q3 | O número dentro de cada chip ("Já depositou **392**") não diz o que conta: se é o total da casa ou o total combinado com os outros filtros. | `RuleChip` em `audience-parts.tsx:89` |

## 3. Textos

| # | Hoje | Problema | Proposta |
|---|---|---|---|
| T1 | "Escolhas incompatíveis se substituem; as demais podem ser combinadas." | Jargão; o leigo não sabe o que é "incompatível". | "Toque para filtrar. Dá para juntar filtros de grupos diferentes, como *Já depositou* + *Saque pendente*." |
| T2 | "Ontem é o dia anterior inteiro, no horário de Brasília. Quando vira o dia, o jogador sai do público." (2 linhas sob "Cadastro") | Detalhe técnico sempre visível. | Mover para o (i) do chip. Na tela basta: "Cadastro". |
| T3 | "Os níveis de fidelização estão sempre prontos…" | A seção também tem "Todos os jogadores" e "Leads mortos", que não são níveis. | Título "Prontos para usar". Subtítulo: "Atualizados sozinhos, conforme o comportamento dos jogadores." |
| T4 | "Jogadores classificados no nível Bronze." (em todos os níveis) | Repete o nome. | Tirar a descrição. O nível vira um bloco com ícone e contagem. |
| T5 | Cartão salvo com descrição + etiquetas das regras ("Nunca depositou", "Cadastrou ontem") | As etiquetas repetem a descrição. | Uma linha só: as regras viram o subtítulo; a descrição do usuário aparece só se existir. |
| T6 | "Quem deve fazer parte deste público?" + "O que o jogador fez" + 7 títulos de grupo com ajuda | Muitos níveis de título no mesmo formulário. | Um título por bloco e ajuda só no (i). |
| T7 | Prévia no fim do formulário: "X jogadores atendem a estas regras" + descrição longa + "com telefone válido…" | A informação mais útil enquanto se monta o filtro fica escondida no fim de um formulário longo. | Faixa fixa no rodapé do editor: "**1.234 jogadores** · 1.100 com celular", ao lado de "Salvar público". |
| T8 | "Nunca sacou" com a bolinha a 40% de opacidade | Parece desabilitado. | Mesma cor do grupo, sem opacidade. |
| T9 | "Nunca depositou" no grupo Depósito usa a cor azul de Cadastro, e os outros chips do grupo são verdes | A cor não segue o grupo. | Cor do grupo Depósito. |

## 4. Excesso de elementos

- **Três camadas de borda:** cartão da página, cartão do público e chips, um dentro do outro. Cada nível tem borda e fundo próprios. *Proposta:* a biblioteca vira uma **lista de linhas** separadas por divisor, sem uma caixa por público.
- **Bolinhas coloridas repetidas:** a bolinha aparece no título do grupo e de novo em cada chip. *Proposta:* manter só no título do grupo.
- **Formulário longo:** são 7 grupos de filtro mais 2 campos numéricos, numa coluna de 440px, com espaçamentos irregulares. *Proposta:* 4 blocos (Depósito · Saques e pendências · Nível e tempo parado · Cadastro e bônus), com "Mais filtros" recolhido para "Dias sem entrar" e "Dias desde o cadastro".
- **Tamanhos fora da escala:** chips em `text-[13px]`, fora da escala de tipos. *Proposta:* usar `text-label`.

## 5. Interação

- **I1.** Ao editar um público salvo, a página rola até o topo e preenche o formulário que já estava aberto. O modo edição só se nota pelo título e por um "Cancelar" discreto.
- **I2.** "Criar público" fica desabilitado sem explicar o motivo (falta o nome).
- **I3.** Não há busca nem ordenação em "Seus públicos". Com muitos públicos salvos, a lista fica difícil de percorrer.
- **I4.** "Usar em jornada" existe só no menu de "Todos os jogadores".

---

## 6. Proposta de layout

```
Públicos                                                   [ + Novo público ]   ← único botão primário
Separe seus jogadores em grupos para campanhas mais certeiras.

┌ Prontos para usar ───────────────────────────────────────────────────────────┐
│ Todos os jogadores                         12.480 jogadores · 11.902 c/ celular  [Usar] ⋯ │
│ Por nível   [🥉 Bronze 8.120] [🥈 Prata 2.310] [🥇 Ouro 1.402] [💎 Diamante 520] [⭐ Black 128] │
│ Leads mortos · sem resposta às jornadas      340 jogadores                  [Usar] ⋯ │
└──────────────────────────────────────────────────────────────────────────────┘

Seus públicos                                       [🔍 Buscar]  Ordenar: maior ▾
──────────────────────────────────────────────────────────────────────────────
Cadastrou ontem e não depositou                      40 jogadores · 38 c/ celular  [Usar] ⋯
Nunca depositou · Cadastrou ontem
──────────────────────────────────────────────────────────────────────────────
Só fez o 1º depósito                                295 jogadores · 280 c/ celular [Usar] ⋯
Só fez o 1º depósito
```

**Editor ("Novo público", "Editar" ou "Duplicar")**
- Abre num painel lateral no desktop e em tela cheia no celular, no padrão do compositor de campanha.
- Nome no topo.
- Filtros em 4 blocos, com "Mais filtros" recolhido.
- **Rodapé fixo** com a contagem ao vivo ("1.234 jogadores · 1.100 com celular") e "Salvar público". Se faltar o nome, o rodapé diz "Dê um nome para salvar".

**Cartão de público**
- O nome quebra em até 2 linhas, sem corte.
- Abaixo do nome, uma linha com as regras.
- A contagem fica em destaque, alinhada à direita.
- "Usar" vira botão de contorno. No "⋯" ficam: Usar em campanha, Usar em jornada, Editar, Duplicar e Excluir.

**Níveis:** um único bloco com 5 blocos menores (ícone, nome e contagem). Tocar num bloco abre "Usar".

---

## 7. Engenharia da contagem

- **Prontos:** uma única chamada a `resolveSmsCampaignAudience` com o filtro vazio já devolve `total` e `facets.levels`, ou seja, "Todos" e os 5 níveis. "Leads mortos" precisa de uma chamada própria (`deadLeads: true`).
- **Salvos:**
  - criar uma server function `countAudiences({ items: [{ id, criteria }] })` que chama `resolveAudienceForTenant` para cada item, com o cache de 30 s que já existe e um limite de concorrência de 4;
  - devolve `{ id, total, recipientTotal }`;
  - públicos de seleção usam a lista de ids.
- **Expert:** o mesmo contrato, no escopo dos leads dele (o caminho `resolveExpertCampaignAudience` já existe).
- **Atualização:** contagem ao abrir a tela, com "Atualizado às HH:MM" e um botão para recalcular. O envio continua recalculando, como hoje.
- **Desempenho:** `resolveAudienceForTenant` também calcula as facetas, que custam caro. Para a lista, vale uma variante só com a contagem. Medir numa casa grande (betgreen) antes de decidir.

## 8. Tutorial

O tour de Públicos (`help/screens/publicos.ts`) aponta para âncoras do editor e dos cartões. Ele precisa ser atualizado junto com o redesenho:
- `publicos.editor.*` passa a ficar dentro do painel;
- `publicos.lista.*` e `publicos.automaticos.*` mudam de lugar.
