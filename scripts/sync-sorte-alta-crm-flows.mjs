import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const DAY = 86_400;
const URL = "www.sortealta.io";

const copies = {
  onboarding: [
    `Bem-vindo a Sorte Alta! Seu cadastro foi concluido. Comece com o pe direito! Faca seu 1o deposito agora: ${URL}`,
    `Sua sorte te espera na Sorte Alta! Deposite a partir de R$10 e comece a jogar hoje mesmo: ${URL}`,
    `Tem premios acumulados na Sorte Alta esperando por voce! Faca seu deposito e aproveite: ${URL}`,
    `Nao deixe sua sorte esfriar na Sorte Alta. Faca um deposito rapido e libere seus jogos favoritos: ${URL}`,
    `Sua conta na Sorte Alta esta pronta! Deposite agora e venha buscar seus lucros: ${URL}`,
  ],
  pix: [
    `Falta pouco! Seu PIX na Sorte Alta foi gerado. Pague agora para receber seus creditos: ${URL}`,
    `Seu PIX pendente na Sorte Alta ainda pode te render premios! Conclua seu pagamento: ${URL}`,
    `Nao perca a chance de lucrar hoje na Sorte Alta! Conclua seu PIX e jogue agora: ${URL}`,
  ],
  cooling: [
    `Sentimos sua falta na Sorte Alta! Seus jogos favoritos estao te esperando. Acesse: ${URL}`,
    `Que tal dar um giro hoje? Acesse a Sorte Alta e veja as melhores oportunidades de hoje: ${URL}`,
    `Sua sorte nao pode parar! Faca um novo deposito na Sorte Alta e volte a ganhar: ${URL}`,
    `O jackpot da Sorte Alta pode sair a qualquer momento. Garanta sua jogada hoje: ${URL}`,
    `Volte para a acao na Sorte Alta! Faca seu deposito e divirta-se agora: ${URL}`,
  ],
  sleeping: [
    `Sua conta na Sorte Alta esta com saudades! Acesse agora e confira as novidades: ${URL}`,
    `Faz tempo que voce nao ganha na Sorte Alta! Que tal tentar a sorte hoje? Acesse: ${URL}`,
    `Volte a jogar na Sorte Alta. Um novo deposito coloca voce de volta no jogo: ${URL}`,
    `Premios e giros te esperam na Sorte Alta. Nao fique de fora, acesse ja: ${URL}`,
    `Sua oportunidade de lucrar esta te esperando na Sorte Alta. Faca seu deposito: ${URL}`,
  ],
  dormant30: [
    `Sua conta na Sorte Alta tem vantagens de retorno! Deposite hoje e ative seus beneficios: ${URL}`,
    `Que tal reativar sua sorte hoje? Faca um novo deposito na Sorte Alta e jogue: ${URL}`,
    `A Sorte Alta preparou o momento ideal para voce voltar. Acesse e deposite agora: ${URL}`,
    `Grandes premios estao saindo na Sorte Alta! Nao perca a sua chance de ganhar hoje: ${URL}`,
    `Sua caminhada na Sorte Alta ainda nao acabou. Faca um deposito e volte aos jogos: ${URL}`,
  ],
  bronze: [
    `Jogador BRONZE Sorte Alta: voce esta no caminho para o nivel Prata! Deposite hoje e evolua: ${URL}`,
    `Suba de nivel na Sorte Alta! Continue depositando para alcancar o VIP Prata e liberar vantagens: ${URL}`,
    `Falta pouco para o Prata! Faca seu deposito diario na Sorte Alta e suba na categoria: ${URL}`,
    `O nivel Prata te da mais beneficios na Sorte Alta. Deposite agora e acelere sua subida: ${URL}`,
    `Aumente seu status BRONZE na Sorte Alta! Deposite hoje para chegar mais rapido ao PRATA: ${URL}`,
  ],
  silver: [
    `Status PRATA ativo na Sorte Alta! Deposite hoje e fique mais perto das recompensas do nivel OURO: ${URL}`,
    `Voce e Prata, mas pode ser OURO! Faca seu deposito na Sorte Alta e continue subindo de nivel: ${URL}`,
    `Mantenha o ritmo no nivel PRATA! Deposite hoje na Sorte Alta para garantir sua vaga no OURO: ${URL}`,
    `O nivel OURO da Sorte Alta te espera com vantagens exclusivas. Deposite agora e suba de categoria: ${URL}`,
    `Acelere seu progresso na Sorte Alta! Faca seu deposito e avance do Prata direto para o Ouro: ${URL}`,
  ],
  gold: [
    `Status OURO Sorte Alta! Voce ja e destaque. Faca seu deposito hoje e chegue mais perto do DIAMANTE: ${URL}`,
    `Jogadores OURO ganham mais na Sorte Alta! Continue jogando para desbloquear o status DIAMANTE: ${URL}`,
    `O nivel DIAMANTE e para poucos na Sorte Alta. Deposite hoje e mostre que voce merece estar no topo: ${URL}`,
    `Faltam poucos passos para o nivel DIAMANTE na Sorte Alta! Faca seu deposito diario e garanta seu lugar: ${URL}`,
    `Sua jornada VIP na Sorte Alta nao para no OURO. Deposite agora e conquiste o status DIAMANTE: ${URL}`,
  ],
  diamond: [
    `Nivel DIAMANTE! Voce faz parte da elite da Sorte Alta. Deposite hoje e busque o topo supremo: BLACK VIP: ${URL}`,
    `Sua experiencia DIAMANTE e diferenciada na Sorte Alta. Deposite e continue rumo ao nivel BLACK VIP: ${URL}`,
    `O topo supremo da Sorte Alta te espera. Deposite hoje para acelerar sua entrada no BLACK VIP: ${URL}`,
    `Falta muito pouco para o BLACK VIP na Sorte Alta! Faca seu deposito e ative a experiencia definitiva: ${URL}`,
    `Como DIAMANTE, seus ganhos na Sorte Alta sao insanos. Deposite hoje e consolide seu caminho ao BLACK VIP: ${URL}`,
  ],
  black: [
    `Voce e BLACK VIP na Sorte Alta! Seu status e supremo. Acesse sua area exclusiva e jogue hoje: ${URL}`,
    `Atendimento e premios exclusivos para o nosso BLACK VIP na Sorte Alta. Faca seu deposito e continue no topo: ${URL}`,
    `O melhor da Sorte Alta esta reservado para voce, nosso jogador BLACK VIP. Acesse e aproveite hoje: ${URL}`,
    `Sua experiencia BLACK VIP na Sorte Alta continua ativa! Deposite hoje e aproveite seus privilegios: ${URL}`,
    `Ser BLACK VIP na Sorte Alta significa jogar com as melhores vantagens. Faca seu deposito agora: ${URL}`,
  ],
  cashback: [
    `Seu CASHBACK ja esta disponivel na Sorte Alta! Devolvemos uma % para voce voltar a jogar agora mesmo, nao perca tempo: ${URL}`,
  ],
};

