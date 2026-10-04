import { Minimize2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import { formatContextWindowTokens } from "~/lib/contextWindow";
import {
  formatPromptCacheCountdown,
  msUntilPromptCacheLabelChanges,
  type PromptCacheSnapshot,
  type PromptCacheState,
  type PromptCacheTone,
  promptCacheAdvice,
  promptCacheClockLabel,
  promptCacheHitTone,
  promptCacheLifeLeft,
  promptCacheLifeTone,
  promptCacheState,
  promptCacheSuggestsCompact,
  promptCacheTone,
} from "~/lib/promptCache";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { composerFloatingLayerProps } from "./composerEventScope";

const TONE_FILL: Record<PromptCacheTone, string> = {
  good: "bg-success",
  warning: "bg-warning",
  critical: "bg-destructive",
};

// The three parts of a turn's prompt, in the order the stacked bar draws them.
const PARTS = [
  { key: "read", label: "Read", fill: "bg-success" },
  { key: "written", label: "Wrote", fill: "bg-warning" },
  { key: "uncached", label: "New", fill: "bg-info" },
] as const;

const percent = (share: number) => `${Math.round(share * 100)}%`;

/**
 * The composer's prompt cache readout: a state dot, how much of the last turn the cache served,
 * and how long it lives on. Hovering opens the full meter: the countdown draining its bar, what
 * to do about it, the last turn's read, written and new tokens, and one row per recent turn.
 * Closed, the clock changes once a minute until its last five; open, it moves every second.
 */
export function PromptCacheIndicator(props: {
  readonly cache: PromptCacheSnapshot;
  /** What the next request sends, which it re-reads in full once the cache has expired. */
  readonly contextTokens: number | null;
  readonly onCompact?: (() => void) | undefined;
  readonly compactDisabled?: boolean | undefined;
}) {
  const { cache } = props;
  const [open, setOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Usage newer than the last tick, as when a turn ends, moves the clock up to it.
  const clock = Math.max(nowMs, cache.lastUsedAt);
  const state = promptCacheState(cache, clock);
  const ticking = open && (state.kind === "expiresIn" || state.kind === "expired");
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [ticking]);
  const labelDelayMs = msUntilPromptCacheLabelChanges(state);
  const labelChangesAt = ticking || labelDelayMs === null ? null : clock + labelDelayMs;
  useEffect(() => {
    if (labelChangesAt === null) return;
    const id = setTimeout(() => setNowMs(Date.now()), Math.max(0, labelChangesAt - Date.now()));
    return () => clearTimeout(id);
  }, [labelChangesAt]);
  const tone = promptCacheTone(cache, state);
  const clockLabel = promptCacheClockLabel(state);
  const advice = promptCacheAdvice(cache, state, props.contextTokens);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={150}
        render={
          <Button
            size="compact"
            variant="ghost-muted"
            aria-label={`Prompt cache ${percent(cache.hitRate)} reused${clockLabel === null ? "" : `, ${clockLabel}`}${advice === null ? "" : `. ${advice}`}`}
          />
        }
      >
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", TONE_FILL[tone])} />
        <span aria-hidden className="h-1.5 w-6 shrink-0 overflow-hidden rounded-full bg-muted">
          <span
            className="block h-full rounded-full bg-success"
            style={{ width: percent(cache.hitRate) }}
          />
        </span>
        <span className="tabular-nums">
          {percent(cache.hitRate)}
          {clockLabel === null ? null : ` · ${clockLabel}`}
        </span>
      </PopoverTrigger>
      <PopoverPopup
        {...composerFloatingLayerProps}
        tooltipStyle
        side="top"
        align="end"
        padding="none"
        width="sm"
        className="text-left whitespace-normal"
      >
        <PromptCacheMeter
          cache={cache}
          state={state}
          tone={tone}
          advice={advice}
          contextTokens={props.contextTokens}
          onCompact={props.onCompact}
          compactDisabled={props.compactDisabled}
        />
      </PopoverPopup>
    </Popover>
  );
}

function PromptCacheMeter(props: {
  readonly cache: PromptCacheSnapshot;
  readonly state: PromptCacheState;
  readonly tone: PromptCacheTone;
  readonly advice: string | null;
  readonly contextTokens: number | null;
  readonly onCompact: (() => void) | undefined;
  readonly compactDisabled: boolean | undefined;
}) {
  const { cache, state, tone } = props;
  const life = promptCacheLifeLeft(cache, state);
  const parts = {
    read: cache.readTokens,
    written: cache.writtenTokens,
    uncached: cache.uncachedTokens,
  };
  const shownParts = PARTS.filter((part) => parts[part.key] !== null);

  return (
    <div className="flex flex-col gap-2.5 p-(--floating-content-inset) text-2xs">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium text-muted-foreground text-xs">Prompt cache</span>
        {state.kind === "expiresIn" ? (
          <span className="font-semibold text-foreground text-sm tabular-nums">
            {formatPromptCacheCountdown(state.seconds)}
          </span>
        ) : null}
      </div>
      {life !== null ? (
        <div
          className="h-1 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label="Cache life left"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(life * 100)}
        >
          <div
            className={cn("h-full rounded-full", TONE_FILL[promptCacheLifeTone(cache, state)])}
            style={{ width: percent(life) }}
          />
        </div>
      ) : null}
      {props.advice !== null ? (
        <div className="flex items-center gap-1.5 font-medium text-foreground text-xs">
          <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", TONE_FILL[tone])} />
          {props.advice}
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <div aria-hidden className="flex h-1.5 gap-0.5 overflow-hidden rounded-full">
          {shownParts.map((part) =>
            (parts[part.key] ?? 0) > 0 ? (
              <span
                key={part.key}
                className={cn("h-full", part.fill)}
                style={{ flexGrow: parts[part.key] ?? 0, flexBasis: 0, minWidth: 2 }}
              />
            ) : null,
          )}
        </div>
        <div className="flex gap-3 text-secondary-label">
          {shownParts.map((part) => (
            <span key={part.key} className="flex items-center gap-1">
              <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", part.fill)} />
              {part.label}
              <span className="text-foreground tabular-nums">
                {formatContextWindowTokens(parts[part.key] ?? 0)}
              </span>
            </span>
          ))}
        </div>
      </div>

      {cache.turns.length > 1 ? <TurnHits cache={cache} /> : null}

      {promptCacheSuggestsCompact(state, props.contextTokens) && props.onCompact ? (
        <Button
          size="xs"
          variant="outline"
          className="w-full justify-center"
          disabled={props.compactDisabled}
          onClick={props.onCompact}
        >
          <Minimize2Icon aria-hidden="true" />
          Compact context
        </Button>
      ) : null}
    </div>
  );
}

/** Each recent turn's hit rate as a bar, so a miss stands out against the turns around it. */
function TurnHits(props: { readonly cache: PromptCacheSnapshot }) {
  const turns = props.cache.turns;
  return (
    <div className="flex items-end justify-between gap-3">
      <span className="text-secondary-label">Last {turns.length} turns</span>
      <div
        role="img"
        aria-label={`Hit rate of the last ${turns.length} turns: ${turns.map((row) => percent(row.hitRate)).join(", ")}`}
        className="flex h-4 items-end gap-0.5"
      >
        {turns.map((row) => (
          <span
            key={row.number}
            className={cn("w-1.5 rounded-sm", TONE_FILL[promptCacheHitTone(row.hitRate)])}
            style={{ height: `${Math.max(12, Math.round(row.hitRate * 100))}%` }}
          />
        ))}
      </div>
    </div>
  );
}
