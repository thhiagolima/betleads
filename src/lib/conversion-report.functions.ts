/* eslint-disable @typescript-eslint/no-explicit-any -- conversion tables await generated DB types. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resolveOperationalTenantId } from "./tenant-access.server";
import {
  buildJourneyStepConversions,
  canAccessConversionDrilldown,
  journeyStepPositionRanges,
  uniqueDeliveryCount,
} from "./conversion-report";
import { smsVariants } from "./journey-policy";
import {
  buildUnresolvedRecipientsCsv,
  countUnresolvedByReason,
  maskPhone,
  parseUnresolvedRecipients,
  type UnresolvedReason,
  type UnresolvedRecipient,
} from "./campaign-recipients";
import { isMissingColumnError } from "./campaign-recipients.server";

// `.in(column, ids)` travels in the GET URL: a journey with ~1.8k dispatches
// produced a ~65 KB URL and the gateway answered "Bad Request". Query in small
// chunks until REP-01 moves these counts into SQL aggregates.
const IN_CHUNK_SIZE = 100;
const IN_CHUNK_CONCURRENCY = 4;

type ChunkResult<T> = { data: T[] | null; error: { message: string } | null };

async function selectInChunks<T>(
  ids: readonly unknown[],
  run: (chunk: string[]) => PromiseLike<ChunkResult<T>>,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const unique = [...new Set(ids.filter((id) => id != null && id !== "").map(String))];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += IN_CHUNK_SIZE) {
    chunks.push(unique.slice(i, i + IN_CHUNK_SIZE));
  }
  const rows: T[] = [];
  for (let i = 0; i < chunks.length; i += IN_CHUNK_CONCURRENCY) {
    const results = await Promise.all(chunks.slice(i, i + IN_CHUNK_CONCURRENCY).map(run));
    for (const result of results) {
      if (result.error) return { data: rows, error: result.error };
      rows.push(...(result.data ?? []));
    }
  }
  return { data: rows, error: null };
}

// PostgREST caps every response at `max_rows` (1000 on Supabase) without an
// error. Large journeys exceed it (~1.7k dispatches, ~3.7k executions), which
// silently dropped rows from the per-step metrics. Page by keyset on `id`
// (stable under concurrent inserts, unlike OFFSET) up to a hard ceiling.
const PAGE_SIZE = 1000;
const MAX_PAGES = 100;

type PagedResult<T> = { data: T[]; error: { message: string } | null; truncated: boolean };

async function selectAllPages<T extends { id: string }>(
  label: string,
  build: () => any,
): Promise<PagedResult<T>> {
  const rows: T[] = [];
  let lastId: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let query = build();
    if (lastId) query = query.gt("id", lastId);
    const result: ChunkResult<T> = await query.order("id", { ascending: true }).limit(PAGE_SIZE);
    if (result.error) return { data: rows, error: result.error, truncated: false };
    const data = result.data ?? [];
    rows.push(...data);
    if (data.length < PAGE_SIZE) return { data: rows, error: null, truncated: false };
    lastId = String(data[data.length - 1].id);
  }
  console.warn(
    `[conversion-report] ${label}: stopped after ${MAX_PAGES * PAGE_SIZE} rows; report truncated.`,
  );
  return { data: rows, error: null, truncated: true };
}

const UNFINISHED_ENROLLMENT_STATUSES = ["active", "waiting", "paused_by_priority"];

function byOccurredAt(a: { occurred_at?: string | null }, b: { occurred_at?: string | null }) {
  return String(a.occurred_at ?? "").localeCompare(String(b.occurred_at ?? ""));
}

const inputSchema = z.object({
  sourceType: z.enum(["campaign", "journey"]),
  sourceId: z.string().uuid(),
});

async function hasConversionReportAdmin(context: any, tenantId: string) {
  const db = context.supabase as any;
  const { data: superAdmin, error: superAdminError } = await db.rpc("is_super_admin", {
    _user_id: context.userId,
  });
  if (superAdminError) throw new Error("Não foi possível validar a permissão.");
  if (superAdmin) return true;
  const { data: membership, error } = await db
    .from("user_roles")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", context.userId)
    .maybeSingle();
  if (error) throw new Error("Não foi possível validar a permissão.");
  return canAccessConversionDrilldown(membership?.role ?? null, false);
}

async function requireConversionReportAdmin(context: any, tenantId: string) {
  if (!(await hasConversionReportAdmin(context, tenantId)))
    throw new Error("Acesso restrito a administradores.");
}

const drilldownSchema = inputSchema.extend({
  limit: z.number().int().min(1).max(500).default(100),
});

const campaignDetailsSchema = z.object({
  campaignId: z.string().uuid(),
  limit: z.number().int().min(1).max(500).default(500),
});

const journeyDetailsSchema = z.object({ journeyId: z.string().uuid() });

const csvCell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;

/**
 * ENV-06 — recipients of an SMS campaign that were not sent (no player, invalid
 * phone, revoked consent). Reads through the caller's RLS-scoped client and
 * tolerates the columns not being deployed yet.
 */
async function loadCampaignUnresolved(
  db: any,
  tenantId: string,
  campaignId: string,
): Promise<{
  total: number;
  byReason: Record<UnresolvedReason, number>;
  sample: UnresolvedRecipient[];
  all: UnresolvedRecipient[];
  available: boolean;
}> {
  const { data, error } = await db
    .from("sms_campaigns")
    .select("unresolved_count,unresolved_recipients")
    .eq("tenant_id", tenantId)
    .eq("id", campaignId)
    .maybeSingle();
  if (error) {
    if (!isMissingColumnError(error)) throw new Error(error.message);
    return {
      total: 0,
      byReason: countUnresolvedByReason([]),
      sample: [],
      all: [],
      available: false,
    };
  }
  const all = parseUnresolvedRecipients(data?.unresolved_recipients);
  return {
    total: Math.max(Number(data?.unresolved_count ?? 0), all.length),
    byReason: countUnresolvedByReason(all),
    sample: all.slice(0, 50),
    all,
    available: true,
  };
}