const sms = (content, label) => ({
  step_type: "sms",
  label,
  config: { content, track_links: true },
});
const wait = (label = "Aguardar 1 dia") => ({
  step_type: "wait",
  label,
  config: { delay_seconds: DAY },
});

function fiveDayLoop(messages) {
  const steps = [];
  messages.forEach((message, index) => {
    steps.push(sms(message, `Dia ${index + 1}`));
    if (index < messages.length - 1) steps.push(wait());
  });
  const loopStart = steps.length;
  steps.push(wait("Aguardar proximo dia"));
  steps.push(sms(messages[3], "Loop - Dia 4"));
  steps.push(wait());
  steps.push(sms(messages[4], "Loop - Dia 5"));
  steps.push({
    step_type: "end",
    label: "Repetir Dias 4 e 5",
    config: { loop_to_position: loopStart },
  });
  return steps;
}

function pixLoop(messages) {
  return [
    sms(messages[0], "Dia 1 - Imediato"),
    wait(),
    sms(messages[1], "Dia 2"),
    wait(),
    sms(messages[2], "Dia 3 - Loop"),
    { step_type: "end", label: "Repetir Dia 3", config: { loop_to_position: 3 } },
  ];
}

const commonRules = {
  audience: "system:all-leads",
  window_start: "08:00",
  window_end: "22:00",
  weekdays: [1, 2, 3, 4, 5, 6, 0],
  max_attempts: 3,
  retry_base_seconds: 60,
};
const now = new Date().toISOString();
const definitions = [
  {
    name: "Cadastrou e não depositou",
    aliases: ["Cadastrou e nao depositou"],
    description:
      "Regua diaria de cadastro ate o primeiro deposito; depois do Dia 5 alterna Dias 4 e 5.",
    trigger_type: "cadastrados_sem_deposito",
    trigger_config: {},
    entry_rules: { ...commonRules, reentry: "once" },
    exit_rules: { deposit: true, first_deposit: true },
    conflict_family: "aquisicao",
    journey_priority: 2,
    conflict_policy: "pause_lower_priority",
    conversion_objective: "acquisition",
    steps: fiveDayLoop(copies.onboarding),
  },
  {
    name: "PIX gerado e não pago",
    aliases: ["PIX gerado e nao pago"],
    description: "Reforco diario enquanto o PIX permanecer pendente.",
    trigger_type: "pix_gerado_nao_pago",
    trigger_config: {},
    entry_rules: { ...commonRules, reentry: "per_occurrence" },
    exit_rules: { deposit: true, first_deposit: true },
    conflict_family: "aquisicao",
    journey_priority: 1,
    conflict_policy: "pause_lower_priority",
    conversion_objective: "conversion",
    steps: pixLoop(copies.pix),
  },
  {
    name: "Esfriando — 2 dias sem depósito",
    aliases: ["Sumiu depois de depositar", "Esfriando - 2 dias sem deposito"],
    description: "Regua diaria para jogador ha 2 dias sem depositar.",
    trigger_type: "inactivity",
    trigger_config: { field: "ultimo_deposito", hours: 48 },
    entry_rules: { ...commonRules, reentry: "per_occurrence" },
    exit_rules: { deposit: true },
    conflict_family: "inatividade_deposito",
    journey_priority: 3,
    conflict_policy: "pause_lower_priority",
    conversion_objective: "reactivation",
    steps: fiveDayLoop(copies.cooling),
  },
  {
    name: "Dormindo — 7 dias sem depósito",
    aliases: ["Dormindo - 7 dias sem deposito"],
    description: "Regua diaria para jogador ha 7 dias sem depositar.",
    trigger_type: "inactivity",
    trigger_config: { field: "ultimo_deposito", hours: 168, start_after: null },
    entry_rules: { ...commonRules, reentry: "per_occurrence" },
    exit_rules: { deposit: true },
    conflict_family: "inatividade_deposito",
    journey_priority: 2,
    conflict_policy: "pause_lower_priority",
    conversion_objective: "reactivation",
    steps: fiveDayLoop(copies.sleeping),
  },
  {
    name: "30 dias sem depósito",
    aliases: ["30 dias sem deposito"],
    description: "Regua diaria de retorno para jogador ha 30 dias sem depositar.",
    trigger_type: "inactivity",
    trigger_config: { field: "ultimo_deposito", hours: 720, start_after: null },
    entry_rules: { ...commonRules, reentry: "per_occurrence" },
    exit_rules: { deposit: true },
    conflict_family: "inatividade_deposito",
    journey_priority: 1,
    conflict_policy: "pause_lower_priority",
    conversion_objective: "reactivation",
    steps: fiveDayLoop(copies.dormant30),
  },
  ...[
    ["Nível Bronze", ["Nivel Bronze"], "bronze", copies.bronze],
    ["Nível Prata", ["Nivel Prata"], "silver", copies.silver],
    ["Nível Ouro", ["Nivel Ouro"], "gold", copies.gold],
    ["Nível Diamante", ["Nivel Diamante"], "diamond", copies.diamond],
    ["Nível Black VIP", ["Nivel Black VIP"], "black", copies.black],
  ].map(([name, aliases, level, messages]) => ({
    name,
    aliases,
    description: `Regua diaria do nivel ${level}; depois do Dia 5 alterna Dias 4 e 5.`,
    trigger_type: "nivel_alterado",
    trigger_config: { level },
    entry_rules: { ...commonRules, reentry: "per_occurrence" },
    exit_rules: { level_changed: true },
    conflict_family: "progressao_niveis",
    journey_priority: 2,
    conflict_policy: "exclusive",
    conversion_objective: "journey",
    steps: fiveDayLoop(messages),
  })),
  {
    name: "Cashback — Reativação Automática",
    aliases: ["Cashback - Reativacao Automatica"],
    description: "SMS D+1 de cashback com prioridade sobre a mensagem VIP do dia.",
    trigger_type: "cashback_pago",
    trigger_config: {},
    entry_rules: { ...commonRules, reentry: "per_occurrence" },
    exit_rules: { deposit: true },
    conflict_family: "cashback_vip",
    journey_priority: 1,
    conflict_policy: "pause_lower_priority",
    conversion_objective: "reactivation",
    steps: [
      wait("Aguardar D+1"),
      sms(copies.cashback[0], "Cashback D+1"),
      { step_type: "end", label: "Fim", config: {} },
    ],
  },
];

