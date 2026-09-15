// Server functions para fluxos de SMS — persistência no banco.

import { createServerFn } from "@tanstack/react-start";
import { dbUuid } from "@/lib/zod-helpers";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const EtapaSchema = z.discriminatedUnion("tipo", [
  z.object({ tipo: z.literal("sms"), mensagem: z.string().default("") }),
  z.object({ tipo: z.literal("delay"), dias: z.number().int().min(0).max(365) }),
]);

const FluxoInputSchema = z.object({
  id: dbUuid().optional(),
  nome: z.string().min(1).max(160),
  gatilho: z.string().max(120).nullable().optional(),
  status: z.enum(["ativo", "inativo"]).default("inativo"),
  etapas: z.array(EtapaSchema).default([]),
  saida: z.array(z.string()).default([]),
});

// === Mapeamento UI <-> banco para condições de saída ===
// UI usa rótulos em português; o motor (sms-dispatcher) lê chaves booleanas.
const SAIDA_LABEL_TO_KEY: Record<string, "login" | "deposit" | "first_deposit" | "voltou_jogar"> = {
  "se fizer login": "login",
  "se depositar": "deposit",
  "se fizer primeiro depósito": "first_deposit",
  "se fizer primeiro deposito": "first_deposit",
  "se voltar a jogar": "voltou_jogar",
};
const SAIDA_KEY_TO_LABEL: Record<string, string> = {
  login: "se fizer login",
  deposit: "se depositar",
  first_deposit: "se fizer primeiro depósito",
  voltou_jogar: "se voltar a jogar",
  bet: "se voltar a jogar",
};

function saidaArrayToObject(saida: string[]): Record<string, boolean> {
  const obj: Record<string, boolean> = {
    login: false,
    deposit: false,
    first_deposit: false,
    voltou_jogar: false,
  };
  for (const raw of saida ?? []) {
    const k = SAIDA_LABEL_TO_KEY[(raw ?? "").toString().trim().toLowerCase()];
    if (k) obj[k] = true;
  }
  return obj;
}

function exitConditionsToSaida(ec: unknown): string[] {
  // formato novo: objeto com booleans
  if (ec && typeof ec === "object" && !Array.isArray(ec)) {
    const out: string[] = [];
    for (const [k, v] of Object.entries(ec as Record<string, unknown>)) {
      if (v === true && SAIDA_KEY_TO_LABEL[k] && !out.includes(SAIDA_KEY_TO_LABEL[k])) {
        out.push(SAIDA_KEY_TO_LABEL[k]);
      }
    }
    return out;
  }
  // formato legado: array de rótulos
  if (Array.isArray(ec)) {
    return (ec as unknown[]).filter((s): s is string => typeof s === "string");
  }
  return [];
}

type FluxoOut = {
  id: string;
  nome: string;
  status: "ativo" | "inativo";
  gatilho: string;
  etapas: Array<
    | { tipo: "sms"; mensagem: string }
    | { tipo: "delay"; dias: number }
  >;
  saida: string[];
  players: number;
  enviados: number;
  conversoes: number;
  atualizadoEm: string;
};

function rowToFluxo(flow: any, steps: any[]): FluxoOut {
  return {
    id: flow.id,
    nome: flow.name,
    status: flow.is_active ? "ativo" : "inativo",
    gatilho: flow.trigger_name ?? "",
    etapas: steps
      .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))
      .map((s) =>
        s.step_type === "delay"
          ? { tipo: "delay" as const, dias: s.delay_days ?? 0 }
          : { tipo: "sms" as const, mensagem: s.content ?? "" },
      ),
    saida: exitConditionsToSaida(flow.exit_conditions),
    players: 0,
    enviados: 0,
    conversoes: 0,
    atualizadoEm: new Date(flow.updated_at ?? flow.created_at).toLocaleString("pt-BR"),
  };
}

export const listSmsFlows = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data: flows, error } = await supabase
      .from("sms_flows")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    const ids = (flows ?? []).map((f: any) => f.id);
    let stepsByFlow: Record<string, any[]> = {};
    if (ids.length) {
      const { data: steps, error: sErr } = await supabase
        .from("sms_flow_steps")
        .select("*")
        .in("flow_id", ids);
      if (sErr) throw new Error(sErr.message);
      stepsByFlow = (steps ?? []).reduce((acc: any, s: any) => {
        (acc[s.flow_id] ??= []).push(s);
        return acc;
      }, {});
    }
    return {
      fluxos: (flows ?? []).map((f: any) => rowToFluxo(f, stepsByFlow[f.id] ?? [])),
    };
  });

