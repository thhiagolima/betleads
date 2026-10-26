# Rascunho — Comunicado às casas: preços, pagamento por Pix e vencimentos (PG6-01)

**Status:** rascunho para revisão do responsável. Não enviar antes da aprovação.
**Escopo:** `docs/ESCOPO_GATEWAY_PAGAMENTO_UPPER_2026-10-21.md` (PG6-01, D14)

## Notas para quem aprova (não vão no texto às casas)

- **Preencher:** `[DATA DE CORTE]` e `[CONTATO DE SUPORTE]`.
- **O que a `[DATA DE CORTE]` significa.** O texto usa uma data só: a partir
  dela valem os preços e a cobrança, e o atraso pode suspender o acesso. Pela
  D14, o bloqueio só é ligado depois do primeiro ciclo
  (`BILLING_ENFORCEMENT_ENABLED`). Se a cobrança começar antes do bloqueio,
  separe as duas datas no texto, por exemplo "a partir de [DATA DE CORTE] para
  preços e cobrança, e a partir de [DATA DO BLOQUEIO] para a suspensão por
  atraso". Ligar o bloqueio exige este aviso por escrito antes
  (`RUNBOOK_ATIVAR_MENSALIDADE.md`, Passo 8).
- **Primeira fatura de quem vira pagante.** No código, ela vence no mesmo dia
  e a casa só usa o CRM depois do primeiro Pix ("paga antes de usar"), com o
  bloqueio ligado. O texto não detalha isso. Se alguma casa for passar de
  `interno` a pagante nesta virada, avise-a à parte.
- **Voz.** "Ligação não atendida não é cobrada" é a regra atual. Ela ainda
  depende da confirmação de custo com a Infobip (D7, PG0-05) e pode mudar sem
  código. Se quiser margem, troque por "hoje, ligações não atendidas não são
  cobradas".
- **Conferido no código em 23/10/2026:**
  - os preços da tabela de preços;
  - o mínimo de R$ 100;
  - os pacotes R$ 500, R$ 1.000, R$ 2.500 e R$ 5.000 e o valor livre de até
    R$ 50.000;
  - a faixa amarela 5 dias antes;
  - a faixa vermelha no vencimento e os 3 dias de carência;
  - a suspensão a partir do 4º dia, com só "Plano e créditos" aberta;
  - o limite de saldo baixo (padrão R$ 200, 0 desliga, no máximo 1 e-mail por
    dia);
  - os canais que param com saldo zero;
  - a jornada que pula o passo;
  - a campanha pausada com "Retomar";
  - quem paga: administradores e gestores da casa;
  - o remetente `no-reply@betleads.io`.

---

## Assunto do e-mail

**Novos preços da BetLeads e pagamento por Pix a partir de [DATA DE CORTE]**

---

## Versão e-mail

Olá!

A partir de **[DATA DE CORTE]**, a mensalidade e os créditos da BetLeads
passam a ser pagos por Pix, direto no CRM, sem precisar falar com ninguém.
Abaixo estão os preços, como pagar e o que acontece em caso de atraso.

### Preços

| O quê | Preço |
|---|---|
| Plano CRM | **R$ 4.000,00 por mês** |
| SMS | **R$ 0,08** por parte de mensagem |
| Ligações | **R$ 0,09** a cada 30 segundos |
| E-mail | **100.000 por mês grátis**; depois, **R$ 0,002** cada |

**Como contamos o SMS.** Uma mensagem de até **160 caracteres** é 1 SMS. Se ela
tiver letras com acento (como ã, á, ç, õ) ou emoji, cabem **70 caracteres**
em 1 SMS. Mensagens maiores são divididas em partes, e cada parte custa
R$ 0,08. Antes de enviar, o CRM mostra quantas partes a mensagem tem e quanto
vai custar.

**Como contamos as ligações.** Cada 30 segundos começados contam como um
bloco. Uma ligação de 45 segundos, por exemplo, usa 2 blocos e custa R$ 0,18.
**Só cobramos ligações atendidas.**

**E-mail.** Os primeiros 100.000 e-mails de cada mês são gratuitos. A partir
daí, cada e-mail custa R$ 0,002.

