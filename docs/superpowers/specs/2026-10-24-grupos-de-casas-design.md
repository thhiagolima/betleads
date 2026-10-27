# Grupos de casas e painel financeiro — design

Data: 2026-10-24
Status: rascunho para aprovação

## 1. Intenção

Hoje cada casa é uma ilha: o usuário tem um papel por casa (`user_roles`) e só o super admin enxerga
várias casas ao mesmo tempo. Na prática, quem opera várias casas do mesmo dono acompanha a saúde
financeira numa planilha (`docs/Pixreals Fechamento.xlsx`), digitando à mão números que o CRM já tem.

Este projeto traz duas coisas:

1. **Grupos de casas**: um grupo reúne casas e tem um ou mais **gestores de grupo**. Eles veem
   todas as casas do grupo e nomeiam as pessoas de cada casa.
2. **Painel financeiro**: cada casa ganha o seu fechamento financeiro, que substitui a planilha.
   Os números que já existem no CRM entram sozinhos e o resto é lançado pelo admin. O gestor de
   grupo tem um painel consolidado com filtros, comparativos, metas e um placar entre as casas.

Sucesso significa que o dono das casas larga a planilha e abre o painel do grupo para saber, num
olhar, quais casas estão bem e quais estão com problema.

## 2. Objetivos, não-objetivos e anti-objetivos

**Objetivos**
- Super admin cria grupos, coloca casas neles e nomeia gestores de grupo.
- O gestor de grupo nomeia, troca e remove admins e gestores nas casas do seu grupo.
- Fechamento financeiro por casa, com as mesmas colunas e contas da planilha.
- Painel do grupo com período, comparação, metas por casa e placar entre as casas.
- O gestor da casa não vê o financeiro, a não ser que o admin libere.

**Não-objetivos**
- Integrar o GGR com a plataforma da casa. O GGR é sempre lançado à mão.
- Mudar a cobrança e os créditos de SMS, voz e e-mail. Esses custos não entram automaticamente.
  O admin pode lançá-los em "outros custos do mês".
- Dar ao gestor de grupo poder de operação (jornadas, campanhas, configurações) sem um papel
  dentro da casa.

**Anti-objetivos** (falharia mesmo funcionando)
- Qualquer papel herdado automaticamente. O gestor de grupo **não** vira admin das casas do grupo.
  Toda nomeação é explícita, feita pelo gestor de grupo ou pelo super admin.
- O gestor de grupo enxergar ou mexer em qualquer coisa fora dos grupos dele.
- O resultado do painel não bater com a planilha para os mesmos números de entrada.

## 3. Papéis e permissões

Os papéis continuam valendo **por casa**. A mesma pessoa pode ser admin da casa A (grupo 1) e
gestora da casa B (grupo 2). O gestor de grupo é um papel novo, que vale **por grupo**, e uma
pessoa pode ser gestora de vários grupos.

| Ação | Super admin | Gestor do grupo | Admin da casa | Gestor da casa |
|---|---|---|---|---|
| Criar/renomear/excluir grupo, pôr e tirar casas | sim | não | não | não |
| Nomear/remover gestores de grupo | sim | não | não | não |
| Nomear/trocar/remover **admin** numa casa do grupo | sim | sim (só no próprio grupo) | não | não |
| Nomear/trocar/remover **gestor e membro** numa casa | sim | sim (só no próprio grupo) | sim, como hoje (com ou sem grupo) | não |
| Ver o painel do grupo | todos os grupos | os próprios grupos | não | não |
| Ver o financeiro da casa | sim | sim (só leitura) | sim | só se liberado |
| Lançar GGR, anúncios e outros custos | sim | não | sim | não |
| Alterar as taxas da casa (% GGR, % movimentação) | sim | sim | sim | não |
| Definir metas da casa | sim | sim | não | não |
| Liberar o financeiro para um gestor da casa | sim | sim | sim | não |
| Operar a casa (jornadas, campanhas, configurações) | sim | só com papel na casa | sim | conforme hoje |

Notas:
- Se o gestor de grupo quiser operar ou lançar números numa casa, ele se nomeia admin dela.
  Leva um clique e fica no log de auditoria.
- Hoje o código só deixa o super admin definir admins (`addUserToTenantFor` e
  `updateTenantUserRole` em `src/lib/tenants.functions.ts`). O gestor de grupo passa a poder fazer
  isso **nas casas do grupo**. A regra de manter pelo menos um admin por casa continua valendo.
- O admin da casa **não perde** nada quando a casa entra num grupo. Ele continua adicionando,
  trocando e removendo gestores e membros, como hoje. Não há "dono" da nomeação: vale a última
  alteração, seja do admin, do gestor de grupo ou do super admin, e todas ficam na auditoria.
  O admin não pode remover nem rebaixar um admin, também como hoje.
