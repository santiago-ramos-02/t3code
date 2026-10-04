import { useEffect, useState } from "react";

import { formatContextWindowTokens } from "~/lib/contextWindow";
import {
  formatPromptCacheCountdown,
  formatPromptCacheDuration,
  formatPromptCacheShare,
  msUntilPromptCacheLabelChanges,
  type PromptCacheSnapshot,
  type PromptCacheState,
  type PromptCacheTone,
  promptCacheClockLabel,
  promptCacheHitTone,
  promptCacheLifeLeft,
  promptCacheMissReason,
  promptCacheNextMessage,
  promptCacheState,
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
  neutral: "bg-muted-foreground",
};

// The three parts of a turn's prompt, in the order the stacked bar draws them.
const PARTS = [
  { key: "read", label: "Read", fill: "bg-success" },
  { key: "written", label: "Wrote", fill: "bg-warning" },
  { key: "uncached", label: "New", fill: "bg-info" },
] as const;

/**
 * The composer's prompt cache readout: a dot whose colour says whether the next message finds
 * the cache, how much of the last turn the cache served, and the time it has left. Hovering opens
 * what the readout cannot show: the exact countdown, what the next message gets, the last turn's
 * read, written and new tokens, why it rebuilt the cache when it did, and the recent turns.
 * Closed, the clock changes once a minute until its last five; open, every second.
 */
export function PromptCacheIndicator(props: {
  readonly cache: PromptCacheSnapshot;
  /** What the next request sends, which it re-reads in full once the cache has expired. */
  readonly contextTokens: number | null;
}) {
  const { cache } = props;
  const [open, setOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Usage newer than the last tick, as when a turn ends, moves the clock up to it.
  const clock = Math.max(nowMs, cache.lastUsedAt);
  const state = promptCacheState(cache, clock);
  const ticking = open && state.kind !== "working";

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
  const clockLabel = promptCacheClockLabel(cache, state);
  const nextMessage = promptCacheNextMessage(state, props.contextTokens);
  const share = formatPromptCacheShare(cache.hitRate);

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
            aria-label={`Prompt cache: last turn ${share} cached${clockLabel === null ? "" : `, ${clockLabel}`}. ${nextMessage}`}
          />
        }
      >
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", TONE_FILL[tone])} />
        <span className="tabular-nums">
          {share}
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
        <PromptCacheMeter cache={cache} state={state} tone={tone} nextMessage={nextMessage} />
      </PopoverPopup>
    </Popover>
  );
}

function PromptCacheMeter(props: {
  readonly cache: PromptCacheSnapshot;
  readonly state: PromptCacheState;
  readonly tone: PromptCacheTone;
  readonly nextMessage: string;
}) {
  const { cache, state } = props;
  const life = promptCacheLifeLeft(cache, state);
  const parts = {
    read: cache.readTokens,
    written: cache.writtenTokens,
    uncached: cache.uncachedTokens,
  };
  const shownParts = PARTS.filter((part) => parts[part.key] !== null);

  return (
    <div className="flex flex-col gap-2.5 p-(--floating-content-inset) text-2xs text-pretty">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-medium text-muted-foreground text-xs">Prompt cache</span>
          <StateDetail state={state} />
        </div>
        {life !== null && life > 0 ? (
          <div
            className="h-1 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label="Cache life left"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(life * 100)}
          >
            <div
              className={cn("h-full rounded-full", TONE_FILL[props.tone])}
              style={{ width: formatPromptCacheShare(life) }}
            />
          </div>
        ) : null}
        <span className="font-medium text-foreground text-xs">{props.nextMessage}</span>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-secondary-label">Last turn</span>
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
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-secondary-label">
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
        {cache.miss === null ? null : (
          <span className="text-foreground">{promptCacheMissReason(cache.miss)}</span>
        )}
      </div>

      {cache.turns.length > 1 ? <TurnHits cache={cache} /> : null}
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
        aria-label={`Share cached in the last ${turns.length} turns: ${turns.map((row) => formatPromptCacheShare(row.hitRate)).join(", ")}`}
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

/** The popover's clock: the countdown, or how long ago the cache expired or was last used. */
function StateDetail(props: { readonly state: PromptCacheState }) {
  const { state } = props;
  switch (state.kind) {
    case "working":
      return null;
    case "expiresIn":
      return (
        <span className="font-semibold text-foreground text-sm tabular-nums">
          {formatPromptCacheCountdown(state.seconds)}
        </span>
      );
    case "expired":
      return (
        <span className="text-foreground tabular-nums">
          expired {formatPromptCacheDuration(state.secondsAgo)} ago
        </span>
      );
    case "unknown":
      return (
        <span className="text-foreground tabular-nums">
          used {formatPromptCacheDuration(state.idleSeconds)} ago
        </span>
      );
  }
}
