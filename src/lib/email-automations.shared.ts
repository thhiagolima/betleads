// Tipos e helpers compartilhados (cliente + servidor) para o construtor
// visual de automacoes de email. Os gatilhos sao os 17 reais definidos em
// `src/lib/triggers.ts` (mesma lista usada em SMS/WhatsApp/Ligacoes).
import { TRIGGER_NAMES, type TriggerType } from "./triggers";

export type EmailFlowBlockType =
  | "start"
  | "send_email"
  | "delay"
  | "condition"
  | "tag"
  | "remove"
  | "end";

export type EmailFlowBlockDraft = {
  id: string; // client-only uuid p/ react keys
  block_type: EmailFlowBlockType;
  template_ids: string[];
  sender_id: string | null;
  smtp_config_id: string | null;
  subject_override: string | null;
  preheader_override: string | null;
  pre_delay_seconds: number;
  delay_seconds: number;
  condition_type: string | null;
  condition_value: string | null;
  label: string | null;
};

export type EmailTrigger = TriggerType;

export const EMAIL_TRIGGERS = (Object.entries(TRIGGER_NAMES) as Array<[TriggerType, string]>).map(
  ([value, label]) => ({ value, label }),
);

export const EMAIL_EXIT_CONDITIONS = [
  { value: "login", label: "Login" },
  { value: "deposit", label: "Depósito" },
  { value: "first_deposit", label: "Primeiro depósito" },
  { value: "bet", label: "Aposta" },
  { value: "reply", label: "Resposta" },
  { value: "human_takeover", label: "Handoff humano" },
  { value: "became_vip", label: "Virou VIP" },
  { value: "left_risk_group", label: "Saiu do grupo de risco" },
  { value: "manual", label: "Manual" },
] as const;

function uid() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

export function emptyBlock(type: EmailFlowBlockType): EmailFlowBlockDraft {
  return {
    id: uid(),
    block_type: type,
    template_ids: [],
    sender_id: null,
    smtp_config_id: null,
    subject_override: null,
    preheader_override: null,
    pre_delay_seconds: 0,
    delay_seconds: type === "delay" ? 86400 : 0,
    condition_type: null,
    condition_value: null,
    label: null,
  };
}

export function defaultExitConditions(): Record<string, boolean> {
  return {
    login: false,
    deposit: true,
    first_deposit: true,
    bet: false,
    reply: false,
    human_takeover: true,
    became_vip: false,
    left_risk_group: false,
    manual: false,
  };
}

export function triggerLabel(t: string): string {
  return (TRIGGER_NAMES as Record<string, string>)[t] ?? t;
}

export function formatDelay(seconds: number): string {
  if (seconds <= 0) return "imediato";
  const d = Math.floor(seconds / 86400);
  if (d >= 1 && seconds % 86400 === 0) return `${d} dia${d > 1 ? "s" : ""}`;
  const h = Math.floor(seconds / 3600);
  if (h >= 1 && seconds % 3600 === 0) return `${h} h`;
  const m = Math.floor(seconds / 60);
  if (m >= 1) return `${m} min`;
  return `${seconds} s`;
}