- O gestor de grupo nunca pode vincular um super admin. A regra que já existe continua valendo.
- O papel `member` existente não muda.

## 4. Como o usuário navega

O seletor do topo (`src/components/active-tenant-switcher.tsx`) passa a listar os **grupos** de que
a pessoa é gestora, além das casas onde ela tem papel:

- **Grupo selecionado**: aparece o menu do grupo, com Painel do grupo, Financeiro por casa (só
  leitura), Casas e Pessoas.
- **Casa selecionada**: aparece o menu normal da casa, conforme o papel da pessoa nela. Nada muda.

Não existe um "seletor de papel" separado. Escolher um grupo ou uma casa já define o que aparece.
Quem é gestor de grupo e não tem papel em nenhuma casa vê só os grupos no seletor.

## 5. Fechamento financeiro da casa

Tela da casa, visível para admin, super admin, gestor do grupo e gestores liberados. Imita a
planilha: uma linha por dia e uma visão por mês.

### Colunas

| Coluna | Origem |
|---|---|
| Data | dia no fuso de Brasília |
| Anúncios (R$) | **manual**. Se houver gasto da Meta em `marketing_ad_metrics_daily` no dia, ele aparece como sugestão, e o valor que vale é o que o admin confirma ou digita |
| Cadastros | CRM: `tenant_daily_metrics.registrations` |
| Custo por cadastro | Anúncios ÷ Cadastros ("n.a." se cadastros = 0) |
| FTDs | CRM: `tenant_daily_metrics.ftds` |
| Custo por FTD | Anúncios ÷ FTDs ("n.a." se FTDs = 0) |
| Depósitos FTD (R$) | CRM: soma dos primeiros depósitos aprovados no dia. Não existe pronto e precisa ser calculado a partir de `deposits` |
| Depósitos totais (R$) | CRM: `tenant_daily_metrics.approved_deposit_amount` |
| Saques (R$) | CRM: `tenant_daily_metrics.approved_withdrawal_amount` |
| Net bruto | Depósitos totais − Saques |
| GGR (R$) | **manual** (pode ser negativo) |
| Resultado caixa | ver fórmula |
| ROI caixa | Resultado caixa ÷ Anúncios ("n.a." se anúncios = 0) |

### Fórmulas (iguais às da planilha)

Com `tx_ggr` = taxa de GGR da casa (ex.: 16%) e `tx_mov` = taxa de movimentação (ex.: 2,7%):

- **Resultado caixa do dia** = Net − round(GGR × tx_ggr, 2) − round(Depósitos × tx_mov, 2)
  − round(Saques × tx_mov, 2) − round(Net × tx_mov, 2) − Anúncios
- **Taxa de movimentação do mês** = Σ dias [round(Dep × tx_mov) + round(Saq × tx_mov) + round(Net × tx_mov)]
- **Taxa GGR do mês** = Σ dias round(GGR × tx_ggr)
- **Resultado caixa do mês** = Σ Net − Taxa de movimentação do mês − Taxa GGR do mês − Σ Anúncios − Σ Outros custos do mês
- **ROI caixa do mês** = Resultado do mês ÷ Σ Anúncios
- **Média diária**: média dos dias preenchidos. A média do resultado é o resultado do mês dividido
  pelos dias com resultado.

O resultado de um dia só é calculado quando os campos manuais desse dia (Anúncios e GGR) foram
preenchidos. Sem eles, o dia aparece como "pendente", como na planilha.

A planilha cobra a taxa de movimentação sobre o **Net também**, além de depósitos e saques. Isso é
replicado exatamente como está, **inclusive com Net negativo**. Nesse caso a parcela fica negativa
e melhora o resultado. Foi confirmado pelo usuário e não deve ser "corrigido".

### Preenchimento retroativo

Os valores manuais (GGR, anúncios e outros custos do mês) **não** precisam ser lançados no próprio
dia. O admin pode preencher ou corrigir qualquer dia ou mês passado, a qualquer momento.
- Não há trava de mês fechado.
- Um lançamento retroativo atualiza na hora o dia, os totais, o placar, as comparações e a cor
  das metas. Ele usa a taxa e a meta que valiam **naquele dia**.
- A tela facilita o lançamento em lote: dá para editar vários dias seguidos na grade do mês, sem
  abrir dia por dia.
- Toda alteração fica na auditoria, com quem alterou, o valor antes e o valor depois.

### Dias pendentes

Igual à planilha, onde o Net fica em branco enquanto falta o GGR:
- Os números que vêm do CRM (cadastros, FTDs, depósitos, saques) sempre aparecem e sempre somam.
- Net, Resultado e ROI de um dia só são calculados quando o GGR **e** os Anúncios do dia estão
  confirmados. Uma sugestão da Meta que ainda não foi confirmada não conta.