export const getJourneyReportDetails = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => journeyDetailsSchema.parse(value))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    // The journey aggregate RPCs are intentionally restricted to service_role.
    // Tenant access is validated above using the authenticated request; every
    // elevated query below remains explicitly scoped to that tenant.
    const db = supabaseAdmin as any;
    const enteredSince = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
    const [journeyResult, stepsResult, metricsResult, enteredResult, executionsResult] =
      await Promise.all([
        db
          .from("journeys")
          .select("id,name,description,status,trigger_type,trigger_config,created_at,updated_at")
          .eq("tenant_id", tenantId)
          .eq("id", data.journeyId)
          .maybeSingle(),
        db
          .from("journey_steps")
          .select("id,position,step_type,label,config,is_enabled")
          .eq("tenant_id", tenantId)
          .eq("journey_id", data.journeyId)
          .eq("is_enabled", true)
          .order("position"),
        db.rpc("journey_metrics", {
          p_tenant_id: tenantId,
          p_journey_id: data.journeyId,
        }),
        db
          .from("journey_enrollments")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId)
          .eq("journey_id", data.journeyId)
          .gte("created_at", enteredSince),
        selectAllPages<any>("journey_step_executions", () =>
          db
            .from("journey_step_executions")
            .select("id,step_id,status,executed_at,completed_at,updated_at,created_at")
            .eq("tenant_id", tenantId)
            .eq("journey_id", data.journeyId),
        ),
      ]);
    const error = [
      journeyResult.error,
      stepsResult.error,
      metricsResult.error,
      enteredResult.error,
      executionsResult.error,
    ].find(Boolean);
    if (error) throw new Error(error.message);
    if (!journeyResult.data) return { journey: null, steps: [], metrics: null };

    // "Neste degrau agora": unfinished enrollments positioned on the step or on
    // the waits leading to it. Counted in SQL (head) - no row transfer.
    const ranges = journeyStepPositionRanges(stepsResult.data ?? []);
    const currentCounts = await Promise.all(
      ranges.map((range) =>
        db
          .from("journey_enrollments")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId)
          .eq("journey_id", data.journeyId)
          .in("status", UNFINISHED_ENROLLMENT_STATUSES)
          .gte("current_position", range.from)
          .lte("current_position", range.to),
      ),
    );
    const currentError = currentCounts.map((result: any) => result.error).find(Boolean);
    if (currentError) throw new Error(currentError.message);
    const currentByStep = new Map<string, number>(
      ranges.map((range, index) => [range.stepId, Number(currentCounts[index]?.count ?? 0)]),
    );

    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60_000;
    const executionsByStep = new Map<string, any[]>();
    for (const execution of executionsResult.data ?? []) {
      const group = executionsByStep.get(execution.step_id) ?? [];
      group.push(execution);
      executionsByStep.set(execution.step_id, group);
    }
    const steps = (stepsResult.data ?? []).map((step: any) => {
      if (step.step_type === "wait" || step.step_type === "end")
        return { ...step, current: 0, queued: 0, sent: 0, sent7d: 0, failed: 0 };
      const executions = executionsByStep.get(step.id) ?? [];
      const queued = executions.filter((execution) =>
        ["pending", "claimed", "retrying"].includes(execution.status),
      ).length;
      const sentExecutions = executions.filter((execution) =>
        ["sent", "delivered"].includes(execution.status),
      );
      const sent = sentExecutions.length;
      const failed = executions.filter((execution) =>
        ["failed", "cancelled"].includes(execution.status),
      ).length;
      const sent7d = sentExecutions.filter((execution) => {
        // The dispatcher fills `completed_at` and may leave `executed_at` null.
        const terminalAt =
          execution.executed_at ??
          execution.completed_at ??
          execution.updated_at ??
          execution.created_at ??
          null;
        return terminalAt && new Date(terminalAt).getTime() >= sevenDaysAgo;
      }).length;
      const current = currentByStep.get(step.id) ?? 0;
      return { ...step, current, queued, sent, sent7d, failed };
    });
    const aggregate = metricsResult.data ?? {};
    return {
      journey: journeyResult.data,
      steps,
      metrics: {
        ...aggregate,
        entered7d: Number(enteredResult.count ?? 0),
        truncated: Boolean(executionsResult.truncated),
        inProgress:
          Number(aggregate.byStatus?.active ?? 0) +
          Number(aggregate.byStatus?.waiting ?? 0) +
          Number(aggregate.byStatus?.paused_by_priority ?? 0),
      },
    };
  });

/**
 * Operational detail used by the campaign report. Link dispatches are grouped by
 * idempotency key because a message may contain more than one tracked URL.
 */
