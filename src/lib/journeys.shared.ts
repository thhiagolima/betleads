import { z } from "zod";

export const journeyStatusSchema = z.enum(["draft", "active", "paused", "archived"]);
export const journeyStepTypeSchema = z.enum(["wait", "sms", "email", "voice", "end"]);

const waitConfigSchema = z.object({
  delay_seconds: z
    .number()
    .int()
    .min(60)
    .max(365 * 24 * 60 * 60),
});
const smsConfigSchema = z.object({
  content: z.string().trim().min(1).max(1600),
  // D-8: each send picks one variation (deterministic per occurrence).
  variants: z.array(z.string().trim().min(1).max(1600)).max(20).optional(),
  track_links: z.boolean().optional(),
  sender: z.string().trim().max(30).optional(),
  /** tenant_domains shortener; unverified/removed falls back at send time. */
  short_domain_id: z.string().uuid().nullable().optional(),
  template_id: z.string().uuid().optional(),
  template_snapshot: z
    .object({
      id: z.string().uuid(),
      name: z.string().trim().max(160).optional(),
      content: z.string().trim().min(1).max(1600),
      version: z.number().int().positive().optional(),
    })
    .optional(),
});
const emailConfigSchema = z.object({
  template_id: z.string().uuid(),
  sender_id: z.string().uuid().optional(),
  /** tenant_domains shortener; unverified/removed falls back at send time. */
  short_domain_id: z.string().uuid().nullable().optional(),
  template_snapshot: z
    .object({
      id: z.string().uuid(),
      subject: z.string().max(255),
      body_html: z.string(),
      version: z.number().int().positive().optional(),
    })
    .optional(),
});
const voiceConfigSchema = z.object({
  asset_id: z.string().uuid(),
  // Not used for sending (calls go out through the platform's voice number); kept
  // optional so steps saved with a number keep it.
  caller_id: z
    .string()
    .regex(/^\d{10,15}$/)
    .optional(),
  max_attempts: z.number().int().min(1).max(5).default(1),
  retry_delay_seconds: z
    .number()
    .int()
    .min(300)
    .max(30 * 24 * 60 * 60)
    .default(86400),
});

/** Upper bound for an end step's `max_loops`: there is no "repeat forever". */
export const MAX_LOOPS_LIMIT = 50;

export const journeyStepInputSchema = z.discriminatedUnion("step_type", [
  z.object({
    step_type: z.literal("wait"),
    label: z.string().trim().max(120).optional(),
    config: waitConfigSchema,
  }),
  z.object({
    step_type: z.literal("sms"),
    label: z.string().trim().max(120).optional(),
    config: smsConfigSchema,
  }),
  z.object({
    step_type: z.literal("email"),
    label: z.string().trim().max(120).optional(),
    config: emailConfigSchema,
  }),
  z.object({
    step_type: z.literal("voice"),
    label: z.string().trim().max(120).optional(),
    config: voiceConfigSchema,
  }),
  z.object({
    step_type: z.literal("end"),
    label: z.string().trim().max(120).optional(),
    config: z.object({
      loop_to_position: z.number().int().min(0).optional(),
      max_loops: z.number().int().min(0).max(MAX_LOOPS_LIMIT).optional(),
    }),
  }),
]);

/**
 * Repetitions of a journey's loop per enrollment when the end step does not
 * say otherwise. Loops used to run forever: a player who never deposits got
 * the "Cadastrou e não depositou" tail every 48 h indefinitely (P0.2b,
 * docs/ESCOPO_AUDITORIA_JORNADAS_CUSTO_RECUPERACAO_2026-10-29.md).
 */
export const DEFAULT_MAX_LOOPS = 2;

/** How many times an end step sends the enrollment back to its loop target. */
export function endStepMaxLoops(config: Record<string, unknown> | null | undefined): number {
  const value = Number(config?.max_loops);
  return Number.isInteger(value) && value >= 0 && value <= MAX_LOOPS_LIMIT
    ? value
    : DEFAULT_MAX_LOOPS;
}

export const journeyInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
  trigger_type: z.string().trim().min(1).max(80).default("manual"),
  trigger_config: z.record(z.string(), z.unknown()).default({}),
  entry_rules: z.record(z.string(), z.unknown()).default({}),
  exit_rules: z.record(z.string(), z.unknown()).default({}),
  daily_limit: z.number().int().min(1).max(100000).default(1000),
  cooldown_hours: z.number().int().min(0).max(720).default(72),
  conflict_family: z.string().trim().max(80).nullable().optional().default(null),
  journey_priority: z.number().int().min(1).max(100).default(4),
  conflict_policy: z.enum(["coexist", "pause_lower_priority", "exclusive"]).default("coexist"),
  // D-4: optional end of the journey; loops keep running when absent.
  ends_at: z.string().datetime({ offset: true }).nullable().optional().default(null),
  // F3: share of entering players kept as a control group (no messages).
  holdout_percent: z.number().int().min(0).max(50).optional().default(0),
  conversion_objective: z
    .enum(["acquisition", "conversion", "reactivation", "journey"])
    .default("journey"),
  steps: z.array(journeyStepInputSchema).min(1).max(100),
});

export type JourneyInput = z.infer<typeof journeyInputSchema>;
export type JourneyStepInput = z.infer<typeof journeyStepInputSchema>;

/**
 * Sender of a legacy e-mail flow block converted into a journey step: the
 * block's email_senders row. The legacy smtp_config_id (email_smtp_configs)
 * is never copied — saveJourney would reject it as a sender of the house.
 */
export function legacyEmailBlockSenderConfig(block: { sender_id?: string | null }): {
  sender_id?: string;
} {
  return block.sender_id ? { sender_id: block.sender_id } : {};
}