function validate() {
  const allMessages = definitions.flatMap((journey) =>
    journey.steps.filter((step) => step.step_type === "sms").map((step) => step.config.content),
  );
  for (const message of allMessages) {
    if (message.length > 160) throw new Error(`SMS com ${message.length} caracteres: ${message}`);
    if (/[^\x00-\x7F]/.test(message)) throw new Error(`SMS contem caractere nao ASCII: ${message}`);
    if ((message.match(/www\.sortealta\.io/g) ?? []).length !== 1)
      throw new Error(`SMS precisa ter exatamente uma URL rastreavel: ${message}`);
  }
  return {
    unique_messages: new Set(Object.values(copies).flat()).size,
    sms_steps: allMessages.length,
    min_length: Math.min(...allMessages.map((message) => message.length)),
    max_length: Math.max(...allMessages.map((message) => message.length)),
  };
}

async function main() {
  const validation = validate();
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL e SUPABASE_SECRET_KEY sao obrigatorias");
  const db = createClient(url, key, { auth: { persistSession: false } });
  const { data: tenant, error: tenantError } = await db
    .from("tenants")
    .select("id,nome,slug")
    .eq("slug", "pixpgf")
    .single();
  if (tenantError) throw tenantError;
  const { data: existing, error: journeysError } = await db
    .from("journeys")
    .select("id,name,status,version,trigger_config")
    .eq("tenant_id", tenant.id);
  if (journeysError) throw journeysError;

  const plans = definitions.map((definition) => {
    const row = existing.find(
      (journey) => journey.name === definition.name || definition.aliases.includes(journey.name),
    );
    return { definition, row };
  });
  const duplicateIds = plans.map(({ row }) => row?.id).filter(Boolean);
  if (new Set(duplicateIds).size !== duplicateIds.length)
    throw new Error("Mais de uma definicao apontou para a mesma jornada");

  const existingIds = plans.map(({ row }) => row?.id).filter(Boolean);
  if (existingIds.length) {
    const { count, error } = await db
      .from("journey_enrollments")
      .select("id", { count: "exact", head: true })
      .in("journey_id", existingIds);
    if (error) throw error;
    if (count)
      throw new Error(`Atualizacao bloqueada: ${count} matricula(s) usam as jornadas alvo`);
  }

  console.log(
    JSON.stringify(
      {
        mode: APPLY ? "apply" : "dry-run",
        tenant,
        validation,
        journeys: plans.map(({ definition, row }) => ({
          name: definition.name,
          action: row ? "update" : "insert",
          previous_name: row?.name ?? null,
          status: row?.status ?? "draft",
          sms_steps: definition.steps.filter((step) => step.step_type === "sms").length,
          loop: definition.steps.some((step) => step.config.loop_to_position != null),
        })),
      },
      null,
      2,
    ),
  );
  if (!APPLY) return;

  for (const { definition, row } of plans) {
    const overridesStartAfter = Object.hasOwn(definition.trigger_config, "start_after");
    const triggerConfig = {
      ...definition.trigger_config,
      ...(!overridesStartAfter && row?.trigger_config?.start_after
        ? { start_after: row.trigger_config.start_after }
        : {}),
    };
    if (triggerConfig.start_after === null) delete triggerConfig.start_after;
    const journeyData = {
      tenant_id: tenant.id,
      name: definition.name,
      description: definition.description,
      trigger_type: definition.trigger_type,
      trigger_config: triggerConfig,
      entry_rules: definition.entry_rules,
      exit_rules: definition.exit_rules,
      timezone: "America/Sao_Paulo",
      daily_limit: 1000,
      cooldown_hours: 0,
      conflict_family: definition.conflict_family,
      journey_priority: definition.journey_priority,
      conflict_policy: definition.conflict_policy,
      conversion_objective: definition.conversion_objective,
      published_version: null,
    };
    let journeyId;
    if (row) {
      const { error } = await db
        .from("journeys")
        .update({ ...journeyData, version: row.version + 1 })
        .eq("id", row.id)
        .eq("tenant_id", tenant.id);
      if (error) throw new Error(`${definition.name}: ${error.message}`);
      journeyId = row.id;
      const { error: deleteError } = await db
        .from("journey_steps")
        .delete()
        .eq("journey_id", journeyId)
        .eq("tenant_id", tenant.id);
      if (deleteError) throw new Error(`${definition.name}: ${deleteError.message}`);
    } else {
      const { data: inserted, error } = await db
        .from("journeys")
        .insert({ ...journeyData, status: "draft" })
        .select("id")
        .single();
      if (error) throw new Error(`${definition.name}: ${error.message}`);
      journeyId = inserted.id;
    }
    const stepRows = definition.steps.map((step, position) => ({
      tenant_id: tenant.id,
      journey_id: journeyId,
      position,
      step_type: step.step_type,
      label: step.label,
      config: step.config,
    }));
    const { error: stepError } = await db.from("journey_steps").insert(stepRows);
    if (stepError) throw new Error(`${definition.name}: ${stepError.message}`);
    const { error: eventError } = await db.from("journey_events").insert({
      tenant_id: tenant.id,
      journey_id: journeyId,
      event_type: "crm_copy_synced",
      detail: {
        source: "FLUXO CRM.docx",
        sms_steps: stepRows.filter((step) => step.step_type === "sms").length,
        url: URL,
        ascii: true,
        max_characters: 160,
      },
    });
    if (eventError) throw new Error(`${definition.name}: ${eventError.message}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
