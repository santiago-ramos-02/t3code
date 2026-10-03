import { Minimize2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import { formatContextWindowTokens } from "~/lib/contextWindow";
import {
  formatPromptCacheCountdown,
  formatPromptCacheDuration,
  msUntilPromptCacheLabelChanges,
  type PromptCacheMiss,
  type PromptCacheSnapshot,
  promptCacheLabel,
  promptCacheState,
} from "~/lib/promptCache";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { composerFloatingLayerProps } from "./composerEventScope";

function missCause(miss: PromptCacheMiss) {
  switch (miss.kind) {
    case "expired":
      return `it had expired after ${formatPromptCacheDuration(miss.idleSeconds)} without a request`;
    case "model":
      return "the model changed";
    case "context":
      return "the start of the conversation changed, such as its instructions or tools";
  }
}

/**
 * The composer's prompt cache readout: how long the provider keeps the thread's cache, and on
 * hover what the last turn reused and why it rebuilt the cache when it did. Closed, the label
 * changes at most once a minute; open, the countdown moves every second.
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
  const label = promptCacheLabel(cache, state);
  const canCompact = props.onCompact !== undefined && !props.compactDisabled;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={props.onCompact ? 150 : 0}
        render={
          <Button
            size="compact"
            variant="ghost-muted"
            aria-label={`Prompt cache: ${label.replace(/^Cache /, "")}`}
          />
        }
      >
        <span className="tabular-nums">{label}</span>
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
        <div className="flex flex-col gap-1.5 p-(--floating-content-inset)">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Prompt cache</div>
            <div className="text-secondary-label text-2xs tabular-nums">
              {Math.round(cache.hitRate * 100)}% reused last turn
            </div>
          </div>
          <CacheRow label="Read from cache" tokens={cache.readTokens} />
          {cache.writtenTokens !== null ? (
            <CacheRow label="Written to cache" tokens={cache.writtenTokens} />
          ) : null}
          <CacheRow label="Not cached" tokens={cache.uncachedTokens} />
          <p className="text-pretty text-secondary-label text-2xs">
            {state.kind === "warm" ? (
              "Warm while the agent works."
            ) : state.kind === "expiresIn" ? (
              <>
                Expires in{" "}
                <span className="font-medium tabular-nums">
                  {formatPromptCacheCountdown(state.seconds)}
                </span>{" "}
                unless you send a message.
              </>
            ) : state.kind === "expired" ? (
              `Expired ${formatPromptCacheDuration(state.secondsAgo)} ago.${
                props.contextTokens === null
                  ? ""
                  : ` The next message sends about ${formatContextWindowTokens(props.contextTokens)} tokens without it${canCompact ? "; compacting first sends less." : "."}`
              }`
            ) : (
              "This provider does not say how long it keeps the cache."
            )}
          </p>
          {cache.miss !== null ? (
            <p className="text-pretty text-secondary-label text-2xs">
              The last turn rebuilt the cache: {missCause(cache.miss)}.
            </p>
          ) : null}
          {state.kind === "expired" && props.onCompact ? (
            <Button
              size="xs"
              variant="outline"
              className="mt-1 w-full justify-center"
              disabled={props.compactDisabled}
              onClick={props.onCompact}
            >
              <Minimize2Icon aria-hidden="true" />
              Compact context
            </Button>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function CacheRow(props: { readonly label: string; readonly tokens: number }) {
  return (
    <div className="flex items-center justify-between gap-3 text-2xs leading-4">
      <span className="text-secondary-label">{props.label}</span>
      <span className="font-medium tabular-nums text-secondary-label">
        {formatContextWindowTokens(props.tokens)}
      </span>
    </div>
  );
}
