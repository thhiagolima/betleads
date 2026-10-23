import { Link } from "@tanstack/react-router";
import { ChevronRight, Megaphone } from "lucide-react";

import { HomeCard } from "@/components/home/home-cards";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { brl, num } from "@/lib/format";
import { LEVEL_LABEL } from "@/lib/player-level";
import { cn } from "@/lib/utils";
import type {
  GamificationData,
  GamificationPlayer,
  PaidLevelSlug,
} from "@/lib/gamification.functions";
import {
  lastDepositText,
  NEW_CAMPAIGN_SEARCH,
  PAID_LEVELS,
  levelRange,
} from "@/components/gamification/level-rules";
import { LevelBadge } from "@/components/players/level-badge";
import { LEVEL_TONE } from "@/components/players/player-tones";
import { SituationText } from "@/components/players/situation-text";

const PLAYERS_SEARCH = { id: undefined, focus: undefined };

export type LevelDraft = {
  bronze: string;
  silver: string;
  gold: string;
  diamond: string;
  black: string;
  coolingAfterDays: string;
  sleepingAfterDays: string;
  vipMinLevel: PaidLevelSlug;
};

/* ------------------------------------------------------------------ */
/* 2. Faixa dos níveis                                                 */
/* ------------------------------------------------------------------ */