export const getCampaignReportDetails = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => campaignDetailsSchema.parse(value))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const db = context.supabase as any;

    const [smsResult, emailResult, voiceResult, dispatchResult] = await Promise.all([
      db
        .from("sms_campaigns")
        .select(
          "id,name,content,route,status,total_count,sent_count,deduplicated_count,failed_count,scheduled_at,created_at,updated_at,recipients,last_error",
        )
        .eq("tenant_id", tenantId)
        .eq("id", data.campaignId)
        .maybeSingle(),
      db
        .from("email_campaigns")
        .select(
          "id,name,status,stats,scheduled_at,created_at,updated_at,template_snapshot,audience_filter",
        )
        .eq("tenant_id", tenantId)
        .eq("id", data.campaignId)
        .maybeSingle(),
      db
        .from("call_queue")
        .select(
          "id,lead_id,script_id,voice_asset_id,trigger_name,status,provider_status,phone_number,scheduled_at,created_at,updated_at,attempts,provider_response",
        )
        .eq("tenant_id", tenantId)
        .eq("id", data.campaignId)
        .maybeSingle(),
      db
        .from("link_dispatches")
        .select(
          "id,tracked_link_id,tracking_token,idempotency_key,recipient_player_id,send_status,delivery_status,sent_at,delivered_at,created_at,updated_at,message_log_id,channel",
        )
        .eq("tenant_id", tenantId)
        .eq("source_type", "campaign")
        .eq("source_id", data.campaignId)
        .order("created_at", { ascending: true })
        .limit(Math.min(data.limit * 4, 2000)),
    ]);
    if (dispatchResult.error) throw new Error(dispatchResult.error.message);
    const sourceError = [smsResult.error, emailResult.error, voiceResult.error].find(Boolean);
    if (sourceError) throw new Error(sourceError.message);

    const sms = smsResult.data;
    const email = emailResult.data;
    const voice = voiceResult.data;
    const [voiceHistoryResult, voicePlayerResult, voiceScriptResult, voiceAssetResult] = voice
      ? await Promise.all([
          db
            .from("call_history")
            .select(
              "id,status,result,duration_seconds,created_at,error_message,provider,provider_call_id,to_phone,provider_status_code,provider_response",
            )
            .eq("tenant_id", tenantId)
            .eq("call_queue_id", voice.id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
          voice.lead_id
            ? db
                .from("players")
                .select("id,nome,telefone")
                .eq("tenant_id", tenantId)
                .eq("id", voice.lead_id)
                .maybeSingle()
            : Promise.resolve({ data: null, error: null }),
          voice.script_id
            ? db
                .from("call_scripts")
                .select("id,name,content")
                .eq("tenant_id", tenantId)
                .eq("id", voice.script_id)
                .maybeSingle()
            : Promise.resolve({ data: null, error: null }),
          voice.voice_asset_id
            ? db
                .from("journey_voice_assets")
                .select("id,name")
                .eq("tenant_id", tenantId)
                .eq("id", voice.voice_asset_id)
                .maybeSingle()
            : Promise.resolve({ data: null, error: null }),
        ])
      : [
          { data: null, error: null },
          { data: null, error: null },
          { data: null, error: null },
          { data: null, error: null },
        ];
    const voiceDetailError = [
      voiceHistoryResult.error,
      voicePlayerResult.error,
      voiceScriptResult.error,
      voiceAssetResult.error,
    ].find(Boolean);
    if (voiceDetailError) throw new Error(voiceDetailError.message);
    const voiceHistory = voiceHistoryResult.data;
    const voicePlayer = voicePlayerResult.data;
    const voiceScript = voiceScriptResult.data;
    const voiceAsset = voiceAssetResult.data;
    const campaign = sms
      ? {
          channel: "sms" as const,
          name: sms.name,
          content: sms.content,
          route: sms.route,
          status: sms.status,
          total: Number(sms.total_count ?? 0),
          sent: Number(sms.sent_count ?? 0),
          deduplicated: Number(sms.deduplicated_count ?? 0),
          failed: Number(sms.failed_count ?? 0),
          scheduledAt: sms.scheduled_at,
          createdAt: sms.created_at,
          finishedAt: sms.updated_at,
          audience: Array.isArray(sms.recipients) ? sms.recipients.length : 0,
          lastError: (sms.last_error as string | null) ?? null,
        }
      : email
        ? {
            channel: "email" as const,
            name: email.name,
            content:
              email.template_snapshot?.subject ??
              email.template_snapshot?.name ??
              "Conteúdo de e-mail preservado no template da campanha.",
            route: "E-mail",
            status: email.status,
            total: Number(email.stats?.total ?? email.stats?.destinatarios ?? 0),
            sent: Number(email.stats?.sent ?? email.stats?.enviados ?? 0),
            deduplicated: 0,
            failed: Number(email.stats?.failed ?? email.stats?.falhas ?? 0),
            scheduledAt: email.scheduled_at,
            createdAt: email.created_at,
            finishedAt: email.updated_at,
            audience: Number(email.stats?.total ?? email.stats?.destinatarios ?? 0),
            lastError: null,
          }
        : voice
          ? {
              channel: "voice" as const,
              name:
                voice.trigger_name ?? voiceScript?.name ?? voiceAsset?.name ?? "Ligação por voz",
              content:
                voiceScript?.content ?? (voiceAsset?.name ? `Áudio: ${voiceAsset.name}` : null),
              route: "Infobip Voice",
              status: voice.status,
              total: 1,
              sent: voiceHistory ? 1 : 0,
              deduplicated: 0,
              failed: voice.status === "failed" || voice.status === "cancelled" ? 1 : 0,
              scheduledAt: voice.scheduled_at,
              createdAt: voice.created_at,
              finishedAt: ["completed", "failed", "cancelled"].includes(voice.status)
                ? voice.updated_at
                : null,
              audience: 1,
              lastError: null,
            }
          : null;

    const voiceDetails = voice
      ? {
          queueStatus: voice.status,
          providerStatus: voice.provider_status,
          playerName: voicePlayer?.nome ?? null,
          phone: voiceHistory?.to_phone ?? voicePlayer?.telefone ?? voice.phone_number ?? null,
          attemptedAt: voiceHistory?.created_at ?? null,
          result: voiceHistory?.result ?? null,
          historyStatus: voiceHistory?.status ?? null,
          answered:
            voiceHistory?.result === "answered" ||
            voiceHistory?.status === "answered" ||
            voice.provider_status === "answered",
          durationSeconds: voiceHistory?.duration_seconds ?? null,
          error: voiceHistory?.error_message ?? null,
          provider: voiceHistory?.provider ?? "infobip",
          providerCallId: voiceHistory?.provider_call_id ?? null,
          providerStatusCode: voiceHistory?.provider_status_code ?? null,
          attempts: Number(voice.attempts ?? 0),
        }
      : null;

    const dispatches = dispatchResult.data ?? [];
    const deliveryMap = new Map<string, any[]>();
    for (const row of dispatches) {
      const key = row.idempotency_key || row.message_log_id || row.id;
      const group = deliveryMap.get(key) ?? [];
      group.push(row);
      deliveryMap.set(key, group);
    }
    const deliveries = [...deliveryMap.entries()].slice(0, data.limit);
    const playerIds = [
      ...new Set(deliveries.map(([, rows]) => rows[0]?.recipient_player_id).filter(Boolean)),
    ];
    const linkIds = [
      ...new Set(deliveries.flatMap(([, rows]) => rows.map((row) => row.tracked_link_id))),
    ];
    const tokens = [
      ...new Set(deliveries.flatMap(([, rows]) => rows.map((row) => row.tracking_token))),
    ];
    const messageLogIds = [
      ...new Set(deliveries.map(([, rows]) => rows[0]?.message_log_id).filter(Boolean)),
    ];
    const dispatchIds = [...new Set(deliveries.flatMap(([, rows]) => rows.map((row) => row.id)))];

    const [
      playersResult,
      snapshotsResult,
      clickEventsResult,
      attributionsResult,
      depositsResult,
      smsLogsResult,
    ] = await Promise.all([
      selectInChunks<any>(playerIds, (chunk) =>
        db
          .from("players")
          .select("id,nome,telefone,email,total_depositado")
          .eq("tenant_id", tenantId)
          .in("id", chunk),
      ),
      selectInChunks<any>(linkIds, (chunk) =>
        db
          .from("link_click_snapshots")
          .select("tracked_link_id,clicks,human_clicks,snapshot_at")
          .eq("tenant_id", tenantId)
          .in("tracked_link_id", chunk),
      ),
      selectInChunks<any>(dispatchIds, (chunk) =>
        db
          .from("click_events")
          .select("link_dispatch_id,occurred_at")
          .eq("tenant_id", tenantId)
          .eq("is_human", true)
          .in("link_dispatch_id", chunk)
          .order("occurred_at", { ascending: true }),
      ).then((result) => ({ ...result, data: result.data.sort(byOccurredAt) })),
      selectInChunks<any>(tokens, (chunk) =>
        db
          .from("conversion_attributions")
          .select(
            "tracking_token,event_type,occurred_at,monetary_value,is_ftd,classification,player_active_at_click",
          )
          .eq("tenant_id", tenantId)
          .eq("source_type", "campaign")
          .eq("source_id", data.campaignId)
          .in("tracking_token", chunk),
      ),
      selectInChunks<any>(playerIds, (chunk) =>
        db
          .from("deposits")
          .select("player_id,valor,status,completed_at,created_at")
          .eq("tenant_id", tenantId)
          .in("player_id", chunk)
          .eq("status", "aprovado"),
      ),
      sms?.id && messageLogIds.length
        ? selectInChunks<any>(messageLogIds, (chunk) =>
            db
              .from("sms_send_logs")
              .select("id,status,error,to_phone,created_at,delivered_at,delivery_status")
              .eq("tenant_id", tenantId)
              .in("id", chunk),
          )
        : Promise.resolve({ data: [], error: null }),
    ]);
    const firstError = [
      playersResult.error,
      snapshotsResult.error,
      clickEventsResult.error,
      attributionsResult.error,
      depositsResult.error,
      smsLogsResult.error,
    ].find(Boolean);
    if (firstError) throw new Error(firstError.message);

    const players = new Map<string, any>(
      (playersResult.data ?? []).map((row: any) => [row.id, row]),
    );
    const logs = new Map<string, any>((smsLogsResult.data ?? []).map((row: any) => [row.id, row]));
    const latestSnapshot = new Map<string, any>();
    for (const row of snapshotsResult.data ?? []) {
      const previous = latestSnapshot.get(row.tracked_link_id);
      if (!previous || row.snapshot_at > previous.snapshot_at)
        latestSnapshot.set(row.tracked_link_id, row);
    }
    const confirmedClicksByDispatch = new Map<string, string[]>();
    for (const event of clickEventsResult.data ?? []) {
      const dispatchId = String(event.link_dispatch_id ?? "");
      if (!dispatchId || !event.occurred_at) continue;
      const clicks = confirmedClicksByDispatch.get(dispatchId) ?? [];
      clicks.push(event.occurred_at);
      confirmedClicksByDispatch.set(dispatchId, clicks);
    }
    const depositsByPlayer = new Map<string, any[]>();
    for (const row of depositsResult.data ?? []) {
      const group = depositsByPlayer.get(row.player_id) ?? [];
      group.push(row);
      depositsByPlayer.set(row.player_id, group);
    }
    const attributionsByToken = new Map<string, any[]>();
    for (const row of attributionsResult.data ?? []) {
      const group = attributionsByToken.get(row.tracking_token) ?? [];
      group.push(row);
      attributionsByToken.set(row.tracking_token, group);
    }

    const recipients = deliveries.map(([key, rows]) => {
      const first = rows[0];
      const player = players.get(first.recipient_player_id) ?? null;
      const log = logs.get(first.message_log_id) ?? null;
      const snapshots = rows.map((row) => latestSnapshot.get(row.tracked_link_id)).filter(Boolean);
      const clickInstants = rows
        .flatMap((row) => confirmedClicksByDispatch.get(row.id) ?? [])
        .sort();
      const clicked = clickInstants.length > 0;
      const clickCount = clickInstants.length;
      const observedClickCount = snapshots.reduce(
        (sum, row) => sum + Number(row.human_clicks ?? row.clicks ?? 0),
        0,
      );
      const attributionRows = rows.flatMap(
        (row) => attributionsByToken.get(row.tracking_token) ?? [],
      );
      const directAttributions = attributionRows
        .filter((row) => row.classification === "direct")
        .sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));
      const registered = directAttributions.find((row) => row.event_type === "registered");
      const loginOrGame = directAttributions.find(
        (row) => row.event_type === "login" || row.event_type === "game",
      );
      const firstDeposit = directAttributions.find(
        (row) => row.event_type === "deposit_approved" && row.is_ftd === true,
      );
      const firstDirectDeposit = directAttributions.find(
        (row) => row.event_type === "deposit_approved",
      );
      // A player already active at the click is not a conversion (rule_version 3):
      // the deposit is shown apart and stays out of the campaign's counts.
      const alreadyActive = firstDirectDeposit?.player_active_at_click === true;
      const deposit = alreadyActive ? undefined : firstDirectDeposit;
      const historicalDeposits = depositsByPlayer.get(first.recipient_player_id) ?? [];
      return {
        id: key,
        playerId: first.recipient_player_id,
        playerName: player?.nome ?? log?.to_phone ?? "Destinatário não identificado",
        contact: player?.telefone ?? player?.email ?? log?.to_phone ?? "",
        sendStatus: first.send_status,
        deliveryStatus: first.delivery_status ?? log?.delivery_status ?? null,
        error: log?.error ?? null,
        sentAt: first.sent_at ?? first.created_at,
        deliveredAt: first.delivered_at ?? log?.delivered_at ?? null,
        clicked,
        clickCount,
        clickedAt: clickInstants.at(0) ?? null,
        observedClickCount,
        registeredAt: registered?.occurred_at ?? null,
        loginOrGameAt: loginOrGame?.occurred_at ?? null,
        firstDepositAt: firstDeposit?.occurred_at ?? null,
        depositAt: deposit?.occurred_at ?? null,
        depositValue: Number(deposit?.monetary_value ?? 0),
        activeDepositAt: alreadyActive ? (firstDirectDeposit?.occurred_at ?? null) : null,
        activeDepositValue: alreadyActive ? Number(firstDirectDeposit?.monetary_value ?? 0) : 0,
        historicalDepositCount: historicalDeposits.length,
        historicalDepositValue: historicalDeposits.reduce(
          (sum, row) => sum + Number(row.valor ?? 0),
          0,
        ),
      };
    });

    const unresolved = sms?.id
      ? await loadCampaignUnresolved(db, tenantId, sms.id)
      : { total: 0, byReason: countUnresolvedByReason([]), sample: [], all: [], available: false };

    return {
      campaign,
      voice: voiceDetails,
      unresolved: {
        total: unresolved.total,
        byReason: unresolved.byReason,
        available: unresolved.available,
        // UI only receives masked phones; the full list is in the CSV export.
        sample: unresolved.sample.map((row) => ({
          phone: maskPhone(row.phone),
          reason: row.reason,
        })),
      },
      recipients,
      recipientsShown: recipients.length,
      trackedDeliveries: deliveryMap.size,
      failureReasons: [...logs.values()]
        .filter((row: any) => row.error)
        .reduce((groups: Record<string, number>, row: any) => {
          const reason = String(row.error).slice(0, 140);
          groups[reason] = (groups[reason] ?? 0) + 1;
          return groups;
        }, {}),
    };
  });

export const exportCampaignRecipientsCsv = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => z.object({ campaignId: z.string().uuid() }).parse(value))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    await requireConversionReportAdmin(context, tenantId);
    const db = context.supabase as any;
    const { data: dispatches, error } = await db
      .from("link_dispatches")
      .select(
        "recipient_player_id,send_status,delivery_status,sent_at,delivered_at,tracking_token,players(nome,email,telefone)",
      )
      .eq("tenant_id", tenantId)
      .eq("source_type", "campaign")
      .eq("source_id", data.campaignId)
      .limit(10000);
    if (error) throw new Error(error.message);
    const csv = [
      "jogador,email,telefone,status_envio,status_entrega,enviado_em,entregue_em,token_rastreamento",
      ...(dispatches ?? []).map((row: any) =>
        [
          row.players?.nome,
          row.players?.email,
          row.players?.telefone,
          row.send_status,
          row.delivery_status,
          row.sent_at,
          row.delivered_at,
          row.tracking_token,
        ]
          .map(csvCell)
          .join(","),
      ),
    ].join("\n");
    return { csv };
  });

/** ENV-06 — full list of not-sent recipients (same permission as the recipients CSV). */
export const exportCampaignUnresolvedCsv = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => z.object({ campaignId: z.string().uuid() }).parse(value))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    await requireConversionReportAdmin(context, tenantId);
    const unresolved = await loadCampaignUnresolved(
      context.supabase as any,
      tenantId,
      data.campaignId,
    );
    return { csv: buildUnresolvedRecipientsCsv(unresolved.all) };
  });

