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
  readonly modelDisplayName: string | null;
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
            aria-label={`Prompt cache ${percent(cache.hitRate)} reused${clockLabel === null ? "" : `, ${clockLabel}`}. ${advice}`}
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
        width="md"
        className="text-left whitespace-normal"
      >
        <PromptCacheMeter
          cache={cache}
          state={state}
          tone={tone}
          advice={advice}
          contextTokens={props.contextTokens}
          modelDisplayName={props.modelDisplayName}
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
  readonly advice: string;
  readonly contextTokens: number | null;
  readonly modelDisplayName: string | null;
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
  const total = cache.readTokens + (cache.writtenTokens ?? 0) + cache.uncachedTokens;
  const shownParts = PARTS.filter((part) => parts[part.key] !== null);
  const prompt = [
    props.modelDisplayName,
    props.contextTokens === null
      ? null
      : `prompt ${formatContextWindowTokens(props.contextTokens)} tokens`,
  ].filter((part) => part !== null);

  return (
    <div className="flex flex-col gap-3 p-(--floating-content-inset) text-2xs">
      <div className="flex items-baseline justify-between gap-3">
        <div className="font-medium text-muted-foreground text-xs">Prompt cache</div>
        {cache.ttlSeconds !== null ? (
          <div className="text-secondary-label">
            {cache.ttlSeconds >= 3_600 ? "1 hour" : `${Math.round(cache.ttlSeconds / 60)} minute`}{" "}
            lifetime
          </div>
        ) : null}
      </div>

      {life !== null ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-semibold text-foreground text-lg tabular-nums leading-none">
              {state.kind === "expiresIn"
                ? formatPromptCacheCountdown(state.seconds)
                : state.kind === "working"
                  ? "Warm"
                  : "0:00"}
            </span>
            <span className="text-secondary-label tabular-nums">{percent(life)} left</span>
          </div>
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
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
        </div>
      ) : null}

      <div className="flex flex-col gap-0.5">
        <div className="flex items-start gap-1.5 font-medium text-foreground text-xs">
          <span
            aria-hidden
            className={cn("mt-1 size-1.5 shrink-0 rounded-full", TONE_FILL[tone])}
          />
          <span className="text-pretty">{props.advice}</span>
        </div>
        {prompt.length > 0 ? (
          <div className="ps-3 text-secondary-label">{prompt.join(", ")}</div>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <div aria-hidden className="flex h-2 min-w-0 flex-1 gap-0.5 overflow-hidden rounded-full">
            {total === 0
              ? null
              : shownParts.map((part) =>
                  (parts[part.key] ?? 0) > 0 ? (
                    <span
                      key={part.key}
                      className={cn("h-full first:rounded-s-full last:rounded-e-full", part.fill)}
                      style={{ flexGrow: parts[part.key] ?? 0, flexBasis: 0, minWidth: 2 }}
                    />
                  ) : null,
                )}
          </div>
          <span className="shrink-0 font-medium text-foreground tabular-nums">
            {percent(cache.hitRate)} hit
          </span>
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5">
          {shownParts.map((part) => (
            <span key={part.key} className="flex items-center gap-1 text-secondary-label">
              <span aria-hidden className={cn("size-2 shrink-0 rounded-sm", part.fill)} />
              {part.label}
              <span className="font-medium text-foreground tabular-nums">
                {formatContextWindowTokens(parts[part.key] ?? 0)}
              </span>
            </span>
          ))}
        </div>
      </div>

      {cache.turns.length > 1 ? <TurnTable cache={cache} /> : null}

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

/** One row per recent turn, so a miss stands out against the turns around it. */
function TurnTable(props: { readonly cache: PromptCacheSnapshot }) {
  const writes = props.cache.writtenTokens !== null;
  return (
    <table className="w-full border-separate border-spacing-0 tabular-nums">
      <caption className="sr-only">Prompt cache use per turn</caption>
      <thead>
        <tr className="text-secondary-label">
          <th scope="col" className="pb-1 text-start font-normal">
            Turn
          </th>
          <th scope="col" className="pb-1 text-end font-normal">
            Read
          </th>
          {writes ? (
            <th scope="col" className="pb-1 text-end font-normal">
              Wrote
            </th>
          ) : null}
          <th scope="col" className="pb-1 text-end font-normal">
            New
          </th>
          <th scope="col" className="pb-1 text-end font-normal">
            Hit
          </th>
        </tr>
      </thead>
      <tbody>
        {props.cache.turns.map((row) => (
          <tr key={row.number} className="text-foreground">
            <td className="py-0.5 text-secondary-label">{row.number}</td>
            <td className="py-0.5 text-end">{formatContextWindowTokens(row.readTokens)}</td>
            {writes ? (
              <td className="py-0.5 text-end">
                {formatContextWindowTokens(row.writtenTokens ?? 0)}
              </td>
            ) : null}
            <td className="py-0.5 text-end">{formatContextWindowTokens(row.uncachedTokens)}</td>
            <td className="py-0.5 text-end">
              <span className="inline-flex items-center justify-end gap-1">
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 rounded-full",
                    TONE_FILL[promptCacheHitTone(row.hitRate)],
                  )}
                />
                {percent(row.hitRate)}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