export function LevelStrip({ data }: { data: GamificationData }) {
  return (
    <section
      aria-label="Jogadores por nível"
      className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0"
    >
      <div className="grid grid-cols-[repeat(6,minmax(140px,1fr))] gap-3">
        {data.levels.map((level) => (
          <HomeCard key={level.slug} className="flex flex-col p-3.5 sm:p-4">
            <h3 className={cn("text-label font-semibold", LEVEL_TONE[level.slug].text)}>
              {level.label}
            </h3>
            <p className="mt-1.5 text-kpi-sm tabular-nums">{num(level.count)}</p>
            <p className="text-meta text-muted-foreground">
              {level.percent}% da base · {levelRange(level.slug, data.settings.thresholds)}
            </p>
            <Link
              to="/players"
              search={PLAYERS_SEARCH}
              className="mt-auto inline-flex min-h-9 items-center gap-0.5 pt-2 text-meta font-medium text-primary hover:underline"
            >
              Ver jogadores
              <ChevronRight className="size-3.5" aria-hidden="true" />
            </Link>
          </HomeCard>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Linha de jogador (VIPs e ranking): 2 linhas, cabe no celular        */
/* ------------------------------------------------------------------ */

export function PlayerLine({
  player,
  position,
  showStatus = true,
}: {
  player: GamificationPlayer;
  position?: number;
  showStatus?: boolean;
}) {
  return (
    <Link
      to="/players/$playerId"
      params={{ playerId: player.id }}
      search={PLAYERS_SEARCH}
      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-foreground/[0.04] sm:px-5"
    >
      {position != null && (
        <span className="w-8 shrink-0 text-meta tabular-nums text-muted-foreground">
          {position}º
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate text-body font-medium">{player.nome}</span>
          <span className="shrink-0 text-body font-semibold tabular-nums">
            {brl(player.total_depositado)}
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-meta text-muted-foreground">
          <LevelBadge level={player.level} className="py-0" />
          {showStatus && (
            <>
              <span aria-hidden="true">·</span>
              <SituationText situation={player.status} />
            </>
          )}
          <span aria-hidden="true">·</span>
          <span>{lastDepositText(player.daysWithoutDeposit)}</span>
        </div>
      </div>
    </Link>
  );
}

/* ------------------------------------------------------------------ */
/* 3. VIPs que pararam                                                 */
/* ------------------------------------------------------------------ */

export function VipStoppedCard({
  data,
  onShowAll,
}: {
  data: GamificationData;
  onShowAll: () => void;
}) {
  const extra = data.totals.stoppedVipCount - data.vipStopped.length;
  return (
    <HomeCard>
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between sm:p-5">
        <div className="min-w-0">
          <h2 className="text-section">VIPs que pararam de depositar</h2>
          <p className="mt-1 text-body text-muted-foreground">
            {num(data.totals.stoppedVipCount)}{" "}
            {data.totals.stoppedVipCount === 1 ? "jogador" : "jogadores"} de{" "}
            {LEVEL_LABEL[data.settings.vipMinLevel]} para cima sem depositar há{" "}
            {data.settings.coolingAfterDays} dias ou mais.
          </p>
        </div>
        {data.totals.stoppedVipCount > 0 && (
          <Button asChild variant="outline" className="h-10 shrink-0 sm:h-9">
            <Link to="/campanhas" search={NEW_CAMPAIGN_SEARCH}>
              <Megaphone className="size-4" aria-hidden="true" />
              Criar campanha
            </Link>
          </Button>
        )}
      </div>
      {data.vipStopped.length === 0 ? (
        <p className="border-t border-border/70 px-4 py-6 text-center text-body text-muted-foreground sm:px-5">
          Nenhum VIP parado pela regra atual.
        </p>
      ) : (
        <div className="divide-y divide-border/70 border-t border-border/70">
          {data.vipStopped.map((player) => (
            <PlayerLine key={player.id} player={player} showStatus={false} />
          ))}
        </div>
      )}
      {extra > 0 && (
        <div className="border-t border-border/70 px-4 py-2 sm:px-5">
          <Button
            variant="ghost"
            className="-mx-2 h-10 px-2 text-body text-primary sm:h-9"
            onClick={onShowAll}
          >
            Ver todos que pararam no ranking
          </Button>
        </div>
      )}
    </HomeCard>
  );
}

/* ------------------------------------------------------------------ */
/* 5. Faixas e regras                                                  */
/* ------------------------------------------------------------------ */

export function LevelRulesCard({
  draft,
  setDraft,
  dirty,
  saving,
  onSave,
}: {
  draft: LevelDraft;
  setDraft: (update: (current: LevelDraft) => LevelDraft) => void;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
}) {
  return (
    <HomeCard className="p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-section">Faixas e regras</h2>
          <p className="mt-1 text-body text-muted-foreground">
            O nível vem do total depositado; a situação, do tempo sem depositar.
          </p>
        </div>
        <Button className="h-9 shrink-0" disabled={!dirty || saving} onClick={onSave}>
          {saving ? "Salvando…" : dirty ? "Salvar" : "Tudo salvo"}
        </Button>
      </div>

      <fieldset className="mt-4 space-y-2">
        <legend className="mb-2 text-label font-medium text-muted-foreground">
          Total depositado para entrar no nível
        </legend>
        {PAID_LEVELS.map((level) => (
          <div key={level} className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-3">
            <Label htmlFor={`threshold-${level}`} className={LEVEL_TONE[level].text}>
              {LEVEL_LABEL[level]}
            </Label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-body text-muted-foreground">
                R$
              </span>
              <Input
                id={`threshold-${level}`}
                type="number"
                inputMode="decimal"
                min={0}
                value={draft[level]}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, [level]: event.target.value }))
                }
                className="h-10 pl-9 tabular-nums"
              />
            </div>
          </div>
        ))}
      </fieldset>

      <fieldset className="mt-5 space-y-2 border-t border-border/70 pt-4">
        <legend className="mb-2 text-label font-medium text-muted-foreground">
          Quando o jogador esfria
        </legend>
        <DaysField
          id="cooling-days"
          label="Esfriando após"
          value={draft.coolingAfterDays}
          onChange={(value) => setDraft((current) => ({ ...current, coolingAfterDays: value }))}
        />
        <DaysField
          id="sleeping-days"
          label="Dormindo após"
          value={draft.sleepingAfterDays}
          onChange={(value) => setDraft((current) => ({ ...current, sleepingAfterDays: value }))}
        />
        <div className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-3">
          <Label htmlFor="vip-min-level">VIP a partir de</Label>
          <Select
            value={draft.vipMinLevel}
            onValueChange={(value) =>
              setDraft((current) => ({ ...current, vipMinLevel: value as PaidLevelSlug }))
            }
          >
            <SelectTrigger id="vip-min-level" className="h-10">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAID_LEVELS.map((level) => (
                <SelectItem key={level} value={level}>
                  {LEVEL_LABEL[level]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </fieldset>

      <div className="mt-5 rounded-xl bg-secondary/60 p-3.5 text-body">
        <h3 className="font-semibold">O que fazer com isso</h3>
        <ul className="mt-2 space-y-1.5 text-muted-foreground">
          <li>
            <strong className="text-foreground">Black VIP e Diamante que pararam:</strong>{" "}
            atendimento pessoal, não disparo em massa.
          </li>
          <li>
            <strong className="text-foreground">Quem subiu de nível:</strong> uma mensagem de
            reconhecimento no dia em que sobe.
          </li>
          <li>
            <strong className="text-foreground">Novato há mais de 7 dias:</strong> cadastrou e nunca
            depositou; oferta de primeiro depósito, não de reativação.
          </li>
        </ul>
      </div>
    </HomeCard>
  );
}

function DaysField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-3">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={1}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-10 pr-32 tabular-nums"
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-meta text-muted-foreground">
          dias sem depositar
        </span>
      </div>
    </div>
  );
}