export const getConversionDataHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => inputSchema.parse(value))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const db = context.supabase as any;
    const staleAt = new Date(Date.now() - 30 * 60_000).toISOString();
    const { data: dispatches, error } = await db
      .from("link_dispatches")
      .select("id,send_status,created_at,tracked_links(last_synced_at)")
      .eq("tenant_id", tenantId)
      .eq("source_type", data.sourceType)
      .eq("source_id", data.sourceId);
    if (error) throw new Error(error.message);
    const issueSince = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const issueReasons = [
      "missing_token",
      "token_without_dispatch",
      "invalid_origin_or_player",
      "dispatch_not_sent",
    ] as const;
    const [sourceIssues, globalIssues, ...globalReasonResults] = await Promise.all([
      db
        .from("conversion_attribution_issues")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("source_type", data.sourceType)
        .eq("source_id", data.sourceId)
        .gte("created_at", issueSince),
      db
        .from("conversion_attribution_issues")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .is("source_id", null)
        .gte("created_at", issueSince),
      ...issueReasons.map((reason) =>
        db
          .from("conversion_attribution_issues")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId)
          .is("source_id", null)
          .eq("reason", reason)
          .gte("created_at", issueSince),
      ),
    ]);
    const issueError = [sourceIssues, globalIssues, ...globalReasonResults]
      .map((result: any) => result.error)
      .find(Boolean);
    if (issueError && !String(issueError.message).includes("permission"))
      throw new Error(issueError.message);
    const rows = dispatches ?? [];
    const preparedStale = rows.filter(
      (row: any) => row.send_status === "prepared" && row.created_at < staleAt,
    ).length;
    const syncStale = rows.filter(
      (row: any) =>
        !row.tracked_links?.last_synced_at || row.tracked_links.last_synced_at < staleAt,
    ).length;
    const alerts = [] as Array<{ code: string; severity: "warning" | "error"; message: string }>;
    if (preparedStale)
      alerts.push({
        code: "dispatch_stuck",
        severity: "error",
        message: `${preparedStale} envio(s) rastreado(s) permanecem preparados há mais de 30 minutos.`,
      });
    // Click synchronization is eventually consistent. Its operational health
    // is monitored by sync runs; it must not be presented as a journey fault.
    if (syncStale && process.env.EXPOSE_LINK_SYNC_DIAGNOSTICS === "true")
      alerts.push({
        code: "click_sync_stale",
        severity: "warning",
        message: `${syncStale} link(s) ainda não possuem sincronização recente de cliques.`,
      });
    const sourceIssueCount = Number(sourceIssues.count ?? 0);
    if (sourceIssueCount)
      alerts.push({
        code: "attribution_rejected",
        severity: "warning",
        message: `${sourceIssueCount} evento(s) desta origem ficaram sem atribuição determinística nas últimas 24 horas.`,
      });
    const globalIssueReasons = Object.fromEntries(
      issueReasons
        .map((reason, index) => [reason, Number(globalReasonResults[index]?.count ?? 0)] as const)
        .filter(([, count]) => count > 0),
    );
    // Tenant-wide integration health is technical: only super admins get it.
    const { data: superAdmin } = await db.rpc("is_super_admin", { _user_id: context.userId });
    return {
      healthy: alerts.length === 0,
      alerts,
      globalAttributionHealth: superAdmin
        ? {
            count: Number(globalIssues.count ?? 0),
            periodHours: 24,
            reasons: globalIssueReasons,
          }
        : null,
    };
  });