export const saveSmsFlow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => FluxoInputSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    console.log("[saveSmsFlow] start", { userId, hasId: !!data.id, nome: data.nome, etapas: data.etapas.length });
    const payload = {
      name: data.nome,
      trigger_name: data.gatilho || null,
      is_active: data.status === "ativo",
      exit_conditions: saidaArrayToObject(data.saida),
    };

    let flowId = data.id;
    if (flowId) {
      const { data: upd, error, count } = await supabase
        .from("sms_flows")
        .update(payload, { count: "exact" })
        .eq("id", flowId)
        .select("id");
      console.log("[saveSmsFlow] update flow", { flowId, count, rows: upd?.length, error });
      if (error) throw new Error(`UPDATE sms_flows: ${error.message} (code=${error.code})`);
      if (!upd || upd.length === 0) {
        throw new Error(`UPDATE sms_flows afetou 0 linhas (RLS bloqueou ou id inexistente: ${flowId})`);
      }
      const { error: dErr } = await supabase
        .from("sms_flow_steps")
        .delete()
        .eq("flow_id", flowId);
      if (dErr) throw new Error(`DELETE sms_flow_steps: ${dErr.message} (code=${dErr.code})`);
    } else {
      const { data: created, error } = await supabase
        .from("sms_flows")
        .insert(payload)
        .select("id")
        .maybeSingle();
      console.log("[saveSmsFlow] insert flow", { created, error });
      if (error) throw new Error(`INSERT sms_flows: ${error.message} (code=${error.code})`);
      if (!created?.id) {
        throw new Error(
          "INSERT sms_flows retornou sem id — provavelmente bloqueado por RLS (usuário não é admin?)",
        );
      }
      flowId = created.id;
    }

    if (data.etapas.length) {
      const rows = data.etapas.map((e, idx) =>
        e.tipo === "delay"
          ? {
              flow_id: flowId!,
              order_index: idx,
              step_type: "delay",
              delay_days: e.dias,
              content: null,
            }
          : {
              flow_id: flowId!,
              order_index: idx,
              step_type: "sms",
              content: e.mensagem,
              delay_days: 0,
            },
      );
      const { data: insSteps, error } = await supabase
        .from("sms_flow_steps")
        .insert(rows)
        .select("id");
      console.log("[saveSmsFlow] insert steps", { flowId, requested: rows.length, inserted: insSteps?.length, error });
      if (error) throw new Error(`INSERT sms_flow_steps: ${error.message} (code=${error.code})`);
      if (!insSteps || insSteps.length !== rows.length) {
        throw new Error(
          `INSERT sms_flow_steps inseriu ${insSteps?.length ?? 0}/${rows.length} linhas — RLS bloqueou?`,
        );
      }
    }

    console.log("[saveSmsFlow] done", { flowId });
    return { id: flowId };
  });

export const toggleSmsFlow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z.object({ id: dbUuid(), is_active: z.boolean() }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("sms_flows")
      .update({ is_active: data.is_active })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const duplicateSmsFlow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => z.object({ id: dbUuid() }).parse(data))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: orig, error: oErr } = await supabase
      .from("sms_flows")
      .select("*")
      .eq("id", data.id)
      .single();
    if (oErr) throw new Error(oErr.message);
    const { data: steps, error: sErr } = await supabase
      .from("sms_flow_steps")
      .select("*")
      .eq("flow_id", data.id);
    if (sErr) throw new Error(sErr.message);

    const { data: created, error: cErr } = await supabase
      .from("sms_flows")
      .insert({
        name: `${orig.name} (cópia)`,
        trigger_name: orig.trigger_name,
        is_active: false,
        randomize_templates: orig.randomize_templates,
        exit_conditions: orig.exit_conditions ?? [],
      })
      .select("id")
      .single();
    if (cErr) throw new Error(cErr.message);

    if (steps?.length) {
      const rows = steps.map((s: any) => ({
        flow_id: created.id,
        order_index: s.order_index,
        step_type: s.step_type,
        content: s.content,
        delay_days: s.delay_days,
        is_active: s.is_active,
      }));
      const { error } = await supabase.from("sms_flow_steps").insert(rows);
      if (error) throw new Error(error.message);
    }
    return { id: created.id };
  });

export const deleteSmsFlow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => z.object({ id: dbUuid() }).parse(data))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("sms_flows")
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });