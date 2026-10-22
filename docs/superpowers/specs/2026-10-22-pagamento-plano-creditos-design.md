# Pagamento do plano e dos créditos — desenho (visual e funcional)

**Data:** 22/10/2026
**Origem:** conversa com o responsável pelo produto (brainstorming de 22/10) sobre as fases PG4 (mensalidade), PG5-01 (página da casa) e PG5-02 (console do superadmin) de [docs/ESCOPO_GATEWAY_PAGAMENTO_UPPER_2026-10-21.md](../../ESCOPO_GATEWAY_PAGAMENTO_UPPER_2026-10-21.md).
**Estado de partida:**
- A PG1 (saldo único em R$, preços, plano `interno` isento) está em produção.
- A PG2 (compra de créditos por Pix com a Upper) está no main e as migrations dela estão aplicadas, mas a compra segue desligada (`BILLING_GATEWAY_ENABLED`).

## 1. Por quê

A mensalidade de R$ 4.000 ainda não é cobrada pelo sistema. Falta:
- uma fatura;
- um botão de pagamento;
- os avisos de vencimento;
- o bloqueio de quem não paga.

Também falta ao superadmin o controle sobre exceções do dia a dia: prazo, desconto, dias grátis, bloqueio e baixa manual. A casa precisa saber com antecedência que vai vencer, pagar sem falar com ninguém e voltar a usar na hora em que paga.

## 2. Mudanças em relação ao escopo de 21/10 (decididas nesta conversa)

| Item do escopo | Antes | Agora |
|---|---|---|
| D3: o que a suspensão bloqueia | só os envios; o acesso continuava | **o CRM inteiro**, exceto a página "Plano e créditos" |
| D10: quem paga | só o admin da casa | **admin e gestor** (vale para mensalidade e créditos) |
| Primeira fatura | vence na ativação (sem dizer se usa antes) | **paga antes de usar**: casa que vira pagante já nasce bloqueada até o primeiro Pix |
| Avisos | e-mail citado de passagem (PG4-06) | faixas no CRM **e** e-mail, em 4 momentos (seção 5) |

As demais decisões do escopo continuam valendo:
- **Fatura:** R$ 4.000/mês, vence no dia da ativação de cada casa, sem pró-rata, e é gerada 5 dias antes do vencimento.
- **Carência:** 3 dias.
- **Créditos:** não expiram.
- **Reembolso:** não há.
- **Isenção:** casas `interno` nunca são cobradas e nunca veem faixa nem bloqueio.

## 3. Linha do tempo da mensalidade (o que a casa vê)

Exemplo com vencimento em 05/11:

| Quando | Estado | O que aparece |
|---|---|---|
| até 30/10 | em dia | nada |
| 31/10 a 04/11 (5 dias antes) | a vencer | **faixa amarela** no topo de todas as telas: "Sua mensalidade de R$ 4.000,00 vence em 05/11 (daqui a N dias). Pague por Pix para manter tudo funcionando." + botão **Pagar agora** |
| 05/11 a 08/11 (vencimento + 3 dias de carência) | vencida | **faixa vermelha**: "Sua mensalidade venceu em 05/11. Se não for paga até 08/11, o acesso ao CRM será bloqueado." + botão **Pagar agora** |
| a partir de 09/11 | bloqueada | **o CRM inteiro bloqueado**; cada tela mostra o cartão "Acesso suspenso por falta de pagamento — a mensalidade de R$ 4.000,00 venceu em 05/11. Pague por Pix e o acesso volta na hora." + botão **Ir para o pagamento**. Só a página "Plano e créditos" abre |
| no momento do Pix confirmado | em dia | a faixa e o bloqueio somem na hora; o ciclo avança para 05/12 |

Os modelos aprovados na conversa estão em `.superpowers/brainstorm/12165-1792675670/content/faixas-v1.html` e `pagina-v1.html`, como referência visual e não como pixel final. A aparência segue o tema escuro atual do CRM.

**Faixa:**
- Fica logo abaixo do topo, em todas as telas da casa, inclusive no celular.
- Não pode ser fechada enquanto o estado durar.

**Casa bloqueada:**
- Os envios automáticos param: SMS, voz, e-mail, jornadas e campanhas. Os workers pulam casas bloqueadas, como já pulam as `suspended`.
- O webhook da casa continua recebendo dados (cadastros, depósitos), para não perder informação.

**Por papel:**

| Papel | Faixa e bloqueio |
|---|---|
| Admin e gestor | veem e têm o botão de pagar |
| Membro | vê a mesma faixa e o mesmo cartão, **sem botão**, com o texto "Peça ao administrador da casa para pagar a mensalidade." |
| Superadmin olhando uma casa bloqueada pelo seletor do topo | vê a faixa, mas **não é bloqueado** (precisa operar e dar suporte) |

## 4. Página "Plano e créditos"

Substitui a atual "Saldo e consumo" (`/creditos-sms`). O menu "Configurações → Saldo e consumo" passa a se chamar **Plano e créditos**. A rota antiga redireciona.

Blocos, de cima para baixo:

1. **Mensalidade** (casa pagante):
   - "Plano CRM — R$ 4.000,00/mês", ou o valor com desconto contínuo, mostrando o original riscado;
   - selo de situação: "Em dia até 04/12", "Vence em 05/11 · daqui a 3 dias", "Vencida em 05/11" ou "Bloqueada";
   - período atual;
   - botão **Pagar mensalidade (Pix)** quando há fatura em aberto.

   Casa isenta: o bloco mostra "Plano interno — isento".
2. **Saldo de uso:**
   - saldo, "Créditos não expiram" e os preços (SMS R$ 0,08, voz R$ 0,09 por 30 s, e-mail com 100 mil grátis);
   - botão **Comprar créditos (Pix)**, que abre o modal que já existe na PG2.
   - **Casa bloqueada:** o saldo continua visível, mas o botão fica desabilitado com "Disponível depois de pagar a mensalidade". O servidor também recusa a compra.
3. **Faturas:** período, vencimento, valor (com desconto, se houver), situação (Em aberto / Paga em dd/mm / Cancelada) e ação. "Pagar" aparece na fatura em aberto; "Comprovante" na paga, mostrando data, valor, descrição e o identificador do Pix.
4. **Consumo do mês e extrato:** os blocos que já existem hoje.

**Modal de pagar a mensalidade:** igual ao de compra de créditos.
- Mostra o valor, o QR, o Copia e Cola com "Copiar" e a contagem até o Pix vencer.
- A confirmação é automática. Ao pagar, aparece "Mensalidade paga — acesso liberado até 04/12".
- Reabrir uma fatura em aberto com Pix ainda válido mostra **o mesmo Pix**. Se ele venceu, um novo é gerado.

**Quem paga** (mensalidade e créditos): admin e gestor da casa. O servidor confere o papel.

## 5. E-mails

Saem do remetente da plataforma (`no-reply@betleads.io`, pela Infobip), nunca do remetente da casa. Vão para **os e-mails de todos os usuários admin e gestor da casa**.

| Momento | Assunto (sugestão) | Conteúdo |
|---|---|---|
| Fatura gerada (5 dias antes) | "Sua mensalidade BetLeads vence em 05/11" | valor, vencimento, link para "Plano e créditos" |
| Dia do vencimento | "Sua mensalidade BetLeads vence hoje" | idem + aviso dos 3 dias de carência |
| Bloqueio | "Acesso ao CRM suspenso por falta de pagamento" | o que parou, link para pagar, "volta na hora" |
| Pagamento confirmado | "Pagamento confirmado — obrigado!" | valor, data, período pago e os dados do comprovante |

Cada e-mail sai **uma vez por fatura e por momento**. O superadmin pode reenviar (seção 6, item 11).

## 6. Console do superadmin ("Faturamento")

Fica em `/admin`, numa aba nova, e na ficha da casa em `/tenants`. Toda ação grava em `tenant_audit_logs` quem fez, quando e o motivo, que é obrigatório.

