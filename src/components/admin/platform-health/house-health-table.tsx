// Super-admin "Saúde" tab (Task 4, spec §5.2–5.3): the table of every house,
// sorted red/yellow/green/sem-histórico by Task 3's `sortHouses`. Each cell
// is the current window's value plus a colored delta against the 4-week
// base; the reason line under the house name explains the worst metric.
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatMoney } from "@/lib/currency";
import { HEALTH_THRESHOLDS, type HouseHealthRow } from "@/lib/platform-health/house-health";
import type { PlatformHealth } from "@/lib/platform-health/platform-health.server";
import { cn } from "@/lib/utils";

const LEVEL_DOT: Record<HouseHealthRow["level"], string> = {
  red: "bg-destructive",
  yellow: "bg-warning",
  green: "bg-success",
  no_history: "bg-muted-foreground/50",
};

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("pt-BR");
}

function fmtPct1(n: number): string {
  return `${n.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

function sign(n: number): string {
  return n < 0 ? "−" : "+";
}

function fmtPctDelta(n: number): string {
  return `${sign(n)}${Math.abs(Math.round(n))}%`;
}

function fmtPtsDelta(n: number): string {
  return `${sign(n)}${Math.abs(Math.round(n))} pts`;
}

/** DD/MM from a "YYYY-MM-DD" day string, with no timezone conversion. */
function ddmm(day: string): string {
  const [, m, d] = day.split("-");
  return `${d}/${m}`;
}

function DeltaBadge({
  delta,
  threshold,
  format,
  level,
}: {
  delta: number | null;
  threshold: number;
  format: (n: number) => string;
  level: HouseHealthRow["level"];
}) {
  if (delta === null) {
    return (
      <span className="ml-1.5 text-xs text-muted-foreground">
        {level === "no_history" ? "novo" : "—"}
      </span>
    );
  }
  const tone =
    delta > 0 ? "text-success" : delta <= threshold ? "text-destructive" : "text-muted-foreground";
  return <span className={cn("ml-1.5 text-xs", tone)}>{format(delta)}</span>;
}

function MetricCell({
  value,
  delta,
  threshold,
  format,
  level,
}: {
  value: string;
  delta: number | null;
  threshold: number;
  format: (n: number) => string;
  level: HouseHealthRow["level"];
}) {
  return (
    <TableCell className="whitespace-nowrap text-right">
      {value}
      <DeltaBadge delta={delta} threshold={threshold} format={format} level={level} />
    </TableCell>
  );
}

export function HouseHealthTable({
  houses,
  quietHouses,
  window,
  onOpenHouse,
}: {
  houses: HouseHealthRow[];
  quietHouses: PlatformHealth["quietHouses"];
  window: PlatformHealth["window"];
  onOpenHouse: (tenantId: string) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Casa</TableHead>
              <TableHead className="text-right">Cadastros</TableHead>
              <TableHead className="text-right">FTDs</TableHead>
              <TableHead className="text-right">Conversão</TableHead>
              <TableHead className="text-right">Recuperação CRM</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {houses.map((row) => (
              <TableRow
                key={row.tenantId}
                role="button"
                tabIndex={0}
                aria-label={`Abrir ${row.name}`}
                className="cursor-pointer"
                onClick={() => onOpenHouse(row.tenantId)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onOpenHouse(row.tenantId);
                  }
                }}
              >
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "inline-block size-2.5 shrink-0 rounded-full",
                        LEVEL_DOT[row.level],
                      )}
                      aria-hidden="true"
                    />
                    <div className="min-w-0">
                      <div className="font-medium">{row.name}</div>
                      {row.reason && (
                        <div className="text-xs text-muted-foreground">{row.reason}</div>
                      )}
                    </div>
                  </div>
                </TableCell>
                <MetricCell
                  value={fmtInt(row.current.registrations)}
                  delta={row.deltas.registrationsPct}
                  threshold={HEALTH_THRESHOLDS.yellowPct}
                  format={fmtPctDelta}
                  level={row.level}
                />
                <MetricCell
                  value={fmtInt(row.current.ftds)}
                  delta={row.deltas.ftdsPct}
                  threshold={HEALTH_THRESHOLDS.yellowPct}
                  format={fmtPctDelta}
                  level={row.level}
                />
                <MetricCell
                  value={row.current.conversion === null ? "—" : fmtPct1(row.current.conversion)}
                  delta={row.deltas.conversionPts}
                  threshold={HEALTH_THRESHOLDS.yellowConvPts}
                  format={fmtPtsDelta}
                  level={row.level}
                />
                <MetricCell
                  value={formatMoney(row.current.recovered, row.moeda, { decimals: 0 })}
                  delta={row.deltas.recoveredPct}
                  threshold={HEALTH_THRESHOLDS.yellowPct}
                  format={fmtPctDelta}
                  level={row.level}
                />
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {quietHouses.length > 0 && (
        <p className="text-xs text-muted-foreground">
          + {quietHouses.length} {quietHouses.length === 1 ? "casa" : "casas"} sem movimento (
          {quietHouses.map((h) => h.name).join(", ")})
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Últimos 7 dias até {ddmm(window.to)} contra a média das 4 semanas anteriores. Casas demo
        fora.
      </p>
    </div>
  );
}
