# FLUXO CRM — régua de mensagens (especificação de negócio)

> **Origem:** conversão automática de `FLUXO CRM.docx` (13/10/2026) para Markdown em 16/10/2026 (F3-01). O `.docx` original continua em `docs/` como referência; em caso de divergência de formatação, vale o `.docx`.
>
> **Atenção:** esta é a especificação original do cliente. Partes dela foram superadas por decisões posteriores (orçamento de 2+4 mensagens/dia em vez de no máximo 1 mensagem de régua/dia; cashback disparado no pagamento em vez de D+1). Ver AUDITORIA_COMPLETA_SISTEMA_2026-10-16.md §7.3 item 3. A reconciliação está prevista no F3-03 do ESCOPO_CORRECOES_AUDITORIA_2026-10-16.md.

### Como funciona a Lógica do Loop:

- **Dias 1 ao 5:** O cliente recebe **5 mensagens diferentes e focadas** (uma por dia) para incentivar o avanço.

- **Dia 6 em diante (Loop Infinito):** Caso o cliente ainda não tenha mudado de categoria, o sistema entra em **loop alternando entre as mensagens 4 e 5** diariamente, até que ele atinja o objetivo e mude de nível.

- **Virada de Categoria:** No momento em que o cliente muda de status/nível, a régua anterior para **imediatamente** e ele começa a receber a nova régua diária a partir do Dia 1.

### 1. Régua de Cadastro & Onboarding (Diária)

- **Objetivo:** Fazer o 1º Depósito para virar "Já Depositou / Bronze".

- **Dia 1:** Bem-vindo a Sorte Alta! Seu cadastro foi concluído. Comece com o pé direito! Faça seu 1º depósito agora: www.sortealta.io

- **Dia 2:** Sua sorte te espera na Sorte Alta! Deposite a partir de R$10 e comece a jogar hoje mesmo: www.sortealta.io

- **Dia 3:** Tem prêmios acumulados na Sorte Alta esperando por você! Faça seu depósito e aproveite: www.sortealta.io

- **Dia 4:** Não deixe sua sorte esfriar na Sorte Alta. Faça um depósito rápido e libere seus jogos favoritos: www.sortealta.io

- **Dia 5:** Sua conta na Sorte Alta está pronta! Deposite agora e venha buscar seus lucros: www.sortealta.io

- 🔄 **A partir do Dia 6 (Loop Diário):** Alterna diariamente entre as mensagens do Dia 4 e Dia 5 até o 1º depósito.

### 2. Status Temporais (Frequência Diária)

#### GEROU PIX E NÃO PAGOU

- **Ativação:** Disparo imediato e reforço diário enquanto a chave/intenção estiver ativa sem pagamento.

- **Dia 1 (Imediato):** Falta pouco! Seu PIX na Sorte Alta foi gerado. Pague agora para receber seus créditos: www.sortealta.io

- **Dia 2:** Seu PIX pendente na Sorte Alta ainda pode te render prêmios! Conclua seu pagamento: www.sortealta.io

- **Dia 3 em diante (Loop):** Não perca a chance de lucrar hoje na Sorte Alta! Conclua seu PIX e jogue agora: www.sortealta.io

#### ESFRIANDO (A partir de 2 dias sem depositar)

- **Dia 1:** Sentimos sua falta na Sorte Alta! Seus jogos favoritos estão te esperando. Acesse: www.sortealta.io

- **Dia 2:** Que tal dar um giro hoje? Acesse a Sorte Alta e veja as melhores oportunidades de hoje: www.sortealta.io

- **Dia 3:** Sua sorte não pode parar! Faça um novo depósito na Sorte Alta e volte a ganhar: www.sortealta.io

- **Dia 4:** O jackpot da Sorte Alta pode sair a qualquer momento. Garanta sua jogada hoje: www.sortealta.io

- **Dia 5:** Volte para a ação na Sorte Alta! Faça seu depósito e divirta-se agora: www.sortealta.io

- 🔄 **A partir do Dia 6 (Loop Diário):** Alterna entre Dia 4 e Dia 5 diariamente até voltar a depositar.

#### DORMINDO (A partir de 7 dias sem depositar)

- **Dia 1:** Sua conta na Sorte Alta está com saudades! Acesse agora e confira as novidades: www.sortealta.io

- **Dia 2:** Faz tempo que você não ganha na Sorte Alta! Que tal tentar a sorte hoje? Acesse: www.sortealta.io

- **Dia 3:** Volte a jogar na Sorte Alta. Um novo depósito coloca você de volta no jogo: www.sortealta.io

- **Dia 4:** Prêmios e giros te esperam na Sorte Alta. Não fique de fora, acesse já: www.sortealta.io

- **Dia 5:** Sua oportunidade de lucrar está te esperando na Sorte Alta. Faça seu depósito: www.sortealta.io

- 🔄 **A partir do Dia 6 (Loop Diário):** Alterna entre Dia 4 e Dia 5 diariamente até depositar.

#### 30 DIAS SEM DEPÓSITO

- **Dia 1:** Sua conta na Sorte Alta tem vantagens de retorno! Deposite hoje e ative seus benefícios: www.sortealta.io

- **Dia 2:** Que tal reativar sua sorte hoje? Faça um novo depósito na Sorte Alta e jogue: www.sortealta.io

- **Dia 3:** A Sorte Alta preparou o momento ideal para você voltar. Acesse e deposite agora: www.sortealta.io

- **Dia 4:** Grandes prêmios estão saindo na Sorte Alta! Não perca a sua chance de ganhar hoje: www.sortealta.io

- **Dia 5:** Sua caminhada na Sorte Alta ainda não acabou. Faça um depósito e volte aos jogos: www.sortealta.io