| # | Ação | Comportamento |
|---|---|---|
| 1 | Bloquear casa | Bloqueio imediato, independente de fatura. Motivo obrigatório. Desbloqueio manual. O cartão da casa diz "Acesso suspenso. Fale com o suporte." (sem botão de pagar, salvo se também houver fatura vencida) |
| 2 | Estender prazo | Muda o vencimento de **uma** fatura em aberto (+N dias). As faixas e o bloqueio seguem a nova data. O ciclo seguinte não muda |
| 3 | Dias grátis | Estende o período pago atual em N dias **sem cobrar**. O ciclo inteiro anda junto (próximo vencimento + N, e o dia de vencimento passa a ser o novo) |
| 4 | Desconto pontual | R$ ou % numa fatura em aberto. Se já há Pix gerado para ela, ele é cancelado na Upper e o próximo sai com o valor novo |
| 5 | Desconto contínuo | R$ ou % aplicado a toda fatura gerada da casa, com início e fim opcional. Aparece na fatura como "Desconto: …" |
| 6 | Baixa manual | Marca uma fatura como paga fora do Pix, com valor recebido, data, comprovante (arquivo ou texto) e motivo. Libera a casa como um pagamento normal |
| 7 | Cancelar fatura | Fatura em aberto gerada por engano. Motivo obrigatório. Cancela o Pix na Upper, se houver |
| 8 | Trocar dia de vencimento | Muda o dia do ciclo da casa a partir da próxima fatura, sem pró-rata. A fatura em aberto, se houver, mantém a data |
| 9 | Painel | Receita mensal recorrente; recebido no mês; a receber nos próximos 5 dias; faturas vencidas; casas bloqueadas (por falta de pagamento e manualmente); pagamentos em revisão (`needs_review`) |
| 10 | Histórico da casa | Linha do tempo: faturas, pagamentos, descontos, extensões, dias grátis, bloqueios e trocas de plano, cada um com autor e data |
| 11 | Reenviar e-mail | Reenvia o último e-mail de cobrança da fatura em aberto |
| 12 | Relatório mensal (CSV) | Por casa: mensalidade paga, créditos comprados, consumo por canal, custo do fornecedor, taxa do Pix (quando cadastrada), receita líquida e margem. Isentas à parte |
| 13 | Congelar plano | Pausa a cobrança: não gera faturas novas e a casa fica bloqueada com "Plano pausado. Fale com o suporte." Ao descongelar, o ciclo recomeça a partir da data do descongelamento, com fatura vencendo nesse dia (paga antes de usar) |
| 14 | Valor do plano por casa | Preço próprio de mensalidade para uma casa (substitui os R$ 4.000). O desconto contínuo, se houver, aplica sobre esse preço |

Também ficam aqui o cadastro da taxa do Pix (D11) e a edição de preços que já existe.

## 7. Como funciona por dentro (o que já está decidido)

- **Cobrança da fatura:** reaproveita a PG2.
  - `payment_charges` com `kind = 'invoice'`, `external_id = bl-inv-<id da fatura>-<n>`;
  - o mesmo cliente da Upper, o mesmo webhook, a mesma conciliação e a mesma regra de só confirmar depois de um GET com `PAID` e o valor exato.
  - O RPC `billing_credit_paid_charge` ganha o ramo `invoice`. Hoje ele recusa com `invoice_not_supported`. O novo ramo marca a fatura paga, avança o ciclo e libera a casa. **Não** credita saldo.
- **Situação da casa:** vem de uma tabela de cobrança por casa, com plano, preço, desconto contínuo, dia do ciclo, estado (em dia / a vencer / vencida / bloqueada por falta de pagamento / bloqueada manualmente / congelada / isenta / aguardando primeiro pagamento) e datas. O estado é recalculado por um cron diário, e na hora em que um pagamento é confirmado.
- **Bloqueio na aplicação:** reaproveita o portão atual de casa suspensa (`src/components/tenant-status-gate.tsx` e `assertTenantCanOperate`/`assertTenantCanSendExternally` em `src/lib/tenant-access.server.ts`). Ele passa a liberar a rota de "Plano e créditos" e as funções de pagamento.
- **Bloqueio no servidor:** um usuário bloqueado não consegue chamar as funções do CRM, só as de pagamento e de leitura de saldo e faturas.
- **Liga/desliga:** a cobrança e o bloqueio ficam atrás de chaves separadas, como no escopo (PG2-06 e D14). A primeira fatura de cada casa já existente sai com o bloqueio **desligado**; o bloqueio liga a partir da segunda fatura, depois de aviso por escrito às casas.
- **Créditos:** a compra continua igual à PG2, exceto que gestor também pode comprar e casa bloqueada não pode.

## 7.1 Regras decididas depois da revisão do desenho

**Do responsável pelo produto**
- **Casa bloqueada por mais de um ciclo:** enquanto a casa está bloqueada por falta de pagamento, **não se geram faturas novas**. Ao pagar a fatura em aberto (um mês, R$ 4.000 ou o valor com desconto), o ciclo **recomeça na data do pagamento**. Exemplo: bloqueada desde 09/11 e paga em 20/12 → libera em 20/12 e a próxima vence em 20/01. Os meses bloqueados não são cobrados.
- **E-mail da plataforma:** o domínio `betleads.io` já está verificado na Infobip. Os e-mails da seção 5 saem por ele, num remetente de plataforma configurado por env, sem depender do remetente de cada casa.

**Decisões minhas (marcadas para conferência)**
- **O que torna uma casa pagante:** o superadmin troca o plano de `interno` para o plano pago, ou cria a casa já com ele.
  - Nesse momento a primeira fatura é criada com **vencimento no mesmo dia**, sem a antecedência de 5 dias, e a casa fica em "aguardando primeiro pagamento", com o mesmo bloqueio da seção 3.
  - O assistente de configuração da casa (onboarding) **também fica bloqueado** até o primeiro pagamento ("paga antes de usar").
  - O dia do ciclo passa a ser o dia do primeiro pagamento.
- **Casas pagantes que já existem:** hoje todas as casas reais estão em `interno`; a única pagante é a casa de teste QA Jornadas P0. Não há migração de ciclo para casas reais. Quem virar pagante segue a regra acima.
- **Transição (D14):** como não há casas reais pagantes, a liberação gradual por fatura deixa de ser necessária. Fica só a chave global de bloqueio (`BILLING_ENFORCEMENT_ENABLED`).
  - Com ela desligada, as faixas e os e-mails **não falam em bloqueio**: a faixa vermelha diz "Sua mensalidade venceu em 05/11. Pague para regularizar.", e o e-mail de bloqueio não sai.
- **Estado da cobrança separado de `tenants.status`:**
  - O bloqueio por falta de pagamento, o bloqueio manual do superadmin e o plano congelado ficam no estado de cobrança da casa, e não em `tenants.status`.
  - Um Pix confirmado só tira o bloqueio **por falta de pagamento**. Um bloqueio manual continua até o superadmin desbloquear.
  - `tenants.status = 'suspended'/'canceled'` continua valendo como hoje e não muda.
  - O portão e as travas de envio passam a considerar os dois.
- **Papéis:**
  - `owner` é tratado como admin: paga e recebe os e-mails.
  - `user` é tratado como membro.
  - Superadmin nunca é bloqueado.
- **Descontos e dias grátis:**
  - Desconto que deixa a fatura em R$ 0,00 (100%) dá baixa automática nela, como "Paga — desconto integral".
  - Desconto que deixa a fatura entre R$ 0,01 e R$ 99,99 é **recusado** com "O valor da fatura não pode ficar abaixo de R$ 100,00 (mínimo do Pix)".
  - Dias grátis com fatura em aberto: o vencimento dessa fatura anda junto (+N dias) e o ciclo segue a nova data.

## 8. Fora deste trabalho

- Nota fiscal automática (continua manual, a partir do relatório da seção 6, item 12).
- Boleto, cartão e débito automático (a Upper só faz Pix).
- Estorno automático.
- Vários planos para escolha da própria casa (só existe o plano único, com preço ajustável pelo superadmin).
- Cobrança de voz e e-mail no envio (é a PG3, trabalho separado).

## 9. Anti-objetivos (o que tornaria isto um fracasso, mesmo funcionando)

- Uma casa que pagou continuar bloqueada, ou ficar sem a fatura marcada como paga.
- Uma casa isenta ver faixa, receber e-mail de cobrança ou ser bloqueada.
- O superadmin ficar travado ao abrir uma casa bloqueada.
- Pagar duas vezes a mesma fatura por ter gerado dois Pix válidos ao mesmo tempo.
- Um membro ser convidado a pagar sem poder pagar.
- Envios ou jornadas continuarem rodando numa casa bloqueada.

## 10. Deixado para quem constrói

- Componentes, rotas internas e nomes das tabelas e funções.
- O texto exato dos e-mails, seguindo o tom e o conteúdo da seção 5.
- O layout fino da página e do console, mantendo a ordem e o conteúdo das seções 4 e 6.
- Como guardar o comprovante da baixa manual (arquivo ou texto).
