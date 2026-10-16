// Journeys of one player, as shown on the player page (P3: "ficha do jogador").

export const OPEN_ENROLLMENT_STATUSES = ["active", "waiting", "paused_by_priority"] as const;

export const ENROLLMENT_STATUS_LABELS: Record<string, string> = {
  active: "em andamento",
  waiting: "aguardando a próxima etapa",
  paused_by_priority: "pausada por outra jornada",
  paused: "jornada desligada",
  completed: "concluída",
  exited: "saiu",
  failed: "falhou",
};

export const EXIT_REASON_LABELS: Record<string, string> = {
  deposit: "depositou",
  first_deposit: "fez o 1º depósito",
  login: "fez login",
  voltou_jogar: "voltou a jogar",
  level_changed: "mudou de nível",
  inactivity_threshold: "passou para a próxima faixa de inatividade",
  entry_no_longer_matches: "deixou de cumprir a entrada",
  stale_message: "mensagem perdeu a validade",
  end_step: "chegou ao fim",
  finished: "chegou ao fim",
  no_contact: "sem telefone cadastrado",
  journey_ended: "jornada encerrada pela data de término",
  journey_archived: "jornada arquivada",
  journey_removed: "jornada removida",
  journey_paused_closed: "encerrada ao desligar a jornada",
  journey_player_daily_cap: "limite diário de mensagens desta jornada",
  merged_duplicate: "entrada duplicada unificada",
  audit_cleanup_inactivity_band: "ajuste de faixa (auditoria)",
};

export type PlayerEnrollment = {
  id: string;
  journey_id: string;
  status: string;
  current_position: number;
  next_run_at: string | null;
  entered_at: string;
  exited_at: string | null;
  completed_at: string | null;
  exit_reason: string | null;
  is_holdout: boolean | null;
  priority_paused_by_journey_id: string | null;
  loop_iteration: number | null;
};

export type PlayerJourneyView = {
  id: string;
  journeyId: string;
  journeyName: string;
  open: boolean;
  statusLabel: string;
  /** "Etapa 3 de 7" over the journey's send steps; null when not applicable. */
  stepLabel: string | null;
  nextRunAt: string | null;
  enteredAt: string;
  endedAt: string | null;
  exitLabel: string | null;
  holdout: boolean;
  pausedBy: string | null;
  loopIteration: number;
};

/**
 * Turns raw enrollments into what an operator needs to read: open journeys
 * first, the step reached among the journey's send steps, and why a journey
 * ended in plain language.
 */
export function describePlayerJourneys(
  enrollments: PlayerEnrollment[],
  journeys: Record<string, { name: string; sendPositions: number[] }>,
): PlayerJourneyView[] {
  return enrollments
    .map((enrollment) => {
      const journey = journeys[enrollment.journey_id];
      const open = (OPEN_ENROLLMENT_STATUSES as readonly string[]).includes(enrollment.status);
      const positions = journey?.sendPositions ?? [];
      const reached = positions.filter((position) => position < enrollment.current_position).length;
      const reason = enrollment.exit_reason ?? null;
      return {
        id: enrollment.id,
        journeyId: enrollment.journey_id,
        journeyName: journey?.name ?? "Jornada",
        open,
        statusLabel: ENROLLMENT_STATUS_LABELS[enrollment.status] ?? enrollment.status,
        stepLabel:
          open && positions.length
            ? `Etapa ${Math.min(reached + 1, positions.length)} de ${positions.length}`
            : null,
        nextRunAt: open ? enrollment.next_run_at : null,
        enteredAt: enrollment.entered_at,
        endedAt: open ? null : (enrollment.exited_at ?? enrollment.completed_at),
        exitLabel: open || !reason ? null : (EXIT_REASON_LABELS[reason] ?? reason),
        holdout: Boolean(enrollment.is_holdout),
        pausedBy:
          enrollment.status === "paused_by_priority" && enrollment.priority_paused_by_journey_id
            ? (journeys[enrollment.priority_paused_by_journey_id]?.name ?? "outra jornada")
            : null,
        loopIteration: Number(enrollment.loop_iteration ?? 0),
      };
    })
    .sort(
      (a, b) =>
        Number(b.open) - Number(a.open) ||
        String(b.endedAt ?? b.enteredAt).localeCompare(String(a.endedAt ?? a.enteredAt)),
    );
}
