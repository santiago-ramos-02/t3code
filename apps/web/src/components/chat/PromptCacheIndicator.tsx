import { useEffect, useState } from "react";

import {
  formatPromptCacheCountdown,
  formatPromptCacheDuration,
  msUntilPromptCacheLabelChanges,
  type PromptCacheState,
  type PromptCacheTone,
  promptCacheClockLabel,
  promptCacheLifeLeft,
  promptCacheNextMessage,
  type PromptCacheSnapshot,
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

/**
 * The composer's prompt cache readout, which answers whether the next message reuses the cache:
 * its life draining a small bar and the time left. Hovering opens the countdown and what the next
 * message gets. Closed, the clock changes once a minute until its last five; open, every second.
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
  const life = promptCacheLifeLeft(cache, state);
  const clockLabel = promptCacheClockLabel(state);
  const nextMessage = promptCacheNextMessage(state, props.contextTokens);

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
            aria-label={`Prompt cache ${clockLabel}. ${nextMessage}`}
          />
        }
      >
        {/* An empty bar says nothing, so an expired or unknown cache shows its state dot. */}
        {life === null || life === 0 ? (
          <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", TONE_FILL[tone])} />
        ) : (
          <LifeBar life={life} tone={tone} className="h-1.5 w-6" />
        )}
        <span className="tabular-nums">{clockLabel}</span>
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
        <div className="flex flex-col gap-2.5 p-(--floating-content-inset) text-2xs">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-medium text-muted-foreground text-xs">Prompt cache</span>
            <StateDetail state={state} />
          </div>
          {life !== null && life > 0 ? (
            <div
              role="progressbar"
              aria-label="Cache life left"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(life * 100)}
            >
              <LifeBar life={life} tone={tone} className="h-1 w-full" />
            </div>
          ) : null}
          <div className="flex items-center gap-1.5 font-medium text-foreground text-xs">
            <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", TONE_FILL[tone])} />
            {nextMessage}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function LifeBar(props: {
  readonly life: number;
  readonly tone: PromptCacheTone;
  readonly className: string;
}) {
  return (
    <span
      aria-hidden
      className={cn("block shrink-0 overflow-hidden rounded-full bg-muted", props.className)}
    >
      <span
        className={cn("block h-full rounded-full", TONE_FILL[props.tone])}
        style={{ width: `${Math.round(props.life * 100)}%` }}
      />
    </span>
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