### Como pagar

Tudo fica na página **"Plano e créditos"**, no menu do CRM:

- **Mensalidade:** clique em **"Pagar mensalidade (Pix)"** e pague pelo QR code
  ou pelo Pix copia e cola. A confirmação é automática, em poucos segundos.
- **Créditos** (para SMS, ligações e e-mails além da franquia): clique em
  **"Comprar créditos (Pix)"**, escolha um pacote (R$ 500, R$ 1.000, R$ 2.500
  ou R$ 5.000) ou digite outro valor. **A compra mínima é de R$ 100,00.**
- Se o Pix expirar antes do pagamento, é só gerar outro.
- Quem pode pagar: os **administradores e gestores** da casa.

**Seus créditos não expiram**, nem se a conta for suspensa. O saldo fica
guardado e volta a valer assim que a mensalidade é paga.

### Vencimento e atraso

- **5 dias antes do vencimento**, aparece uma **faixa amarela** no topo do CRM
  com o valor e a data, e enviamos um e-mail.
- **No dia do vencimento**, a faixa fica **vermelha** e você tem **mais 3 dias**
  para pagar.
- **Depois desses 3 dias**, o acesso ao CRM é **suspenso**. Só a página "Plano
  e créditos" continua aberta, para você pagar. Durante a suspensão param os
  envios de SMS, ligações, e-mails, jornadas e campanhas. Os cadastros e
  depósitos dos seus jogadores continuam chegando normalmente.
- **Pagou, liberou:** assim que o Pix é confirmado, o acesso volta na hora.

Os avisos de cobrança chegam por e-mail, do domínio **betleads.io**
(no-reply@betleads.io), para os administradores e gestores da casa. Vale
adicionar esse endereço aos seus contatos para não cair no spam.

### Quando o saldo de créditos fica baixo

- Cada casa escolhe o seu **limite de alerta de saldo baixo** no quadro
  "Alerta de saldo baixo" da página "Plano e créditos". O padrão é
  **R$ 200,00**.
- Quando o saldo fica abaixo desse limite, mostramos um aviso no CRM e
  mandamos **um e-mail por dia** aos administradores e gestores.
- **Se o saldo acabar:**
  - **SMS e ligações param** até você comprar créditos.
  - **E-mails continuam**, dentro dos 100.000 gratuitos do mês.
  - **Jornadas** pulam o passo que não tem saldo e seguem para o próximo
    (aquele envio não é refeito depois).
  - **Campanhas de SMS e de e-mail** ficam **pausadas**. Depois de comprar
    créditos, é só clicar em **"Retomar"** na campanha.

### Dúvidas

Fale com a gente em **[CONTATO DE SUPORTE]**.

Obrigado por estar com a BetLeads!

Equipe BetLeads

---

## Versão curta (WhatsApp / aviso no CRM)

> **BetLeads: novidades a partir de [DATA DE CORTE]** 📢
>
> A mensalidade e os créditos passam a ser pagos **por Pix**, direto na página
> **"Plano e créditos"** do CRM (QR code ou copia e cola).
>
> 💰 **Preços**
> • Plano CRM: R$ 4.000/mês
> • SMS: R$ 0,08 por parte (160 caracteres, ou 70 com acento/emoji)
> • Ligações: R$ 0,09 a cada 30 s, só as atendidas
> • E-mail: 100 mil/mês grátis, depois R$ 0,002 cada
>
> 🗓️ **Vencimento:** aviso amarelo 5 dias antes; no vencimento, aviso vermelho
> e mais 3 dias para pagar. Depois disso, o CRM fica suspenso até o pagamento,
> e volta na hora em que o Pix é confirmado.
>
> 🔋 **Créditos:** compra mínima de R$ 100, e eles não expiram. Se o saldo
> acabar, SMS e ligações param, as campanhas pausam (é só "Retomar" depois) e
> os e-mails seguem dentro da franquia. Avisamos por e-mail quando o saldo
> ficar abaixo do seu limite (padrão R$ 200).
>
> Dúvidas: [CONTATO DE SUPORTE]
