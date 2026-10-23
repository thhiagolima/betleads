import { cn } from "@/lib/utils";

import { dateTime, maskContact, money, number } from "./format";
import { PlayerName } from "./report-parts";

export type ReportRecipient = {
  id: string;
  playerId?: string | null;
  playerName: string;
  contact: string;
  sendStatus: string;
  deliveryStatus: string | null;
  error: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  clicked: boolean;
  clickCount: number;
  clickedAt: string | null;
  registeredAt: string | null;
  loginOrGameAt: string | null;
  firstDepositAt: string | null;
  depositAt: string | null;
  depositValue: number;
  /** Deposit of a player already active at the click: shown, never counted. */
  activeDepositAt?: string | null;
  activeDepositValue?: number;
  historicalDepositCount: number;
  historicalDepositValue: number;
};

const SEND_STATUS_LABEL: Record<string, string> = {
  sent: "Enviado",
  delivered: "Entregue",
  prepared: "Preparado",
  pending: "Pendente",
  queued: "Na fila",
  skipped: "Não enviado",
  failed: "Falhou",
  cancelled: "Cancelado",
};

/**
 * Furthest stage the recipient reached, in operator words. Without delivery
 * confirmation (SMS, e-mail) "Entregue" is never shown.
 */
function stageReached(row: ReportRecipient, showDelivered: boolean) {
  if (row.depositAt)
    return { label: row.firstDepositAt ? "Primeiro depósito" : "Depositou", tone: "success" };
  if (row.activeDepositAt) return { label: "Depositou · já ativo", tone: "muted" };
  if (row.loginOrGameAt) return { label: "Login ou jogo", tone: "neutral" };
  if (row.registeredAt) return { label: "Cadastro", tone: "neutral" };
  if (row.clicked) return { label: "Clicou", tone: "neutral" };
  if (showDelivered && row.deliveryStatus === "delivered")
    return { label: "Entregue", tone: "muted" };
  const status = row.sendStatus?.toLowerCase();
  if (status === "delivered" && !showDelivered) return { label: "Enviado", tone: "muted" };
  if (status === "failed") return { label: "Falhou", tone: "danger" };
  return { label: SEND_STATUS_LABEL[status] ?? row.sendStatus ?? "—", tone: "muted" };
}

const stageTone: Record<string, string> = {
  success: "text-success",
  danger: "text-danger",
  neutral: "text-foreground",
  muted: "text-muted-foreground",
};

function RecipientValue({ row }: { row: ReportRecipient }) {
  if (row.depositValue)
    return <span className="font-semibold text-success">{money(row.depositValue)}</span>;
  if (row.activeDepositValue)
    return (
      <span className="text-muted-foreground" title="Já ativo antes do clique: não conta">
        {money(row.activeDepositValue)}
      </span>
    );
  return <span className="text-muted-foreground">—</span>;
}