export const getConversionDrilldown = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => drilldownSchema.parse(value))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    await requireConversionReportAdmin(context, tenantId);
    const db = context.supabase as any;
    const { data: dispatches, error: dispatchError } = await db
      .from("link_dispatches")
      .select("id,recipient_player_id,idempotency_key,sent_at,created_at,send_status")
      .eq("tenant_id", tenantId)
      .eq("source_type", data.sourceType)
      .eq("source_id", data.sourceId)
      .not("recipient_player_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(data.limit * 3);
    if (dispatchError) throw new Error(dispatchError.message);
    const dispatchRows = dispatches ?? [];
    const dispatchIds = dispatchRows.map((row: any) => row.id);
    const playerIds = [...new Set(dispatchRows.map((row: any) => row.recipient_player_id))];
    const [clickResult, attributionResult, playersResult] = await Promise.all([
      selectInChunks<any>(dispatchIds, (chunk) =>
        db
          .from("click_events")
          .select("link_dispatch_id,occurred_at")
          .eq("tenant_id", tenantId)
          .eq("is_human", true)
          .in("link_dispatch_id", chunk)
          .order("occurred_at", { ascending: true }),
      ).then((result) => ({ ...result, data: result.data.sort(byOccurredAt) })),
      selectInChunks<any>(dispatchIds, (chunk) =>
        db
          .from("conversion_attributions")
          .select(
            "link_dispatch_id,event_type,occurred_at,monetary_value,is_ftd,player_active_at_click",
          )
          .eq("tenant_id", tenantId)
          .eq("source_type", data.sourceType)
          .eq("source_id", data.sourceId)
          .in("link_dispatch_id", chunk),
      ),
      selectInChunks<any>(playerIds, (chunk) =>
        db
          .from("players")
          .select("id,nome,email,telefone")
          .eq("tenant_id", tenantId)
          .in("id", chunk),
      ),
    ]);
    const firstError = [clickResult.error, attributionResult.error, playersResult.error].find(
      Boolean,
    );
    if (firstError) throw new Error(firstError.message);
    const clicksByDispatch = new Map<string, string>();
    for (const click of clickResult.data ?? []) {
      if (!clicksByDispatch.has(click.link_dispatch_id))
        clicksByDispatch.set(click.link_dispatch_id, click.occurred_at);
    }
    const eventsByDispatch = new Map<string, any[]>();
    for (const event of attributionResult.data ?? []) {
      const group = eventsByDispatch.get(event.link_dispatch_id) ?? [];
      group.push(event);
      eventsByDispatch.set(event.link_dispatch_id, group);
    }
    const playersById = new Map<string, any>(
      (playersResult.data ?? []).map((row: any) => [row.id, row]),
    );
    const grouped = new Map<string, any[]>();
    for (const dispatch of dispatchRows) {
      const key = dispatch.idempotency_key || dispatch.id;
      const group = grouped.get(key) ?? [];
      group.push(dispatch);
      grouped.set(key, group);
    }
    const rows = Array.from(grouped.values())
      .slice(0, data.limit)
      .map((group: any[]) => {
        const first = group[0];
        const events = group.flatMap((dispatch) => eventsByDispatch.get(dispatch.id) ?? []);
        const findEvent = (types: string[]) =>
          events
            .filter((event: any) => types.includes(event.event_type))
            .sort((a: any, b: any) =>
              String(a.occurred_at).localeCompare(String(b.occurred_at)),
            )[0] ?? null;
        const deposit = findEvent(["deposit_approved"]);
        const player = playersById.get(first.recipient_player_id);
        return {
          playerId: first.recipient_player_id,
          playerName: player?.nome ?? "Jogador não identificado",
          contact: player?.telefone ?? player?.email ?? null,
          sentAt: first.sent_at ?? first.created_at,
          clickedAt:
            group
              .map((dispatch) => clicksByDispatch.get(dispatch.id))
              .filter(Boolean)
              .sort()[0] ?? null,
          loginAt: findEvent(["login", "game"])?.occurred_at ?? null,
          depositedAt: deposit?.occurred_at ?? null,
          depositValue: Number(deposit?.monetary_value ?? 0),
          isFtd: deposit?.is_ftd === true,
          // Already active at the click: listed, but not a conversion.
          alreadyActive: deposit?.player_active_at_click === true,
        };
      });
    await db.from("conversion_report_audit_events").insert({
      tenant_id: tenantId,
      source_type: data.sourceType,
      source_id: data.sourceId,
      actor_user_id: context.userId,
      action: "drilldown_viewed",
    });
    return { rows: rows ?? [] };
  });