- Nos totais de qualquer período, Net, Resultado e ROI somam **só os dias completos**. A célula
  indica "N dias pendentes" quando há dias de fora. Uma meta avaliada sobre um período com dias
  pendentes não ganha cor: ela fica cinza, com o aviso.

### Outros custos do mês

Lista livre de linhas (descrição + valor) por mês, como "CRM" e "SMS" na planilha. Esses custos
entram no resultado do mês, mas não no de cada dia.

No painel, os outros custos só entram no Resultado quando o período é um **mês fechado no
calendário** (o filtro "Mês" ou um personalizado que cobre exatamente o mês). Em qualquer outro
período, o Resultado mostrado é o operacional, sem outros custos, e a tela diz isso. Assim o mês
bate com a planilha, e não precisamos inventar um rateio.

### Taxas

Cada casa tem a sua taxa de GGR e a sua taxa de movimentação. Quando a taxa é alterada, a nova
vale daquele dia em diante. Os dias anteriores continuam usando a taxa da época, para um
fechamento antigo não mudar sozinho.

### Liberação para gestores

O admin (ou o gestor do grupo, ou o super admin) libera o financeiro **por pessoa**: cada gestor
da casa tem um "pode ver o financeiro". A liberação é só de leitura.

## 6. Painel do grupo

Aprovado o layout **A, em formato de placar** (mockup em
`.superpowers/brainstorm/5093-1792850661/content/painel-grupo.html`).

**Topo**
- Período: Hoje, Ontem, 7 dias, Mês, Personalizado.
- Comparar com:
  - **Período anterior**: a janela do mesmo tamanho imediatamente antes (dia anterior, os 7 dias
    anteriores e assim por diante). Para "Mês", é o mês anterior **até o mesmo dia do mês**, para
    que um mês em andamento não seja comparado com um mês inteiro.
  - **Mesmo dia da semana passada**: só para períodos de um dia.
  - **Mesmo período da semana passada**: a janela deslocada 7 dias para trás.
- Totais do grupo, cada um com a variação % em relação ao período comparado: Depósitos, Saques,
  Net bruto, FTDs, Anúncios, Resultado caixa.

**Placar**: uma linha por casa e uma coluna por métrica (Depósitos, FTDs, Custo/FTD, Net, Resultado,
ROI, com cadastros e GGR como colunas opcionais).
- Cada célula mostra o valor e a variação.
- As células com meta ficam coloridas: verde se a meta foi batida, amarelo se está até 20% longe
  dela, vermelho se está mais longe. Embaixo do valor aparece "meta X".
- A tabela pode ser ordenada por qualquer coluna.
- Clicar na casa abre o fechamento financeiro dela, só para leitura.

Os totais do grupo somam as casas. Custos por unidade e ROI são recalculados a partir das somas
(não é feita a média das casas).

## 7. Metas

- As metas são **por casa** e definidas pelo gestor do grupo (ou pelo super admin).
- Cada meta tem uma métrica, uma direção e um valor diário. Exemplos: FTDs ≥ 100 por dia,
  Custo por FTD ≤ R$ 90, ROI ≥ 0.
- Métricas possíveis: Cadastros, FTDs, Depósitos totais, Net bruto, Resultado caixa, Custo por
  cadastro, Custo por FTD, ROI caixa.
- A meta não varia por dia da semana. Ela vale até alguém alterá-la. A alteração vale daquele dia
  em diante, e os dias anteriores são avaliados com a meta da época.
- **Períodos de vários dias**: metas de soma (FTDs, cadastros, depósitos, net, resultado) são
  multiplicadas pelo número de dias do período. Metas de razão (custos por unidade, ROI) não são
  multiplicadas.
- **Cores**: verde quando a meta foi batida. Amarelo quando está até 20% longe:
  - para metas "≥", o valor está entre 80% e 100% da meta;
  - para metas "≤", o valor está até 20% acima da meta.

  Vermelho quando está mais longe que isso. Casa sem meta fica sem cor.
- **Meta 0 ou negativa** (ex.: ROI ≥ 0, Resultado ≥ 0): não há faixa percentual. A célula fica
  verde quando a meta foi batida e vermelha quando não foi.

## 8. Restrições e base técnica existente

- **Isolamento**: todo acesso de grupo passa pelo RLS. As funções que já existem
  (`has_tenant_access`, `accessible_tenant_ids`, `managed_tenant_ids`, `current_tenant_id`, em
  `supabase/migrations/20261015090000_consolidate_tenant_rls.sql` e `20261015100000_fix_rls_privilege_escalation.sql`)
  **não** podem passar a incluir as casas do grupo para o gestor de grupo. Se incluíssem, ele
  ganharia acesso operacional por herança. O acesso de grupo deve ser um caminho separado e de
  leitura (ex.: `group_tenant_ids()`), usado só pelas tabelas e funções financeiras e de grupo.
