import { z } from "zod";

export const journeyStatusSchema = z.enum(["draft", "active", "paused", "archived"]);
export const journeyStepTypeSchema = z.enum([
  "wait",
  "sms",
  "email",
  "voice",
  "condition",
  "split",
  "update_player",
  "end",
]);

const waitConfigSchema = z.object({
  delay_seconds: z
    .number()
    .int()
    .min(60)
    .max(365 * 24 * 60 * 60),
});
const smsConfigSchema = z.object({
  content: z.string().trim().min(1).max(1600),
  sender: z.string().trim().max(30).optional(),
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
});
const voiceConfigSchema = z.object({
  asset_id: z.string().uuid(),
  caller_id: z.string().regex(/^\d{10,15}$/),
  max_attempts: z.number().int().min(1).max(5).default(1),
  retry_delay_seconds: z
    .number()
    .int()
    .min(300)
    .max(30 * 24 * 60 * 60)
    .default(86400),
});

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
    step_type: z.literal("condition"),
    label: z.string().trim().max(120).optional(),
    config: z.record(z.string(), z.unknown()),
  }),
  z.object({
    step_type: z.literal("split"),
    label: z.string().trim().max(120).optional(),
    config: z.record(z.string(), z.unknown()),
  }),
  z.object({
    step_type: z.literal("update_player"),
    label: z.string().trim().max(120).optional(),
    config: z.record(z.string(), z.unknown()),
  }),
  z.object({
    step_type: z.literal("end"),
    label: z.string().trim().max(120).optional(),
    config: z.object({}),
  }),
]);

export const journeyInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
  trigger_type: z.string().trim().min(1).max(80).default("manual"),
  trigger_config: z.record(z.string(), z.unknown()).default({}),
  entry_rules: z.record(z.string(), z.unknown()).default({}),
  exit_rules: z.record(z.string(), z.unknown()).default({}),
  daily_limit: z.number().int().min(1).max(100000).default(1000),
  cooldown_hours: z.number().int().min(0).max(720).default(72),
  steps: z.array(journeyStepInputSchema).min(1).max(100),
});

export type JourneyInput = z.infer<typeof journeyInputSchema>;
export type JourneyStepInput = z.infer<typeof journeyStepInputSchema>;