export const exportConversionDrilldownCsv = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => inputSchema.parse(value))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    await requireConversionReportAdmin(context, tenantId);
    const db = context.supabase as any;
    const { data: rows, error } = await db
      .from("conversion_attributions")
      .select(
        "event_type,event_id,occurred_at,monetary_value,is_ftd,player_active_at_click,players(nome,email,telefone)",
      )
      .eq("tenant_id", tenantId)
      .eq("source_type", data.sourceType)
      .eq("source_id", data.sourceId)
      .order("occurred_at", { ascending: false })
      .limit(10000);
    if (error) throw new Error(error.message);
    const cell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const csv = [
      "nome,email,telefone,event_type,event_id,ocorrido_em,valor,is_ftd,ja_ativo_no_clique",
      ...(rows ?? []).map((row: any) =>
        [
          row.players?.nome,
          row.players?.email,
          row.players?.telefone,
          row.event_type,
          row.event_id,
          row.occurred_at,
          row.monetary_value,
          row.is_ftd,
          row.player_active_at_click === true,
        ]
          .map(cell)
          .join(","),
      ),
    ].join("\n");
    await db.from("conversion_report_audit_events").insert({
      tenant_id: tenantId,
      source_type: data.sourceType,
      source_id: data.sourceId,
      actor_user_id: context.userId,
      action: "csv_exported",
    });
    return { csv };
  });