- **Dados do CRM**: `tenant_daily_metrics` (chave `tenant_id, metric_date`) já tem cadastros, FTDs,
  depósitos e saques por dia. Falta o valor dos depósitos FTD.
- **Fuso**: os dias seguem o horário de Brasília, igual ao resto do sistema (ver commit 1a38fcf).
  É preciso confirmar se `tenant_daily_metrics` já usa esse corte.
- **Casa demo**: entra num **grupo demo**, para mostrar o painel do grupo em vendas.
  - O grupo demo só pode conter casas demo (`is_demo`). Uma casa real nunca entra num grupo demo,
    e uma casa demo nunca entra num grupo real.
  - O usuário demo pode ser gestor do grupo demo. Os guards de `is_demo_user` ganham essa exceção
    e só essa.
  - O seed e o reset da demo geram lançamentos financeiros inventados (GGR, anúncios, outros
    custos), taxas e metas, para o painel aparecer preenchido.
  - Nomeações de pessoas continuam bloqueadas na demo (`assertTenantNotDemo`).
  - Hoje existe uma só casa demo (Casa Betleads). Um placar com uma linha só demonstra pouco.
    Criar mais casas demo fica fora deste projeto e pode ser um passo seguinte.
- **Auditoria**: nomeações, remoções, mudanças de taxa, de meta e de liberação ficam registradas no
  log de auditoria já existente, igual às ações `tenant_user.*` de hoje.
- Uma casa pertence a **no máximo um grupo** (decisão minha: simplifica permissões e consolidação).
  Casas sem grupo funcionam como hoje.

## 9. Fica a critério de quem constrói

- Nomes de tabelas e colunas, o formato das migrações e onde guardar o histórico de metas e taxas
  (com `valid_from`).
- Se o "Depósitos FTD" entra em `tenant_daily_metrics` como coluna nova ou é calculado na consulta.
- Se o placar é calculado sob demanda ou por uma tabela agregada (o volume é pequeno: dias × casas).
- O visual exato das telas, seguindo o shell atual (tema escuro, ver memória de redesign).
- A importação dos meses da planilha que já passaram (agosto a outubro). É desejável, mas não é
  obrigatória para a primeira entrega.

## 10. Decisões tomadas por mim (para conferir)

- O gestor de grupo vê o financeiro só para leitura e não lança valores.
- Uma casa pertence a no máximo um grupo.
- Ao mudar uma taxa ou uma meta, a nova vale dali para frente e o passado não é recalculado.
- Metas de soma são multiplicadas pelo número de dias, e metas de razão não.
- A liberação do financeiro é feita por pessoa, não para todos os gestores da casa.
- O gasto da Meta aparece só como sugestão, e o valor que vale é o confirmado pelo admin.
- Os custos de SMS, voz e e-mail cobrados pela plataforma não entram sozinhos.
- Dias sem GGR ou anúncios confirmados ficam fora do Net, do Resultado e do ROI, como na planilha.
  As metas desses dias ficam cinza.
- Outros custos do mês só entram no Resultado do painel quando o período é um mês fechado.
- "Mês" é comparado com o mês anterior até o mesmo dia.
- Metas 0 ou negativas não têm faixa amarela.
- Quando admin e gestor de grupo mexem nas mesmas pessoas, vale a última alteração, e tudo fica
  na auditoria.
- Grupo demo só com casas demo, com dados financeiros inventados no seed e no reset.
- Não há trava de mês fechado, e qualquer valor passado pode ser corrigido (com auditoria).

## 11. Decidido pelo usuário (registro)

- Os papéis valem por casa. Nenhum papel é herdado, e toda nomeação é feita pelo gestor do grupo
  ou pelo super admin. O admin da casa continua adicionando gestores, como hoje.
- Um grupo pode ter vários gestores, e uma pessoa pode ser gestora de vários grupos.
- O gestor de grupo é restrito aos próprios grupos.
- O grupo entra no seletor do topo, com um menu próprio voltado a números e pessoas.
- O GGR e os anúncios são lançados à mão. A Meta pode ajudar a preencher os anúncios.
- Só o admin lança valores. O gestor da casa não vê o financeiro por padrão, e o admin pode
  liberar.
- As taxas mudam de casa para casa e podem ser alteradas pelo admin, pelo gestor do grupo ou pelo
  super admin.
- A taxa de movimentação sobre o Net é mantida, inclusive com Net negativo.
- O painel do grupo usa o layout de placar (A), com filtros por dia e comparativos dia × dia e
  semana × semana.
- As metas são por casa, mudam quando o gestor altera, e as cores seguem verde, amarelo até 20%
  e vermelho.
- A casa demo entra num grupo.
- Os dados manuais podem ser preenchidos retroativamente, a qualquer momento.
