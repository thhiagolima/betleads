/* eslint-disable @typescript-eslint/no-explicit-any -- journey columns precede generated Supabase types. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { describePlayerJourneys, type PlayerEnrollment } from "./player-journeys";
import { resolveOperationalTenantId } from "./tenant-access.server";

const ACCEPTED_SMS = ["sent", "delivered", "enviado", "entregue"];

/**
 * Journeys of one player (P3): current journeys with step, next send and why
 * they are paused, recent exits in plain language, and messages received in
 * the last 7 days against the per-player limit.
 */
export const getPlayerJourneys = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => z.object({ playerId: z.string().uuid() }).parse(value))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const db = context.supabase as any;
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();

    const { data: enrollments, error } = await db
      .from("journey_enrollments")
      .select(
        "id,journey_id,status,current_position,next_run_at,entered_at,exited_at,completed_at,exit_reason,is_holdout,priority_paused_by_journey_id,loop_iteration",
      )
      .eq("tenant_id", tenantId)
      .eq("player_id", data.playerId)
      .order("entered_at", { ascending: false })
      .limit(40);
    if (error) throw new Error("Não foi possível carregar as jornadas do jogador.");
    const rows = (enrollments ?? []) as PlayerEnrollment[];

    const journeyIds = [
      ...new Set(
        rows.flatMap((row) =>
          [row.journey_id, row.priority_paused_by_journey_id].filter(Boolean),
        ) as string[],
      ),
    ];
    const [journeysResult, stepsResult, smsResult, limitsResult] = await Promise.all([
      journeyIds.length
        ? db.from("journeys").select("id,name").eq("tenant_id", tenantId).in("id", journeyIds)
        : { data: [] },
      journeyIds.length
        ? db
            .from("journey_steps")
            .select("journey_id,position,step_type")
            .in("journey_id", journeyIds)
            .eq("is_enabled", true)
            .in("step_type", ["sms", "email", "voice"])
        : { data: [] },
      db
        .from("sms_send_logs")
        .select("trigger_name,created_at")
        .eq("tenant_id", tenantId)
        .eq("player_id", data.playerId)
        .in("status", ACCEPTED_SMS)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(200),
      db
        .from("journey_contact_limits")
        .select("max_messages_24h,max_messages_7d")
        .eq("tenant_id", tenantId)
        .maybeSingle(),
    ]);

    const journeys: Record<string, { name: string; sendPositions: number[] }> = {};
    for (const journey of (journeysResult.data ?? []) as Array<{ id: string; name: string }>)
      journeys[journey.id] = { name: journey.name, sendPositions: [] };
    for (const step of (stepsResult.data ?? []) as Array<{ journey_id: string; position: number }>)
      journeys[step.journey_id]?.sendPositions.push(step.position);
    for (const journey of Object.values(journeys)) journey.sendPositions.sort((a, b) => a - b);

    const sms = (smsResult.data ?? []) as Array<{
      trigger_name: string | null;
      created_at: string;
    }>;
    const dayAgo = Date.now() - 86_400_000;
    const origin = (trigger: string | null) => {
      const value = trigger ?? "";
      if (value.startsWith("journey:")) return journeys[value.slice(8)]?.name ?? "Jornada";
      if (value.startsWith("campanha:"))
        return `Campanha ${value.replace(/^campanha:(.*):[^:]*$/, "$1")}`;
      return value.split(":")[0] || "Outro";
    };
    const byOrigin = new Map<string, number>();
    for (const message of sms)
      byOrigin.set(
        origin(message.trigger_name),
        (byOrigin.get(origin(message.trigger_name)) ?? 0) + 1,
      );

    return {
      journeys: describePlayerJourneys(rows, journeys),
      messages: {
        last24h: sms.filter((message) => Date.parse(message.created_at) >= dayAgo).length,
        last7d: sms.length,
        limit24h: limitsResult.data?.max_messages_24h ?? null,
        limit7d: limitsResult.data?.max_messages_7d ?? null,
        byOrigin: [...byOrigin.entries()]
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count),
        lastAt: sms[0]?.created_at ?? null,
      },
    };
  });