export const getConversionReport = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => inputSchema.parse(value))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const db = context.supabase as any;
    const [
      dispatchResult,
      attributionResult,
      smsCampaignResult,
      emailCampaignResult,
      journeyStepsResult,
    ] = await Promise.all([
      selectAllPages<any>("link_dispatches", () =>
        db
          .from("link_dispatches")
          .select(
            "id,tracked_link_id,tracking_token,recipient_player_id,idempotency_key,message_log_id,send_status,delivery_status,sent_at,updated_at,channel,journey_step_id,journey_step_position,shortio_click_count,shortio_last_clicked_at",
          )
          .eq("tenant_id", tenantId)
          .eq("source_type", data.sourceType)
          .eq("source_id", data.sourceId),
      ),
      selectAllPages<any>("conversion_attributions", () =>
        db
          .from("conversion_attributions")
          .select(
            "id,link_dispatch_id,tracking_token,player_id,event_type,event_id,monetary_value,is_ftd,occurred_at,created_at,classification,player_active_at_click",
          )
          .eq("tenant_id", tenantId)
          .eq("source_type", data.sourceType)
          .eq("source_id", data.sourceId)
          .in("classification", ["direct", "assisted"]),
      ),
      data.sourceType === "campaign"
        ? db
            .from("sms_campaigns")
            .select("sent_count,deduplicated_count")
            .eq("tenant_id", tenantId)
            .eq("id", data.sourceId)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      data.sourceType === "campaign"
        ? db
            .from("email_campaigns")
            .select("stats")
            .eq("tenant_id", tenantId)
            .eq("id", data.sourceId)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      data.sourceType === "journey"
        ? db
            .from("journey_steps")
            .select("id,position,step_type,label,config,is_enabled")
            .eq("tenant_id", tenantId)
            .eq("journey_id", data.sourceId)
            .order("position")
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (dispatchResult.error) throw new Error(dispatchResult.error.message);
    if (attributionResult.error) throw new Error(attributionResult.error.message);
    if (journeyStepsResult.error) throw new Error(journeyStepsResult.error.message);
    const dispatches = dispatchResult.data ?? [];
    // Deposits of players already active at the click are not conversions
    // (rule_version 3); they are reported apart and never in the totals.
    const isActiveDeposit = (item: any) =>
      item.event_type === "deposit_approved" && item.player_active_at_click === true;
    const allAttributions: any[] = attributionResult.data ?? [];
    const attributions = allAttributions.filter((item) => !isActiveDeposit(item));
    const activeDeposits = allAttributions.filter(
      (item) => isActiveDeposit(item) && item.classification === "direct",
    );
    const journeySteps: any[] = journeyStepsResult.data ?? [];
    // Copy rotation: the dispatcher stores the drawn copy in the execution's
    // provider_response; the dispatch shares the execution key (+ ":n").
    const rotatesCopies = journeySteps.some(
      (step) => step.step_type === "sms" && smsVariants(step.config ?? {}).length > 1,
    );
    const variantByDelivery = new Map<string, number>();
    if (rotatesCopies && dispatches.length) {
      const executionsResult = await selectAllPages<any>("journey_step_executions", () =>
        db
          .from("journey_step_executions")
          .select("id,idempotency_key,variant:provider_response->>variant_index")
          .eq("tenant_id", tenantId)
          .eq("journey_id", data.sourceId)
          .in("status", ["sent", "delivered"]),
      );
      if (executionsResult.error) throw new Error(executionsResult.error.message);
      for (const row of executionsResult.data ?? []) {
        const variant = Number(row.variant);
        if (row.idempotency_key && row.variant !== null && Number.isInteger(variant))
          variantByDelivery.set(String(row.idempotency_key), variant);
      }
    }
    const linkIds = dispatches.map((item: any) => item.tracked_link_id).filter(Boolean);
    const [
      { data: snapshots, error: snapshotError },
      { data: clickEvents, error: clickEventsError },
      canViewSensitive,
    ] = await Promise.all([
      selectInChunks<any>(linkIds, (chunk) =>
        db
          .from("link_click_snapshots")
          .select("tracked_link_id,clicks,human_clicks,snapshot_at")
          .in("tracked_link_id", chunk),
      ),
      selectInChunks<any>(
        dispatches.map((item: any) => item.id),
        (chunk) =>
          db
            .from("click_events")
            .select("link_dispatch_id")
            .eq("tenant_id", tenantId)
            .eq("is_human", true)
            .in("link_dispatch_id", chunk),
      ),
      hasConversionReportAdmin(context, tenantId),
    ]);
    if (snapshotError) throw new Error(snapshotError.message);
    if (clickEventsError) throw new Error(clickEventsError.message);
    const clicksByLink = new Map<string, { clicks: number; snapshot_at: string }>();
    for (const snapshot of snapshots ?? []) {
      const previous = clicksByLink.get(snapshot.tracked_link_id);
      if (!previous || snapshot.snapshot_at > previous.snapshot_at)
        clicksByLink.set(snapshot.tracked_link_id, snapshot);
    }
    const trackedSent = uniqueDeliveryCount(dispatches, (item) => item.send_status === "sent");
    const operationalSent = smsCampaignResult.data
      ? Number(smsCampaignResult.data.sent_count ?? 0)
      : emailCampaignResult.data
        ? Number(
            emailCampaignResult.data.stats?.sent ?? emailCampaignResult.data.stats?.enviados ?? 0,
          )
        : 0;
    const sent = Math.max(trackedSent, operationalSent);
    const deduplicated = Number(smsCampaignResult.data?.deduplicated_count ?? 0);
    const deliveredCount = uniqueDeliveryCount(
      dispatches,
      (item) => item.delivery_status === "delivered",
    );
    // The Short.io synchronizer persists the latest aggregate both in the
    // snapshot and in every individual dispatch. Prefer the dispatch value:
    // it remains tied to the exact journey step even when a tracked link is
    // shared by more than one message.
    const dispatchClickCount = (row: any) =>
      Math.max(
        Number(row.shortio_click_count ?? 0),
        Number(clicksByLink.get(row.tracked_link_id)?.clicks ?? 0),
      );
    const confirmedDispatchIds = new Set(
      (clickEvents ?? []).map((event: any) => String(event.link_dispatch_id)),
    );
    const clicked = uniqueDeliveryCount(dispatches, (row: any) => confirmedDispatchIds.has(row.id));
    const observedClicked = uniqueDeliveryCount(
      dispatches,
      (row: any) => dispatchClickCount(row) > 0,
    );
    const count = (eventType: string) =>
      attributions.filter(
        (item: any) => item.event_type === eventType && item.classification === "direct",
      ).length;
    const deposits = count("deposit_approved");
    const depositors = new Set(
      attributions
        .filter(
          (item: any) => item.event_type === "deposit_approved" && item.classification === "direct",
        )
        .map((item: any) => String(item.player_id)),
    ).size;
    const revenue = attributions
      .filter(
        (item: any) => item.event_type === "deposit_approved" && item.classification === "direct",
      )
      .reduce((sum: number, item: any) => sum + Number(item.monetary_value ?? 0), 0);
    const latest =
      [...dispatches, ...allAttributions]
        .map((item: any) => item.updated_at ?? item.created_at ?? item.occurred_at ?? item.sent_at)
        .filter(Boolean)
        .sort()
        .at(-1) ?? null;
    return {
      sent,
      trackedSent,
      deduplicated,
      delivered: deliveredCount || null,
      // Attribution and the main funnel use only a click recorded by our
      // redirect. The aggregate Short.io number is retained separately for
      // legacy diagnostics and is never causal evidence.
      clicked: dispatches.length ? clicked : null,
      observedClicked: clicksByLink.size ? observedClicked : null,
      registered: count("registered"),
      loginOrGame: count("login") + count("game"),
      deposits,
      depositors,
      activeDepositors: new Set(activeDeposits.map((item: any) => String(item.player_id))).size,
      activeRevenue: activeDeposits.reduce(
        (sum: number, item: any) => sum + Number(item.monetary_value ?? 0),
        0,
      ),
      ftd: attributions.filter(
        (item: any) =>
          item.event_type === "deposit_approved" && item.is_ftd && item.classification === "direct",
      ).length,
      revenue,
      assistedRevenue: attributions
        .filter(
          (item: any) =>
            item.event_type === "deposit_approved" && item.classification === "assisted",
        )
        .reduce((sum: number, item: any) => sum + Number(item.monetary_value ?? 0), 0),
      latest,
      canViewSensitive,
      ...(() => {
        const result = buildJourneyStepConversions({
          steps: journeySteps,
          dispatches,
          attributions,
          confirmedDispatchIds,
          variantByDelivery,
        });
        return {
          byStep: result.steps,
          retiredSteps: result.retired,
          unassignedStep: result.unassigned,
          // Copy texts shown next to each copy's result (index = variant).
          stepCopies: Object.fromEntries(
            journeySteps
              .filter((step) => step.step_type === "sms")
              .map((step) => [String(step.id), smsVariants(step.config ?? {})]),
          ) as Record<string, string[]>,
        };
      })(),
      truncated: Boolean(dispatchResult.truncated || attributionResult.truncated),
      historical: dispatches.length === 0 && allAttributions.length === 0,
    };
  });