- 🔄 **A partir do Dia 6 (Loop Diário):** Alterna entre Dia 4 e Dia 5 diariamente até depositar.

### 3. Níveis VIP / Progresso (Frequência Diária)

#### NÍVEL BRONZE (Meta: Subir para Prata)

- **Dia 1:** Jogador BRONZE Sorte Alta: você está no caminho para o nível Prata! Deposite hoje e evolua: www.sortealta.io

- **Dia 2:** Suba de nível na Sorte Alta! Continue depositando para alcançar o VIP Prata e liberar vantagens: www.sortealta.io

- **Dia 3:** Falta pouco para o Prata! Faça seu depósito diário na Sorte Alta e suba na categoria: www.sortealta.io

- **Dia 4:** O nível Prata te dá mais benefícios na Sorte Alta. Deposite agora e acelere sua subida: www.sortealta.io

- **Dia 5:** Aumente seu status BRONZE na Sorte Alta! Deposite hoje para chegar mais rápido ao PRATA: www.sortealta.io

- 🔄 **A partir do Dia 6 (Loop Diário):** Alterna entre Dia 4 e Dia 5 diariamente até virar Prata.

#### NÍVEL PRATA (Meta: Subir para Ouro)

- **Dia 1:** Status PRATA ativo na Sorte Alta! Deposite hoje e fique mais perto das recompensas do nível OURO: www.sortealta.io

- **Dia 2:** Você é Prata, mas pode ser OURO! Faça seu depósito na Sorte Alta e continue subindo de nível: www.sortealta.io

- **Dia 3:** Mantenha o ritmo no nível PRATA! Deposite hoje na Sorte Alta para garantir sua vaga no OURO: www.sortealta.io

- **Dia 4:** O nível OURO da Sorte Alta te espera com vantagens exclusivas. Deposite agora e suba de categoria: www.sortealta.io

- **Dia 5:** Acelere seu progresso na Sorte Alta! Faça seu depósito e avance do Prata direto para o Ouro: www.sortealta.io

- 🔄 **A partir do Dia 6 (Loop Diário):** Alterna entre Dia 4 e Dia 5 diariamente até virar Ouro.

#### NÍVEL OURO (Meta: Subir para Diamante)

- **Dia 1:** Status OURO Sorte Alta! Você já é destaque. Faça seu depósito hoje e chegue mais perto do DIAMANTE: www.sortealta.io

- **Dia 2:** Jogadores OURO ganham mais na Sorte Alta! Continue jogando para desbloquear o status DIAMANTE: www.sortealta.io

- **Dia 3:** O nível DIAMANTE é para poucos na Sorte Alta. Deposite hoje e mostre que você merece estar no topo: www.sortealta.io

- **Dia 4:** Faltam poucos passos para o nível DIAMANTE na Sorte Alta! Faça seu depósito diário e garanta seu lugar: www.sortealta.io

- **Dia 5:** Sua jornada VIP na Sorte Alta não para no OURO. Deposite agora e conquiste o status DIAMANTE: www.sortealta.io

- 🔄 **A partir do Dia 6 (Loop Diário):** Alterna entre Dia 4 e Dia 5 diariamente até virar Diamante.

#### NÍVEL DIAMANTE (Meta: Subir para Black VIP)

- **Dia 1:** Nível DIAMANTE! Você faz parte da elite da Sorte Alta. Deposite hoje e busque o topo supremo: BLACK VIP: www.sortealta.io

- **Dia 2:** Sua experiência DIAMANTE é diferenciada na Sorte Alta. Deposite e continue rumo ao nível BLACK VIP: www.sortealta.io

- **Dia 3:** O topo supremo da Sorte Alta te espera. Deposite hoje para acelerar sua entrada no BLACK VIP: www.sortealta.io

- **Dia 4:** Falta muito pouco para o BLACK VIP na Sorte Alta! Faça seu depósito e ative a experiência definitiva: www.sortealta.io

- **Dia 5:** Como DIAMANTE, seus ganhos na Sorte Alta são insanos. Deposite hoje e consolide seu caminho ao BLACK VIP: www.sortealta.io

- 🔄 **A partir do Dia 6 (Loop Diário):** Alterna entre Dia 4 e Dia 5 diariamente até virar Black VIP.

#### NÍVEL BLACK VIP (Meta: Retenção/Manutenção)

- **Dia 1:** Você é BLACK VIP na Sorte Alta! Seu status é supremo. Acesse sua área exclusiva e jogue hoje: www.sortealta.io

- **Dia 2:** Atendimento e prêmios exclusivos para o nosso BLACK VIP na Sorte Alta. Faça seu depósito e continue no topo: www.sortealta.io

- **Dia 3:** O melhor da Sorte Alta está reservado para você, nosso jogador BLACK VIP. Acesse e aproveite hoje: www.sortealta.io

- **Dia 4:** Sua experiência BLACK VIP na Sorte Alta continua ativa! Deposite hoje e aproveite seus privilégios: www.sortealta.io

- **Dia 5:** Ser BLACK VIP na Sorte Alta significa jogar com as melhores vantagens. Faça seu depósito agora: www.sortealta.io

- 🔄 **A partir do Dia 6 (Loop Diário):** Alterna entre Dia 4 e Dia 5 diariamente para manter o jogador engajado.

### 4. Regra de Cashback (Sobressalente)

- **Quando ocorre:** No dia seguinte (D+1) a um saldo negativo do jogador.

- **Comportamento:** Substitui o SMS VIP do dia para priorizar o resgate do jogador.

**SMS:** Seu CASHBACK já está disponível na Sorte Alta! Devolvemos uma % para você voltar a jogar agora mesmo, não perca tempo: www.sortealta.io