/** Campaign recipients: table on desktop, cards on the phone. */
export function RecipientList({
  rows,
  showDelivered,
}: {
  rows: ReportRecipient[];
  showDelivered: boolean;
}) {
  return (
    <>
      <ul className="divide-y divide-border/70 md:hidden">
        {rows.map((row) => {
          const stage = stageReached(row, showDelivered);
          return (
            <li key={row.id} className="flex items-start justify-between gap-3 py-3">
              <div className="min-w-0">
                <PlayerName
                  playerId={row.playerId}
                  name={row.playerName}
                  className="block truncate text-body"
                />
                <p className="text-meta tabular-nums text-muted-foreground">
                  {maskContact(row.contact)}
                </p>
                <p className={cn("mt-0.5 text-meta font-medium", stageTone[stage.tone])}>
                  {stage.label}
                  {row.clickedAt ? (
                    <span className="font-normal text-muted-foreground">
                      {" "}
                      · clicou {dateTime(row.clickedAt)}
                    </span>
                  ) : null}
                </p>
              </div>
              <div className="shrink-0 text-right text-body tabular-nums">
                <RecipientValue row={row} />
              </div>
            </li>
          );
        })}
      </ul>

      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[1080px] text-body">
          <thead>
            <tr className="border-b text-left text-label text-muted-foreground">
              <th className="px-3 py-2.5 font-medium">Jogador</th>
              <th className="px-3 py-2.5 font-medium">Etapa alcançada</th>
              <th className="px-3 py-2.5 font-medium">Envio</th>
              <th className="px-3 py-2.5 font-medium">Clique</th>
              <th className="px-3 py-2.5 text-right font-medium">Cliques</th>
              <th className="px-3 py-2.5 font-medium">Cadastro</th>
              <th className="px-3 py-2.5 font-medium">Login ou jogo</th>
              <th className="px-3 py-2.5 font-medium">Depósito</th>
              <th className="px-3 py-2.5 text-right font-medium">Valor</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {rows.map((row) => {
              const stage = stageReached(row, showDelivered);
              return (
                <tr key={row.id} className="border-b border-border/70 last:border-0">
                  <td className="px-3 py-2.5">
                    <PlayerName
                      playerId={row.playerId}
                      name={row.playerName}
                      className="block max-w-48 truncate"
                    />
                    <span className="text-meta text-muted-foreground">
                      {maskContact(row.contact)}
                    </span>
                  </td>
                  <td className={cn("px-3 py-2.5 font-medium", stageTone[stage.tone])}>
                    {stage.label}
                  </td>
                  <td className="px-3 py-2.5 text-muted-foreground">{dateTime(row.sentAt)}</td>
                  <td className="px-3 py-2.5 text-muted-foreground">{dateTime(row.clickedAt)}</td>
                  <td className="px-3 py-2.5 text-right">{row.clickCount || "—"}</td>
                  <td className="px-3 py-2.5 text-muted-foreground">
                    {dateTime(row.registeredAt)}
                  </td>
                  <td className="px-3 py-2.5 text-muted-foreground">
                    {dateTime(row.loginOrGameAt)}
                  </td>
                  <td className="px-3 py-2.5 text-muted-foreground">
                    {row.activeDepositAt
                      ? `${dateTime(row.activeDepositAt)} · já ativo`
                      : dateTime(row.depositAt)}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <RecipientValue row={row} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function formatElapsed(value: number | null) {
  if (value === null) return "—";
  const minutes = Math.floor(value / 60_000);
  if (minutes < 60) return `${minutes} min`;
  return `${(minutes / 60).toFixed(1).replace(".", ",")} h`;
}

/** "Quem clicou e depositou": table on desktop, cards on the phone. */
export function ConversionList({ rows }: { rows: ReportRecipient[] }) {
  const elapsedOf = (row: ReportRecipient) =>
    row.clickedAt && row.depositAt
      ? Math.max(0, new Date(row.depositAt).getTime() - new Date(row.clickedAt).getTime())
      : null;
  return (
    <>
      <ul className="divide-y divide-border/70 md:hidden">
        {rows.map((row) => (
          <li key={row.id} className="flex items-start justify-between gap-3 py-3">
            <div className="min-w-0">
              <PlayerName
                playerId={row.playerId}
                name={row.playerName}
                className="block truncate text-body"
              />
              <p className="text-meta text-muted-foreground">
                Depositou {formatElapsed(elapsedOf(row))} depois do clique ·{" "}
                {dateTime(row.depositAt)}
              </p>
            </div>
            <span className="shrink-0 text-body font-semibold tabular-nums text-success">
              {money(row.depositValue)}
            </span>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[680px] text-body">
          <thead>
            <tr className="border-b text-left text-label text-muted-foreground">
              <th className="px-3 py-2.5 font-medium">Jogador</th>
              <th className="px-3 py-2.5 font-medium">Clicou</th>
              <th className="px-3 py-2.5 font-medium">Depositou</th>
              <th className="px-3 py-2.5 font-medium">Depois de</th>
              <th className="px-3 py-2.5 text-right font-medium">Valor</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-border/70 last:border-0">
                <td className="px-3 py-2.5">
                  <PlayerName playerId={row.playerId} name={row.playerName} className="block" />
                  <span className="text-meta text-muted-foreground">
                    {number(row.historicalDepositCount)} depósitos no histórico ·{" "}
                    {money(row.historicalDepositValue)}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-muted-foreground">{dateTime(row.clickedAt)}</td>
                <td className="px-3 py-2.5 font-medium">{dateTime(row.depositAt)}</td>
                <td className="px-3 py-2.5 text-muted-foreground">
                  {formatElapsed(elapsedOf(row))}
                </td>
                <td className="px-3 py-2.5 text-right font-semibold text-success">
                  {money(row.depositValue)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export type TrackedLead = {
  playerId?: string | null;
  playerName: string;
  contact?: string | null;
  sentAt?: string | null;
  clickedAt?: string | null;
  loginAt?: string | null;
  depositedAt?: string | null;
  depositValue: number;
  alreadyActive?: boolean;
};

/** Journey tracked leads: table on desktop, cards on the phone. */
export function TrackedLeadList({ rows }: { rows: TrackedLead[] }) {
  const stage = (row: TrackedLead) =>
    row.depositedAt
      ? row.alreadyActive
        ? { label: "Depositou · já ativo, não conta", tone: "muted" }
        : { label: "Depositou", tone: "success" }
      : row.loginAt
        ? { label: "Login ou jogo", tone: "neutral" }
        : row.clickedAt
          ? { label: "Clicou", tone: "neutral" }
          : { label: "Enviado", tone: "muted" };
  return (
    <>
      <ul className="divide-y divide-border/70 md:hidden">
        {rows.map((row, index) => {
          const reached = stage(row);
          return (
            <li
              key={`${row.playerId}-${row.sentAt}-${index}`}
              className="flex items-start justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0">
                <PlayerName
                  playerId={row.playerId}
                  name={row.playerName}
                  className="block truncate text-body"
                />
                <p className="text-meta tabular-nums text-muted-foreground">
                  {maskContact(row.contact)}
                </p>
                <p className={cn("mt-0.5 text-meta font-medium", stageTone[reached.tone])}>
                  {reached.label}
                  <span className="font-normal text-muted-foreground">
                    {" "}
                    · enviado {dateTime(row.sentAt)}
                  </span>
                </p>
              </div>
              <span
                className={cn(
                  "shrink-0 text-body tabular-nums",
                  row.depositedAt && !row.alreadyActive
                    ? "font-semibold text-success"
                    : "text-muted-foreground",
                )}
              >
                {row.depositedAt ? money(row.depositValue) : "—"}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[760px] text-left text-body">
          <thead className="border-b text-label text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5 font-medium">Jogador</th>
              <th className="px-4 py-2.5 font-medium">Enviado</th>
              <th className="px-4 py-2.5 font-medium">Clicou</th>
              <th className="px-4 py-2.5 font-medium">Login ou jogo</th>
              <th className="px-4 py-2.5 font-medium">Depósito</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/70 tabular-nums">
            {rows.map((row, index) => (
              <tr key={`${row.playerId}-${row.sentAt}-${index}`}>
                <td className="px-4 py-2.5">
                  <PlayerName playerId={row.playerId} name={row.playerName} className="block" />
                  <span className="text-meta text-muted-foreground">
                    {maskContact(row.contact)}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">{dateTime(row.sentAt)}</td>
                <td className="px-4 py-2.5 text-muted-foreground">{dateTime(row.clickedAt)}</td>
                <td className="px-4 py-2.5 text-muted-foreground">{dateTime(row.loginAt)}</td>
                <td className="px-4 py-2.5">
                  {row.depositedAt ? (
                    <span className={row.alreadyActive ? "text-muted-foreground" : undefined}>
                      {dateTime(row.depositedAt)} ·{" "}
                      <span
                        className={row.alreadyActive ? undefined : "font-semibold text-success"}
                      >
                        {money(row.depositValue)}
                      </span>
                      {row.alreadyActive ? " · já ativo, não conta" : ""}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
